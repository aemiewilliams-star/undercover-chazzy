/**
 * Work list W7 (M21): the pause-and-resume policy against a synthetic
 * provider, measured with the design v4 §5 definitions and compared with the
 * control arm (the pre-W7 clock that never pauses). No quantitative tolerance
 * is asserted — the numbers are recorded for the owner's review — but the
 * invariants are: no chat lost or duplicated (each item released exactly
 * once, in offset order), pauses only when starved, resume only at
 * REPLAY_RESUME_AHEAD_MS of confirmed cover or at exhaustion, and a covered
 * no-chat span never pauses. Sustained overload is recorded, never claimed
 * bounded.
 *
 * Supply model: pages of PAGE_SIZE items, one request in flight, RTT per
 * scenario, at most one request per second (the collector's minimum gap),
 * fetched while the cover is under 120 s ahead of the position — the real
 * loop's shape. Chat density is a rate profile over video time.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { REPLAY_BUFFER_AHEAD_MS, REPLAY_RESUME_AHEAD_MS, ReplayScheduler } from './replayScheduler';

const PAGE_SIZE = 200;
const TICK_MS = 250;
const FETCH_MIN_GAP_MS = 1000;

type Profile = { name: string; rate: (videoMs: number) => number; videoLengthMs: number; rttMs: number };

const normal: Profile = { name: 'normal 5/s', rate: () => 5, videoLengthMs: 180_000, rttMs: 1000 };
const shortBurst = (rttMs: number): Profile => ({
  name: `short burst 250/s for 30 s, rtt ${rttMs}`,
  rate: (v) => (v < 30_000 ? 250 : 5),
  videoLengthMs: 180_000,
  rttMs,
});
const sustained: Profile = {
  name: 'sustained 100/s for 5 min, rtt 3000',
  rate: () => 100,
  videoLengthMs: 300_000,
  rttMs: 3000,
};

/** Items of the whole video in offset order, one per 1000/rate ms. */
function chatOf(profile: Profile): { offsetMs: number; id: number }[] {
  const items: { offsetMs: number; id: number }[] = [];
  let t = 0;
  let id = 0;
  while (t < profile.videoLengthMs) {
    items.push({ offsetMs: Math.floor(t), id: id++ });
    t += 1000 / profile.rate(t);
  }
  return items;
}

interface Run {
  arm: 'policy' | 'control';
  profile: string;
  released: number;
  duplicates: number;
  outOfOrder: number;
  firstEmitDelayMs: number | null;
  itemDelayP50: number;
  itemDelayP95: number;
  itemDelayMax: number;
  positionLagMaxMs: number;
  replayWaitMs: number;
  replayWaitCount: number;
  longestPauseMs: number;
  requests: number;
  wallMs: number;
  bufferedCountPeak: number;
  /**
   * Spacing fidelity (what decision ③ buys): |released interval − original
   * interval| between consecutive items, p95 and max. Under the policy the
   * only error is the tick granularity plus one pause boundary per pause;
   * the control arm compresses a whole late page into one tick.
   */
  spacingErrorP95Ms: number;
  spacingErrorMaxMs: number;
  /** Ticks that released more than one second of original chat at once. */
  compressedTicks: number;
}

