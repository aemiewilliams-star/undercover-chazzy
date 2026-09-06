/**
 * Recorded playback scheduler (owner decision 2026-09-05).
 *
 * YouTube keeps the chat of an ended live as "replay" pages, each message
 * carrying the video offset it appeared at. youtubei.js' own LiveChat class
 * would drain those pages at its smoothing rate and finish a four-hour
 * broadcast in minutes, so the collector paces them itself: a page is
 * unwrapped into (offset, action) pairs, buffered a couple of minutes ahead,
 * and each action is released when the session clock reaches its offset.
 *
 * Pure and clock-free so it can be tested with numbers; the hook supplies
 * the wall clock, the fetches and the emit callback.
 */

export interface ReplayScheduledItem<T = unknown> {
  offsetMs: number;
  action: T;
}

type LooseNode = {
  type?: unknown;
  actions?: unknown;
  video_offset_time_msec?: unknown;
};

function finiteNonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

/**
 * Unwraps one replay page action: a ReplayChatItemAction carries the video
 * offset and nests the real chat actions. Only AddChatItemAction survives —
 * the live path never sees anything else either.
 */
export function replayItemsFromAction<T = unknown>(
  raw: unknown,
  inheritedOffsetMs: number | null = null,
): ReplayScheduledItem<T>[] {
  if (raw == null || typeof raw !== 'object') return [];
  const node = raw as LooseNode;
  if (node.type === 'ReplayChatItemAction') {
    const ownOffset = finiteNonNegative(node.video_offset_time_msec) ?? inheritedOffsetMs;
    return Array.isArray(node.actions)
      ? node.actions.flatMap((nested) => replayItemsFromAction<T>(nested, ownOffset))
      : [];
  }
  if (node.type !== 'AddChatItemAction' || inheritedOffsetMs == null) return [];
  return [{ offsetMs: inheritedOffsetMs, action: raw as T }];
}

export function replayItemsFromPage<T = unknown>(actions: Iterable<unknown>): ReplayScheduledItem<T>[] {
  const items: ReplayScheduledItem<T>[] = [];
  for (const action of Array.from(actions)) items.push(...replayItemsFromAction<T>(action));
  return items;
}

/** Parses a get_live_chat_replay response into its actions and next continuation. */
export function replayPage(value: unknown): { actions: unknown[]; continuation: string | null } | null {
  const response = value != null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const contents =
    response?.continuation_contents != null && typeof response.continuation_contents === 'object'
      ? (response.continuation_contents as Record<string, unknown>)
      : null;
  if (!contents) return null;
  const actionsValue = contents.actions;
  const actions =
    actionsValue != null && typeof (actionsValue as Iterable<unknown>)[Symbol.iterator] === 'function'
      ? Array.from(actionsValue as Iterable<unknown>)
      : [];
  const continuation =
    contents.continuation != null && typeof contents.continuation === 'object'
      ? (contents.continuation as Record<string, unknown>)
      : null;
  return {
    actions,
    continuation: typeof continuation?.token === 'string' ? continuation.token : null,
  };
}

export const REPLAY_BUFFER_AHEAD_MS = 120_000;
/**
 * Work list W7, owner decision ③ (2026-09-06): when the buffer starves the
 * playback position pauses and resumes once this much confirmed cover lies
 * ahead of it (or the pages are exhausted). A proposal value, tuned on
 * measurements (design v4 §3).
 */
export const REPLAY_RESUME_AHEAD_MS = 20_000;

export type ReplayState = 'prefilling' | 'playing' | 'catching_up' | 'ended' | 'failed';

/** Snapshot the collector reports as `replay_status` (design v4 §4-3). */
export interface ReplayStatusSnapshot {
  replayState: ReplayState;
  positionMs: number;
  coveredOffsetMs: number;
  bufferedAheadMs: number;
  bufferedCount: number;
  replayWaitMs: number;
  replayWaitCount: number;
}

