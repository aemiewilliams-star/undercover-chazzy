import assert from 'node:assert/strict';
import test from 'node:test';
import {
  providerHasStalled,
  reconnectDelayMs,
  YOUTUBE_RECONNECT_BUDGET_MS,
  youtubeLiveChatStart,
  youtubeReconnectDelayMs,
} from './liveChatPolicy';

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

void test('CHZZK count policy retries at 1, 2, 4, 8 and 16 seconds, then stops', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(reconnectDelayMs), [1000, 2000, 4000, 8000, 16000, null]);
});

const OUTAGE_AT = 1_800_000_000_000;

void test('YouTube reconnects back off 1, 2, 4, 8, 16 s and then keep a 30 s cadence', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 40].map((attempt) =>
      youtubeReconnectDelayMs({ attempt, outageStartedAt: OUTAGE_AT, now: OUTAGE_AT, stillLive: false }),
    ),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
  );
});

void test('YouTube reconnect budget is time since the outage began, not a number of tries', () => {
  // 2026-11-14 20:02:01 KST: the sixth try came 36 s into the outage and the
  // count budget ended the source. Inside the time budget it is just another try.
  assert.equal(
    youtubeReconnectDelayMs({ attempt: 5, outageStartedAt: OUTAGE_AT, now: OUTAGE_AT + 36_000, stillLive: false }),
    30000,
  );
  assert.equal(
    youtubeReconnectDelayMs({
      attempt: 50,
      outageStartedAt: OUTAGE_AT,
      now: OUTAGE_AT + YOUTUBE_RECONNECT_BUDGET_MS - 1,
      stillLive: false,
    }),
    30000,
  );
  assert.equal(
    youtubeReconnectDelayMs({
      attempt: 6,
      outageStartedAt: OUTAGE_AT,
      now: OUTAGE_AT + YOUTUBE_RECONNECT_BUDGET_MS,
      stillLive: false,
    }),
    null,
  );
});

void test('a YouTube broadcast that is still live is never given up on', () => {
  assert.equal(
    youtubeReconnectDelayMs({
      attempt: 400,
      outageStartedAt: OUTAGE_AT,
      now: OUTAGE_AT + 4 * 3_600_000,
      stillLive: true,
    }),
    30000,
  );
});

void test('YouTube reconnect policy rejects an invalid attempt', () => {
  for (const attempt of [-1, 1.5, Number.NaN])
    assert.equal(
      youtubeReconnectDelayMs({ attempt, outageStartedAt: OUTAGE_AT, now: OUTAGE_AT, stillLive: true }),
      null,
    );
});

void test('provider liveness uses successful polls, not chat message activity', () => {
  const now = 1_800_000_000_000;
  assert.equal(providerHasStalled(now - 60_000, now - 1_000, now), false);
  assert.equal(providerHasStalled(now - 60_001, now - 1_000, now), true);
  assert.equal(providerHasStalled(null, now - 60_001, now), true);
  assert.equal(providerHasStalled(null, null, now), false);
});
