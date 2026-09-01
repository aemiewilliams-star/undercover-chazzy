import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMessageRuns, normalizeProviderTimestamp, normalizeYoutubeTextMessage } from './normalizer';

void test('normalizer removes direct identifiers without reading author profile fields', () => {
  const normalized = normalizeMessageRuns([
    {
      text: '  연락 test@example.com 010-1234-5678 @viewer https://example.com/a?q=secret  ',
    },
  ]);
  assert.equal(normalized, '연락 [이메일] [전화번호] [멘션] [URL]');
});

void test('normalizer uses a non-identifying placeholder for emoji images', () => {
  assert.equal(
    normalizeMessageRuns([{ emoji: { emoji_id: 'secret-id', image: [{ url: 'https://image' }] } }]),
    '[이모지]',
  );
});

void test('normalizer rejects empty and oversized messages', () => {
  const empty = normalizeYoutubeTextMessage({
    authorOpaqueKey: 'author',
    timestamp: Date.now(),
    runs: [{ text: '   ' }],
    collectorReceivedAt: Date.now(),
  });
  assert.deepEqual(empty, { ok: false, reason: 'text_empty' });

  const oversized = normalizeYoutubeTextMessage({
    authorOpaqueKey: 'author',
    timestamp: Date.now(),
    runs: [{ text: '가'.repeat(501) }],
    collectorReceivedAt: Date.now(),
  });
  assert.deepEqual(oversized, { ok: false, reason: 'text_too_long' });
});

void test('normalizer bounds the opaque author key used for app-side HMAC', () => {
  const base = { timestamp: 1_800_000_000, runs: [{ text: 'hello' }], collectorReceivedAt: 1_800_000_000_000 };
  assert.deepEqual(normalizeYoutubeTextMessage({ ...base, authorOpaqueKey: '../profile' }), {
    ok: false,
    reason: 'author_invalid',
  });
  assert.deepEqual(normalizeYoutubeTextMessage({ ...base, authorOpaqueKey: 'a'.repeat(129) }), {
    ok: false,
    reason: 'author_invalid',
  });
});

void test('provider timestamps normalize seconds, milliseconds and microseconds to epoch milliseconds', () => {
  const receivedAt = 1_800_000_000_000;
  assert.deepEqual(normalizeProviderTimestamp(1_800_000_000, receivedAt), {
    occurredAt: receivedAt,
    timingSource: 'provider',
  });
  assert.deepEqual(normalizeProviderTimestamp(receivedAt, receivedAt), {
    occurredAt: receivedAt,
    timingSource: 'provider',
  });
  assert.deepEqual(normalizeProviderTimestamp(receivedAt * 1000, receivedAt), {
    occurredAt: receivedAt,
    timingSource: 'provider',
  });
});

void test('implausible timestamps fall back to collector receive time', () => {
  const receivedAt = 1_800_000_000_000;
  assert.deepEqual(normalizeProviderTimestamp('not-a-number', receivedAt), {
    occurredAt: receivedAt,
    timingSource: 'collector_received',
  });
});
