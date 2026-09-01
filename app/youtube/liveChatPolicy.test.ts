import assert from 'node:assert/strict';
import test from 'node:test';
import { providerHasStalled, reconnectDelayMs } from './liveChatPolicy';

void test('reconnect policy retries at 1, 2, 4, 8 and 16 seconds, then stops', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(reconnectDelayMs), [1000, 2000, 4000, 8000, 16000, null]);
});

void test('provider liveness uses successful polls, not chat message activity', () => {
  const now = 1_800_000_000_000;
  assert.equal(providerHasStalled(now - 60_000, now - 1_000, now), false);
  assert.equal(providerHasStalled(now - 60_001, now - 1_000, now), true);
  assert.equal(providerHasStalled(null, now - 60_001, now), true);
  assert.equal(providerHasStalled(null, null, now), false);
});
