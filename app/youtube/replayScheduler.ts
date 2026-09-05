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

export class ReplayScheduler<T = unknown> {
  private readonly startOffset: number;
  private readonly aheadMs: number;
  private clockStartMs: number | null = null;
  private buffer: ReplayScheduledItem<T>[] = [];
  private horizonMs: number;
  private exhaustedPages = false;
  /** Playback position at the last `due()` call — everything at or before it has been released. */
  private lastDuePositionMs: number | null = null;

  constructor(startOffsetMs: number, aheadMs = REPLAY_BUFFER_AHEAD_MS) {
    if (!Number.isInteger(startOffsetMs) || startOffsetMs < 0) throw new RangeError('start_offset_invalid');
    this.startOffset = startOffsetMs;
    this.aheadMs = aheadMs;
    this.horizonMs = startOffsetMs;
  }

  get startOffsetMs(): number {
    return this.startOffset;
  }

  /** The session clock starts when the first page has been fetched, not before. */
  start(nowMs: number): void {
    if (this.clockStartMs == null) this.clockStartMs = nowMs;
  }

  get started(): boolean {
    return this.clockStartMs != null;
  }

  /** Video offset the playback has reached at `nowMs`. */
  positionMs(nowMs: number): number {
    if (this.clockStartMs == null) return this.startOffset;
    return this.startOffset + Math.max(0, nowMs - this.clockStartMs);
  }

  /** Feeds one page. Items before the start offset are dropped; the rest are kept in offset order. */
  push(items: readonly ReplayScheduledItem<T>[]): void {
    for (const item of items) {
      this.horizonMs = Math.max(this.horizonMs, item.offsetMs);
      if (item.offsetMs < this.startOffset) continue;
      this.buffer.push(item);
    }
    this.buffer.sort((a, b) => a.offsetMs - b.offsetMs);
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

  /** True while the buffered horizon is less than `aheadMs` past the playback position. */
  needsMore(nowMs: number): boolean {
    if (this.exhaustedPages) return false;
    return this.horizonMs < this.positionMs(nowMs) + this.aheadMs;
  }

  /** Highest video offset any fetched page has covered so far. */
  get fetchedHorizonMs(): number {
    return this.horizonMs;
  }

  /**
   * Where a reconnect must resume so that nothing is lost (work list W6, same
   * invariant as the CHZZK replay fix): not the clock position — the tick
   * releases up to 250 ms behind it and the last page may not have arrived —
   * but the position the last `due()` actually drained, clamped to the
   * fetched horizon so an unreceived page is never skipped. Items released
   * again after the seek are deduplicated by the caller (message ids).
   */
  resumePositionMs(): number {
    if (this.clockStartMs == null || this.lastDuePositionMs == null) return this.startOffset;
    return Math.min(this.lastDuePositionMs, this.horizonMs);
  }

  /** Releases, in order, every item whose offset the clock has reached. */
  due(nowMs: number): ReplayScheduledItem<T>[] {
    if (this.clockStartMs == null) return [];
    const position = this.positionMs(nowMs);
    this.lastDuePositionMs = position;
    let count = 0;
    while (count < this.buffer.length && this.buffer[count].offsetMs <= position) count += 1;
    return this.buffer.splice(0, count);
  }

  /** Milliseconds until the next buffered item is due; null when nothing is buffered. */
  nextDueInMs(nowMs: number): number | null {
    if (this.clockStartMs == null || this.buffer.length === 0) return null;
    return Math.max(0, this.buffer[0].offsetMs - this.positionMs(nowMs));
  }

  /** Playback is over when no pages remain and everything buffered has been released. */
  finished(): boolean {
    return this.exhaustedPages && this.buffer.length === 0;
  }
}