function simulate(profile: Profile, arm: 'policy' | 'control'): Run {
  const chat = chatOf(profile);
  const scheduler = new ReplayScheduler<number>(0, REPLAY_BUFFER_AHEAD_MS, {
    resumeAheadMs: REPLAY_RESUME_AHEAD_MS,
    pauseOnStarvation: arm === 'policy',
  });
  let now = 0;
  let cursor = 0; // next chat index to serve
  let inFlight: { at: number; items: { offsetMs: number; id: number }[]; last: boolean } | null = null;
  let lastFetchAt = -Infinity;
  let requests = 0;
  const tRequest = 0;
  let tStart: number | null = null;
  let firstEmitAt: number | null = null;
  const seen = new Set<number>();
  let duplicates = 0;
  let outOfOrder = 0;
  let lastOffset = -1;
  const delays: number[] = [];
  const spacingErrors: number[] = [];
  let compressedTicks = 0;
  let previous: { at: number; offsetMs: number } | null = null;
  let positionLagMax = 0;
  let bufferedPeak = 0;
  let pausedSince: number | null = null;
  let longestPause = 0;
  let wasPaused = false;

  const request = () => {
    if (inFlight != null || cursor > chat.length || now - lastFetchAt < FETCH_MIN_GAP_MS) return;
    lastFetchAt = now;
    requests += 1;
    const items = chat.slice(cursor, cursor + PAGE_SIZE);
    cursor += PAGE_SIZE;
    inFlight = { at: now + profile.rttMs, items, last: cursor >= chat.length };
  };

  const deadline = 4 * 60 * 60 * 1000;
  while (now < deadline) {
    if (inFlight != null && now >= inFlight.at) {
      const page = inFlight;
      inFlight = null;
      scheduler.push(page.items.map((entry) => ({ offsetMs: entry.offsetMs, action: entry.id })));
      const cover = page.items.length > 0 ? page.items[page.items.length - 1].offsetMs : null;
      scheduler.coverTo(page.last ? profile.videoLengthMs : cover);
      if (page.last) scheduler.markExhausted();
      if (!scheduler.started) {
        scheduler.start(now);
        tStart = now;
      }
    }
    if (scheduler.needsMore(now)) request();
    if (scheduler.started) {
      const released = scheduler.due(now);
      for (const item of released) {
        if (seen.has(item.action)) duplicates += 1;
        seen.add(item.action);
        if (item.offsetMs < lastOffset) outOfOrder += 1;
        lastOffset = item.offsetMs;
        if (firstEmitAt == null) firstEmitAt = now;
        delays.push(now - (tStart + item.offsetMs));
        if (previous != null) spacingErrors.push(Math.abs(now - previous.at - (item.offsetMs - previous.offsetMs)));
        previous = { at: now, offsetMs: item.offsetMs };
      }
      if (released.length > 1 && released[released.length - 1].offsetMs - released[0].offsetMs > 1000)
        compressedTicks += 1;
      const position = scheduler.positionMs(now);
      positionLagMax = Math.max(positionLagMax, now - tStart - position);
      bufferedPeak = Math.max(bufferedPeak, scheduler.bufferedCount);
      if (scheduler.paused && !wasPaused) pausedSince = now;
      if (!scheduler.paused && wasPaused && pausedSince != null)
        longestPause = Math.max(longestPause, now - pausedSince);
      wasPaused = scheduler.paused;
      if (scheduler.finished()) break;
    }
    now += TICK_MS;
  }
  if (wasPaused && pausedSince != null) longestPause = Math.max(longestPause, now - pausedSince);
  const sorted = [...delays].sort((a, b) => a - b);
  const spacingSorted = [...spacingErrors].sort((a, b) => a - b);
  const spacingPct = (p: number) =>
    spacingSorted.length === 0
      ? 0
      : spacingSorted[Math.min(spacingSorted.length - 1, Math.floor(spacingSorted.length * p))];
  const pct = (p: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    arm,
    profile: profile.name,
    released: seen.size,
    duplicates,
    outOfOrder,
    firstEmitDelayMs: firstEmitAt == null ? null : firstEmitAt - tRequest,
    itemDelayP50: pct(0.5),
    itemDelayP95: pct(0.95),
    itemDelayMax: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    positionLagMaxMs: positionLagMax,
    replayWaitMs: scheduler.replayWaitMs(now),
    replayWaitCount: scheduler.replayWaitCount,
    longestPauseMs: longestPause,
    requests,
    wallMs: now,
    bufferedCountPeak: bufferedPeak,
    spacingErrorP95Ms: spacingPct(0.95),
    spacingErrorMaxMs: spacingSorted.length === 0 ? 0 : spacingSorted[spacingSorted.length - 1],
    compressedTicks,
  };
}

const scenarios: Profile[] = [normal, shortBurst(0), shortBurst(3000), sustained];

for (const profile of scenarios) {
  void test(`W7 M21 scenario — ${profile.name}`, () => {
    const total = chatOf(profile).length;
    const policy = simulate(profile, 'policy');
    const control = simulate(profile, 'control');
    // Recorded for the owner's review (design v4 §5): same scenario, two arms.
    console.log(JSON.stringify({ scenario: profile.name, total, policy, control }));
    for (const run of [policy, control]) {
      assert.equal(run.released, total, `${run.arm}: every item released exactly once`);
      assert.equal(run.duplicates, 0);
      assert.equal(run.outOfOrder, 0);
    }
    // The control arm never pauses; the policy arm pauses only under starvation.
    assert.equal(control.replayWaitCount, 0);
    assert.equal(control.replayWaitMs, 0);
    if (profile === normal) {
      // A page of 200 items at 5/s covers 40 s: supply outruns playback, so no pause.
      assert.equal(policy.replayWaitCount, 0);
    }
    if (profile.name.startsWith('short burst') || profile === sustained) {
      // Under overload the policy pauses; the control arm instead lets items pile up late.
      assert.ok(policy.replayWaitCount >= 1, 'policy paused at least once');
      // With pauses, an item's delay against the T_start schedule is what the
      // owner accepted (position lag); the control arm's delay is the same
      // phenomenon without the pause — it is not claimed smaller.
      assert.ok(policy.positionLagMaxMs >= policy.longestPauseMs);
      // Spacing fidelity: the policy never compresses more than a second of
      // chat into one tick; its per-item spacing error is the tick size except
      // at pause boundaries (at most one outlier per pause).
      assert.equal(policy.compressedTicks, 0, 'policy never bunches late chat');
      assert.ok(policy.spacingErrorP95Ms <= TICK_MS, `policy spacing p95 ${policy.spacingErrorP95Ms} ≤ tick`);
      assert.ok(control.compressedTicks > 0, 'control bunches late chat under overload');
    }
  });
}

void test('W7 M21: a covered no-chat span never pauses (cover ahead, buffer empty)', () => {
  const profile: Profile = {
    name: 'silent 60 s then 5/s',
    rate: (v) => (v < 60_000 ? 0.0001 : 5),
    videoLengthMs: 120_000,
    rttMs: 1000,
  };
  const run = simulate(profile, 'policy');
  assert.equal(run.duplicates, 0);
  // The first page covers the silent span (its last item is at ≥ 60 s), so the clock plays through it.
  assert.equal(run.replayWaitCount, 0);
});