/**
 * Wait accounting carried into the scheduler a reconnect creates (same run,
 * design v4 §3-1). `replayWaitMs` is the metering total of pauses that were
 * already over; a pause still in progress is carried as its wall-clock start
 * so the new scheduler resumes it (counted once, backoff time included) and
 * never re-deducts it from its own clock (impl v1 review F01).
 */
export interface ReplayWaitCarryOver {
  replayWaitMs: number;
  replayWaitCount: number;
  pausedSinceMs: number | null;
}

/**
 * Highest video offset a raw YouTube replay page confirms, read before any
 * filtering: a ReplayChatItemAction carries the offset even when none of its
 * nested actions survive as chat (design v4 §3-2 — cover is time metadata,
 * not an item count). Null when the page carries no offset at all (an
 * actions-empty page with a continuation keeps the previous cover).
 */
export function replayPageCoverMs(actions: Iterable<unknown>): number | null {
  let cover: number | null = null;
  for (const raw of Array.from(actions)) {
    if (raw == null || typeof raw !== 'object') continue;
    const node = raw as LooseNode;
    if (node.type !== 'ReplayChatItemAction') continue;
    const offset = finiteNonNegative(node.video_offset_time_msec);
    if (offset != null && (cover == null || offset > cover)) cover = offset;
  }
  return cover;
}

export class ReplayScheduler<T = unknown> {
  private readonly startOffset: number;
  private readonly aheadMs: number;
  private readonly resumeAheadMs: number;
  /** false = the pre-W7 control behaviour (the clock never pauses); measurement arm only. */
  private readonly pauseOnStarvation: boolean;
  private clockStartMs: number | null = null;
  private buffer: ReplayScheduledItem<T>[] = [];
  private horizonMs: number;
  /** Confirmed cover (design v4 §3-2): monotonic, starts at the start offset, may trail the position. */
  private coverMs: number;
  private exhaustedPages = false;
  /** Playback position at the last `due()` call — everything at or before it has been released. */
  private lastDuePositionMs: number | null = null;
  /** Wall-clock start of the current starvation pause; null while playing. May predate `clockStartMs` when restored. */
  private pausedSinceMs: number | null;
  /** Clock correction: pause time that overlapped THIS scheduler's clock and is over. Never carried. */
  private pausedTotalMs = 0;
  /** Metering only: pauses completed before this scheduler existed (same run), plus the pre-clock part of a restored pause once it ends. */
  private carriedWaitMs: number;
  private waitCount: number;

  constructor(
    startOffsetMs: number,
    aheadMs = REPLAY_BUFFER_AHEAD_MS,
    options: { resumeAheadMs?: number; carryOver?: ReplayWaitCarryOver; pauseOnStarvation?: boolean } = {},
  ) {
    if (!Number.isInteger(startOffsetMs) || startOffsetMs < 0) throw new RangeError('start_offset_invalid');
    this.startOffset = startOffsetMs;
    this.aheadMs = aheadMs;
    this.resumeAheadMs = options.resumeAheadMs ?? REPLAY_RESUME_AHEAD_MS;
    this.pauseOnStarvation = options.pauseOnStarvation ?? true;
    this.horizonMs = startOffsetMs;
    this.coverMs = startOffsetMs;
    this.carriedWaitMs = Math.max(0, Math.floor(options.carryOver?.replayWaitMs ?? 0));
    this.waitCount = Math.max(0, Math.floor(options.carryOver?.replayWaitCount ?? 0));
    const restored = options.carryOver?.pausedSinceMs;
    this.pausedSinceMs = this.pauseOnStarvation && restored != null && Number.isFinite(restored) ? restored : null;
  }

  get startOffsetMs(): number {
    return this.startOffset;
  }

  /** The session clock starts when the first page has been fetched, not before (owner decision ①: immediately). */
  start(nowMs: number): void {
    if (this.clockStartMs == null) this.clockStartMs = nowMs;
  }

  get started(): boolean {
    return this.clockStartMs != null;
  }

  get paused(): boolean {
    return this.pausedSinceMs != null;
  }

