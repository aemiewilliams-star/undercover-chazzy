import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplayScheduler, ReplaySeenIds, replayItemsFromPage, replayPage, replayPageCoverMs } from './replayScheduler';

const chat = (id: string) => ({ type: 'AddChatItemAction', item: { type: 'LiveChatTextMessage', id } });
const replay = (offsetMs: unknown, ...actions: unknown[]) => ({
  type: 'ReplayChatItemAction',
  video_offset_time_msec: offsetMs,
  actions,
});

void test('a replay page unwraps to (offset, action) pairs and ignores everything else', () => {
  const items = replayItemsFromPage([
    replay(1_000, chat('a'), { type: 'MarkChatItemAsDeletedAction' }),
    replay('2500', chat('b')),
    { type: 'AddChatItemAction', item: {} },
    replay(-5, chat('never')),
    null,
  ]);
  assert.deepEqual(
    items.map((item) => [item.offsetMs, (item.action as { item: { id: string } }).item.id]),
    [
      [1_000, 'a'],
      [2_500, 'b'],
    ],
  );
});

void test('replayPage reads actions and the next continuation token', () => {
  assert.equal(replayPage({}), null);
  const page = replayPage({
    continuation_contents: { actions: new Set([replay(1, chat('a'))]), continuation: { token: 'next' } },
  });
  assert.equal(page?.actions.length, 1);
  assert.equal(page?.continuation, 'next');
  assert.equal(replayPage({ continuation_contents: { actions: [] } })?.continuation, null);
});

void test('the scheduler releases items at their offset on the session clock, from the start offset', () => {
  const scheduler = new ReplayScheduler<string>(60_000, 10_000);
  scheduler.push([
    { offsetMs: 30_000, action: 'before-start' },
    { offsetMs: 61_000, action: 'one' },
    { offsetMs: 60_000, action: 'zero' },
    { offsetMs: 65_500, action: 'five' },
  ]);
  assert.deepEqual(scheduler.due(1_000_000), []); // clock not started yet
  scheduler.start(1_000_000);
  assert.deepEqual(
    scheduler.due(1_000_000).map((item) => item.action),
    ['zero'],
  );
  assert.equal(scheduler.nextDueInMs(1_000_000), 1_000);
  assert.deepEqual(
    scheduler.due(1_000_999).map((item) => item.action),
    [],
  );
  assert.deepEqual(
    scheduler.due(1_001_000).map((item) => item.action),
    ['one'],
  );
  assert.deepEqual(
    scheduler.due(1_010_000).map((item) => item.action),
    ['five'],
  );
  assert.equal(scheduler.nextDueInMs(1_010_000), null);
  assert.equal(scheduler.positionMs(1_010_000), 70_000);
});

void test('the scheduler asks for more pages only until the buffer runs ahead of the clock', () => {
  const scheduler = new ReplayScheduler<string>(0, 120_000);
  assert.equal(scheduler.needsMore(0), true);
  scheduler.push([{ offsetMs: 90_000, action: 'a' }]);
  assert.equal(scheduler.needsMore(0), true);
  scheduler.push([{ offsetMs: 130_000, action: 'b' }]);
  assert.equal(scheduler.needsMore(0), false);
  scheduler.start(5_000);
  assert.equal(scheduler.needsMore(20_000), true); // position 15s + 120s > 130s horizon
  scheduler.markExhausted();
  assert.equal(scheduler.needsMore(20_000), false);
  assert.equal(scheduler.finished(), false);
  scheduler.due(200_000);
  assert.equal(scheduler.finished(), true);
});

void test('a negative or fractional start offset is refused', () => {
  assert.throws(() => new ReplayScheduler(-1), RangeError);
  assert.throws(() => new ReplayScheduler(1.5), RangeError);
});

