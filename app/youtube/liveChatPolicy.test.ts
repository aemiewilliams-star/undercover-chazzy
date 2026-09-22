import assert from 'node:assert/strict';
import test from 'node:test';
import { providerHasStalled, reconnectDelayMs, youtubeLiveChatStart } from './liveChatPolicy';

void test('public live chat remains available when video playback needs sign-in', () => {
  assert.equal(
    youtubeLiveChatStart({
      basic_info: {},
      playability_status: { status: 'LOGIN_REQUIRED' },
      livechat: { is_replay: false, continuation: 'public_chat_continuation' },
    }),
    'live',
  );
});

void test('unavailable or incomplete metadata does not declare a broadcast ended', () => {
  for (const info of [
    { basic_info: {} },
    { basic_info: {}, playability_status: { status: 'LOGIN_REQUIRED' } },
    { basic_info: { is_live: false }, playability_status: { status: 'LOGIN_REQUIRED' } },
    { basic_info: { is_live: true }, playability_status: { status: 'OK' } },
    { basic_info: {}, livechat: { is_replay: false, continuation: '' } },
    { basic_info: {}, livechat: { is_replay: false, continuation: ' ' } },
    { basic_info: {}, livechat: { continuation: 'unknown_chat_kind' } },
  ])
    assert.equal(youtubeLiveChatStart(info), 'retry');
});

void test('replay and confirmed non-live video never start live collection', () => {
  assert.equal(
    youtubeLiveChatStart({
      basic_info: { is_live: true },
      livechat: { is_replay: true, continuation: 'replay_continuation' },
    }),
    'ended',
  );
  assert.equal(
    youtubeLiveChatStart({
      basic_info: { is_live: false },
      playability_status: { status: 'OK' },
    }),
    'ended',
  );
});

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