  /** Video offset the playback has reached at `nowMs`; frozen while paused (owner decision ③). */
  positionMs(nowMs: number): number {
    if (this.clockStartMs == null) return this.startOffset;
    // Only the part of the current pause that overlaps this clock is deducted; a
    // restored pause that began before the clock deducts from the clock start.
    const current =
      this.pausedSinceMs == null ? 0 : Math.max(0, nowMs - Math.max(this.pausedSinceMs, this.clockStartMs));
    return this.startOffset + Math.max(0, nowMs - this.clockStartMs - this.pausedTotalMs - current);
  }

  /** Feeds one page. Items before the start offset are dropped; the rest are kept in offset order. Items also confirm cover. */
  push(items: readonly ReplayScheduledItem<T>[]): void {
    for (const item of items) {
      this.horizonMs = Math.max(this.horizonMs, item.offsetMs);
      this.coverMs = Math.max(this.coverMs, item.offsetMs);
      if (item.offsetMs < this.startOffset) continue;
      this.buffer.push(item);
    }
    this.buffer.sort((a, b) => a.offsetMs - b.offsetMs);
  }

  /**
   * Confirms that pages have covered the video up to `offsetMs` (provider
   * time metadata read before filtering: CHZZK nextPlayerMessageTime or the
   * last raw entry, YouTube raw replay-action offsets). Never moves backwards
   * and never below the start offset; null (a page without any offset) keeps
   * the previous cover.
   */
  coverTo(offsetMs: number | null): void {
    if (offsetMs == null || !Number.isFinite(offsetMs)) return;
    this.coverMs = Math.max(this.coverMs, Math.floor(offsetMs));
  }

  /** No further pages exist; playback ends once the buffer drains. */
  markExhausted(): void {
    this.exhaustedPages = true;
  }