void test('resumePositionMs never skips undelivered or unreceived chat (W6 invariant)', () => {
  const scheduler = new ReplayScheduler<string>(60_000, 10_000);
  // Before the first page: resume at the start offset.
  assert.equal(scheduler.resumePositionMs(), 60_000);
  scheduler.push([
    { offsetMs: 60_100, action: 'a' },
    { offsetMs: 61_000, action: 'b' },
    { offsetMs: 62_000, action: 'c' },
  ]);
  assert.equal(scheduler.fetchedHorizonMs, 62_000);
  scheduler.start(1_000_000);
  // Started but nothing drained yet: still the start offset, not the clock.
  assert.equal(scheduler.resumePositionMs(), 60_000);
  // Clock at 60_500 → 'a' released; resume from the drained position (60_500),
  // not from the clock a moment later.
  assert.deepEqual(
    scheduler.due(1_000_500).map((item) => item.action),
    ['a'],
  );
  assert.equal(scheduler.resumePositionMs(), 60_500);
  // Clock runs past the fetched horizon with the next page not received:
  // resume clamps to the horizon (62_000), so 62_000+ is never skipped.
  assert.deepEqual(
    scheduler.due(1_005_000).map((item) => item.action),
    ['b', 'c'],
  );
  assert.equal(scheduler.positionMs(1_005_000), 65_000);
  assert.equal(scheduler.resumePositionMs(), 62_000);
  // W7 owner decision ③: starved at 65_000 (buffer empty, cover 62_000 behind
  // the position, pages remaining) the position froze there, so a later page
  // that is not yet 20 s ahead keeps the resume position at 65_000 — nothing
  // past it was drained.
  assert.equal(scheduler.paused, true);
  scheduler.push([{ offsetMs: 70_000, action: 'd' }]);
  assert.deepEqual(scheduler.due(1_006_000), []);
  assert.equal(scheduler.positionMs(1_006_000), 65_000);
  assert.equal(scheduler.resumePositionMs(), 65_000);
  // Cover 20 s ahead resumes the clock from 65_000; the drained position follows again.
  scheduler.coverTo(85_000);
  assert.deepEqual(scheduler.due(1_006_500), []);
  assert.equal(scheduler.paused, false);
  assert.deepEqual(
    scheduler.due(1_011_500).map((item) => item.action),
    ['d'],
  );
  assert.equal(scheduler.positionMs(1_011_500), 70_000);
  assert.equal(scheduler.resumePositionMs(), 70_000);
});

