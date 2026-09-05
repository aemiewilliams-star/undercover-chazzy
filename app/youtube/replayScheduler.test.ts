import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplayScheduler, replayItemsFromPage, replayPage } from './replayScheduler';

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
  // A later page raises the horizon; resume follows the drained position again.
  scheduler.push([{ offsetMs: 70_000, action: 'd' }]);
  assert.deepEqual(scheduler.due(1_006_000), []);
  assert.equal(scheduler.resumePositionMs(), 66_000);
});
