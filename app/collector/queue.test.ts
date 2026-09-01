import assert from 'node:assert/strict';
import test from 'node:test';
import { CollectorEventQueue } from './queue';

function event(index: number) {
  return {
    occurredAt: index,
    timingSource: 'provider' as const,
    authorOpaqueKey: `author-${index}`,
    normalizedText: `message-${index}`,
    platform: 'youtube' as const,
  };
}

void test('queue assigns monotonic sequences and drops oldest entries at its cap', () => {
  const queue = new CollectorEventQueue(2);
  queue.enqueue(event(1));
  queue.enqueue(event(2));
  queue.enqueue(event(3));

  assert.equal(queue.droppedByCap, 1);
  assert.equal(queue.pendingDepth, 2);
  assert.deepEqual(
    queue.take(10).map(({ eventSequence }) => eventSequence),
    [1, 2],
  );
});

void test('failed batch can be restored without changing event sequences', () => {
  const queue = new CollectorEventQueue(10);
  queue.enqueue(event(1));
  queue.enqueue(event(2));
  const batch = queue.take(10);
  queue.enqueue(event(3));
  queue.restoreToFront(batch);

  assert.deepEqual(
    queue.take(10).map(({ eventSequence }) => eventSequence),
    [0, 1, 2],
  );
});