  get exhausted(): boolean {
    return this.exhaustedPages;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  get coveredOffsetMs(): number {
    return this.coverMs;
  }

  /** True while the confirmed cover is less than `aheadMs` past the playback position. */
  needsMore(nowMs: number): boolean {
    if (this.exhaustedPages) return false;
    return this.coverMs < this.positionMs(nowMs) + this.aheadMs;
  }

  /** Highest video offset any fetched item has reached so far (the W6 resume clamp). */
  get fetchedHorizonMs(): number {
    return this.horizonMs;
  }

  /**
   * Where a reconnect must resume so that nothing is lost (work list W6, same
   * invariant as the CHZZK replay fix): not the clock position — the tick
   * releases up to 250 ms behind it and the last page may not have arrived —
   * but the position the last `due()` actually drained, clamped to the
   * fetched horizon so an unreceived page is never skipped. Items released
   * again after the seek are deduplicated by the caller (message ids). The
   * confirmed cover is not a seek target (design v4 §3-2).
   */
  resumePositionMs(): number {
    if (this.clockStartMs == null || this.lastDuePositionMs == null) return this.startOffset;
    return Math.min(this.lastDuePositionMs, this.horizonMs);
  }

  /**
   * Releases, in order, every item whose offset the clock has reached, then
   * applies owner decision ③: starved (nothing buffered, confirmed cover not
   * past the position, pages not exhausted) → pause the position; paused and
   * recovered (cover at least `resumeAheadMs` ahead, or exhausted) → resume.
   */
  due(nowMs: number): ReplayScheduledItem<T>[] {
    if (this.clockStartMs == null) return [];
    if (this.pausedSinceMs != null) {
      const position = this.positionMs(nowMs);
      if (this.exhaustedPages || this.coverMs - position >= this.resumeAheadMs) {
        // Clock correction is the overlap with this clock; the part of a restored
        // pause that ran before this clock (error + backoff) is metering only.
        this.pausedTotalMs += Math.max(0, nowMs - Math.max(this.pausedSinceMs, this.clockStartMs));
        this.carriedWaitMs += Math.max(0, this.clockStartMs - this.pausedSinceMs);
        this.pausedSinceMs = null;
      } else {
        this.lastDuePositionMs = position;
        return [];
      }
    }
    const position = this.positionMs(nowMs);
    this.lastDuePositionMs = position;
    let count = 0;
    while (count < this.buffer.length && this.buffer[count].offsetMs <= position) count += 1;
    const released = this.buffer.splice(0, count);
    if (this.pauseOnStarvation && this.buffer.length === 0 && this.coverMs <= position && !this.exhaustedPages) {
      this.pausedSinceMs = nowMs;
      this.waitCount += 1;
    }
    return released;
  }

  /** Milliseconds until the next buffered item is due; null when nothing is buffered or while paused. */
  nextDueInMs(nowMs: number): number | null {
    if (this.clockStartMs == null || this.buffer.length === 0 || this.pausedSinceMs != null) return null;
    return Math.max(0, this.buffer[0].offsetMs - this.positionMs(nowMs));
  }

  /** Playback is over when no pages remain and everything buffered has been released. */
  finished(): boolean {
    return this.exhaustedPages && this.buffer.length === 0;
  }

  /** Wall-clock milliseconds of policy pauses so far (design v4 `replayWaitMs`). */
  replayWaitMs(nowMs: number): number {
    return (
      this.carriedWaitMs +
      this.pausedTotalMs +
      (this.pausedSinceMs == null ? 0 : Math.max(0, nowMs - this.pausedSinceMs))
    );
  }

  get replayWaitCount(): number {
    return this.waitCount;
  }

  /**
   * What the scheduler a reconnect creates must inherit: the metering total
   * of pauses already over, the count, and — when a pause is in progress —
   * its original start, so the pause continues through the backoff as one
   * segment and is deducted only from the new clock's own span (F01).
   */
  carryOver(): ReplayWaitCarryOver {
    return {
      replayWaitMs: this.carriedWaitMs + this.pausedTotalMs,
      replayWaitCount: this.waitCount,
      pausedSinceMs: this.pausedSinceMs,
    };
  }

  /** The `replay_status` snapshot (design v4 §4-3); `ended`/`failed` are the hook's to decide. */
  status(nowMs: number): ReplayStatusSnapshot {
    const position = this.positionMs(nowMs);
    // A restored pause shows as catching_up even before the first page of the
    // reconnect: the wait the viewer sees did not stop at the reconnect.
    const state: ReplayState =
      this.clockStartMs == null
        ? this.pausedSinceMs != null
          ? 'catching_up'
          : 'prefilling'
        : this.finished()
          ? 'ended'
          : this.pausedSinceMs != null
            ? 'catching_up'
            : 'playing';
    return {
      replayState: state,
      positionMs: position,
      coveredOffsetMs: this.coverMs,
      bufferedAheadMs: Math.max(0, this.coverMs - position),
      bufferedCount: this.buffer.length,
      replayWaitMs: this.replayWaitMs(nowMs),
      replayWaitCount: this.waitCount,
    };
  }
}

/**
 * Bounded memory of replay message ids already released (W6 review F1).
 * A plain Set that is cleared when full forgets the ids at the resume
 * boundary, and the provider re-returns boundary items on a seek — so a
 * reconnect right after the clear re-emits them. This keeps insertion order
 * (= release order) and, when over the target size, evicts only ids whose
 * offset is *before* the current resume boundary; ids at or after it are
 * kept regardless of size because they are exactly the ones a seek can bring
 * back.
 */
export class ReplaySeenIds {
  private readonly entries = new Map<string, number>();

  constructor(private readonly targetSize: number) {
    if (!Number.isInteger(targetSize) || targetSize < 1) throw new RangeError('target_size_invalid');
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Records a released id. `resumeBoundaryMs` is the scheduler's current
   * resume position: everything before it may be evicted, nothing at or
   * after it is.
   */
  add(id: string, offsetMs: number, resumeBoundaryMs: number): void {
    this.entries.set(id, offsetMs);
    if (this.entries.size <= this.targetSize) return;
    // Insertion order = release order; walk from the oldest.
    const ordered = Array.from(this.entries.entries());
    for (const [seenId, seenOffset] of ordered) {
      if (this.entries.size <= this.targetSize) break;
      if (seenOffset >= resumeBoundaryMs) continue;
      this.entries.delete(seenId);
    }
  }
}