void test('ReplaySeenIds evicts only ids before the resume boundary, never the boundary itself (W6 F1)', () => {
  const seen = new ReplaySeenIds(5);
  for (let i = 0; i < 5; i += 1) seen.add(`m${i}`, i * 1_000, 0);
  assert.equal(seen.size, 5);
  // Boundary at 3_000: m0..m2 are evictable, m3/m4 are not.
  seen.add('m5', 5_000, 3_000);
  assert.equal(seen.size, 5);
  assert.equal(seen.has('m0'), false);
  assert.equal(seen.has('m3'), true);
  assert.equal(seen.has('m4'), true);
  assert.equal(seen.has('m5'), true);
  // Everything at or after the boundary: nothing evictable, the set grows past the target.
  seen.add('m6', 6_000, 1_000);
  seen.add('m7', 7_000, 1_000);
  assert.equal(seen.size, 7);
  for (const id of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']) assert.equal(seen.has(id), true, id);
  // Boundary moves on: older ids drain first, in insertion order.
  seen.add('m8', 8_000, 8_000);
  assert.equal(seen.size, 5);
  assert.deepEqual(
    ['m4', 'm5', 'm6', 'm7', 'm8'].map((id) => seen.has(id)),
    [true, true, true, true, true],
  );
  assert.equal(seen.has('m3'), false);
  assert.throws(() => new ReplaySeenIds(0), RangeError);
});

// ---- Work list W7 (design v4): confirmed cover, starvation pause, resume, wait accounting ----

const item = (offsetMs: number, id: string) => ({ offsetMs, action: id });

void test('W7: the cover is time metadata — a raw replay action confirms cover even when nothing survives as chat', () => {
  assert.equal(replayPageCoverMs([replay(120_000, { type: 'MarkChatItemAsDeletedAction' })]), 120_000);
  assert.equal(replayPageCoverMs([]), null);
  assert.equal(replayPageCoverMs([{ type: 'AddChatItemAction', item: {} }]), null);
  const scheduler = new ReplayScheduler<string>(60_000, 10_000, { resumeAheadMs: 20_000 });
  scheduler.coverTo(null); // an actions-empty page with a continuation keeps the previous cover
  assert.equal(scheduler.coveredOffsetMs, 60_000);
  scheduler.coverTo(50_000); // never below the start offset, never backwards
  assert.equal(scheduler.coveredOffsetMs, 60_000);
  scheduler.coverTo(120_000);
  scheduler.coverTo(90_000);
  assert.equal(scheduler.coveredOffsetMs, 120_000);
  assert.equal(scheduler.bufferedCount, 0);
});

void test('W7 ③: starvation pauses the position; cover 20 s ahead resumes it; the pause is accounted', () => {
  const scheduler = new ReplayScheduler<string>(60_000, 10_000, { resumeAheadMs: 20_000 });
  scheduler.push([item(60_100, 'a')]);
  scheduler.start(1_000);
  // Cover 60,100 (only the item). Tick at +200 ms: releases a, then cover 60,100 <= position 60,200 → starved → paused.
  assert.deepEqual(
    scheduler.due(1_200).map((i) => i.action),
    ['a'],
  );
  assert.equal(scheduler.paused, true);
  assert.equal(scheduler.status(1_200).replayState, 'catching_up');
  assert.equal(scheduler.replayWaitCount, 1);
  // Position is frozen while paused; cover may trail the position (60,100 < 60,200 is a valid state).
  assert.equal(scheduler.positionMs(5_200), 60_200);
  assert.equal(scheduler.status(5_200).bufferedAheadMs, 0);
  assert.equal(scheduler.replayWaitMs(5_200), 4_000);
  // A page confirming 15 s ahead is not enough; 20 s ahead resumes.
  scheduler.coverTo(75_000);
  assert.deepEqual(scheduler.due(5_200), []);
  assert.equal(scheduler.paused, true);
  scheduler.push([item(70_000, 'b'), item(80_500, 'c')]);
  assert.deepEqual(scheduler.due(5_400), []); // cover 80,500 - position 60,200 = 20,300 ≥ 20,000 → resumed this tick, b not yet due
  assert.equal(scheduler.paused, false);
  assert.equal(scheduler.status(5_400).replayState, 'playing');
  assert.equal(scheduler.replayWaitMs(5_400), 4_200);
  // The clock continues from the frozen position: 10 s later the position is 70,200 and b is due.
  assert.deepEqual(
    scheduler.due(15_400).map((i) => i.action),
    ['b'],
  );
  assert.equal(scheduler.positionMs(15_400), 70_200);
  assert.equal(scheduler.replayWaitCount, 1);
});

void test('W7: a covered no-chat span is not starvation, and exhaustion ends instead of pausing', () => {
  const scheduler = new ReplayScheduler<string>(0, 10_000, { resumeAheadMs: 20_000 });
  scheduler.push([item(500, 'a')]);
  scheduler.coverTo(30_000); // the provider confirmed 30 s with no further chat
  scheduler.start(0);
  assert.deepEqual(
    scheduler.due(1_000).map((i) => i.action),
    ['a'],
  );
  assert.equal(scheduler.paused, false); // buffer 0 but cover 30,000 > position 1,000
  assert.equal(scheduler.status(1_000).replayState, 'playing');
  assert.equal(scheduler.status(1_000).bufferedAheadMs, 29_000);
  // Cover exhausted at 30 s: with pages remaining it pauses; when the pages are exhausted it ends.
  assert.deepEqual(scheduler.due(31_000), []);
  assert.equal(scheduler.paused, true);
  scheduler.markExhausted();
  assert.deepEqual(scheduler.due(32_000), []);
  assert.equal(scheduler.paused, false);
  assert.equal(scheduler.finished(), true);
  assert.equal(scheduler.status(32_000).replayState, 'ended');
});

void test('W7 F01: a pause that was over before the reconnect is metered but never re-deducted from the new clock', () => {
  const first = new ReplayScheduler<string>(0, 10_000, { resumeAheadMs: 20_000 });
  first.start(0);
  first.due(100); // starved immediately (cover 0 <= position 100)
  assert.equal(first.replayWaitCount, 1);
  first.coverTo(30_000);
  first.push([item(1_000, 'a')]);
  assert.deepEqual(first.due(5_100), []); // resumed: the 5 s pause is over
  assert.equal(first.paused, false);
  const carried = first.carryOver();
  assert.deepEqual(carried, { replayWaitMs: 5_000, replayWaitCount: 1, pausedSinceMs: null });
  const second = new ReplayScheduler<string>(first.resumePositionMs(), 10_000, {
    resumeAheadMs: 20_000,
    carryOver: carried,
  });
  assert.equal(second.status(6_000).replayState, 'prefilling');
  second.push([item(1_000, 'a'), item(2_000, 'b')]);
  second.coverTo(30_000);
  second.start(6_000);
  // One second after the new clock started the position is resume offset (100) + 1 s: the old 5 s wait is not paid again.
  assert.equal(first.resumePositionMs(), 100);
  assert.equal(second.positionMs(7_000), 1_100);
  assert.deepEqual(
    second.due(7_000).map((i) => i.action),
    ['a'],
  );
  assert.equal(second.replayWaitMs(7_000), 5_000);
  assert.equal(second.replayWaitCount, 1);
});

void test('W7 F01: a pause in progress at the reconnect continues through the backoff as one segment and keeps the 20 s rule', () => {
  const first = new ReplayScheduler<string>(0, 10_000, { resumeAheadMs: 20_000 });
  first.start(0);
  first.due(100); // paused since 100
  assert.equal(first.paused, true);
  const carried = first.carryOver(); // the error happens at 3_850 while paused
  assert.deepEqual(carried, { replayWaitMs: 0, replayWaitCount: 1, pausedSinceMs: 100 });
  const second = new ReplayScheduler<string>(first.resumePositionMs(), 10_000, {
    resumeAheadMs: 20_000,
    carryOver: carried,
  });
  // During the backoff (no first page yet) the viewer is still catching up, and the wait keeps growing from the original start.
  assert.equal(second.status(4_850).replayState, 'catching_up');
  assert.equal(second.replayWaitMs(4_850), 4_750);
  assert.equal(second.replayWaitCount, 1);
  // The reconnect's first page brings only 900 ms of cover: still paused, and NOT a new wait segment (count stays 1).
  second.coverTo(900);
  second.start(4_850);
  assert.deepEqual(second.due(4_850), []);
  assert.equal(second.paused, true);
  assert.equal(second.status(4_850).replayState, 'catching_up');
  assert.equal(second.replayWaitCount, 1);
  assert.equal(second.positionMs(6_850), 0); // frozen at the resume offset
  // An empty page later changes nothing; 20 s of cover resumes; only the overlap with the new clock is deducted from it.
  second.coverTo(null);
  assert.deepEqual(second.due(7_850), []);
  assert.equal(second.replayWaitCount, 1);
  second.coverTo(20_000);
  second.push([item(500, 'a')]);
  assert.deepEqual(second.due(8_850), []); // resumed this tick; a (500) is not yet due at position 0
  assert.equal(second.paused, false);
  assert.equal(second.replayWaitMs(8_850), 8_750); // one segment: 100 → 8_850
  assert.deepEqual(
    second.due(9_350).map((i) => i.action),
    ['a'],
  ); // position 500 half a second later
  assert.equal(second.positionMs(9_350), 500);
  // EOF during a restored pause releases it too.
  const third = new ReplayScheduler<string>(0, 10_000, {
    resumeAheadMs: 20_000,
    carryOver: { replayWaitMs: 0, replayWaitCount: 1, pausedSinceMs: 0 },
  });
  third.markExhausted();
  third.start(1_000);
  assert.deepEqual(third.due(1_000), []);
  assert.equal(third.paused, false);
  assert.equal(third.finished(), true);
  const fresh = new ReplayScheduler<string>(0, 10_000);
  assert.deepEqual(fresh.carryOver(), { replayWaitMs: 0, replayWaitCount: 0, pausedSinceMs: null });
});

void test('W7: needsMore follows the confirmed cover, so an actions-empty page keeps the fetch loop going', () => {
  const scheduler = new ReplayScheduler<string>(0, 10_000, { resumeAheadMs: 20_000 });
  scheduler.start(0);
  assert.equal(scheduler.needsMore(0), true);
  scheduler.coverTo(null);
  assert.equal(scheduler.needsMore(0), true);
  scheduler.coverTo(10_000);
  assert.equal(scheduler.needsMore(0), false);
  assert.equal(scheduler.needsMore(500), true);
  assert.equal(scheduler.resumePositionMs(), 0); // cover is not a seek target (W6 clamp uses the fetched horizon)
});
