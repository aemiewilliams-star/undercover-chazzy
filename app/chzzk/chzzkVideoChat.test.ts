import assert from 'node:assert/strict';
import test from 'node:test';
import { chzzkVideoChatNextOffset, chzzkVideoChatPage, CHZZK_VIDEO_NO } from './chzzkVideoChat';

const profile = (userIdHash: string) => JSON.stringify({ userIdHash, nickname: 'synthetic' });

function chat(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    chatChannelId: 'N2insd',
    content: 'synthetic text {:d_1:}',
    extras: JSON.stringify({ chatType: 'STREAMING', emojis: {} }),
    messageStatusType: null,
    messageTime: 1_788_000_000_000,
    messageTypeCode: 1,
    playerMessageTime: 8_170,
    profile: profile('abc123'),
    userIdHash: 'abc123',
    ...overrides,
  };
}

void test('a VOD chat page becomes offset-ordered scheduler items with the same chat rules as live frames', () => {
  const page = chzzkVideoChatPage({
    nextPlayerMessageTime: 315_269,
    previousVideoChats: null,
    videoChats: [
      chat({}),
      chat({ playerMessageTime: 20_000, messageTypeCode: 10, extras: JSON.stringify({ donationType: 'CHAT' }) }),
      chat({ playerMessageTime: 21_000, messageTypeCode: 10, extras: JSON.stringify({ donationType: 'VIDEO' }) }),
      chat({ playerMessageTime: 22_000, messageStatusType: 'HIDDEN' }),
      chat({ playerMessageTime: 23_000, messageTypeCode: 2 }),
      chat({ playerMessageTime: 24_000, profile: 'not json' }),
      chat({ playerMessageTime: -1 }),
      chat({ playerMessageTime: '25000' }),
      'not a record',
    ],
  });
  assert.ok(page);
  assert.deepEqual(
    page.items.map((item) => [item.offsetMs, item.action.authorOpaqueKey, item.action.text, item.action.timestamp]),
    [
      [8_170, 'abc123', 'synthetic text [이모지]', 1_788_000_000_000],
      [20_000, 'abc123', 'synthetic text [이모지]', 1_788_000_000_000],
    ],
  );
  assert.equal(page.nextPlayerMessageTime, 315_269);
});

void test('non-page shapes are rejected and a missing next offset reads as null', () => {
  assert.equal(chzzkVideoChatPage(null), null);
  assert.equal(chzzkVideoChatPage({ videoChats: 'x' }), null);
  assert.equal(chzzkVideoChatPage([]), null);
  const page = chzzkVideoChatPage({ videoChats: [chat({})], nextPlayerMessageTime: null });
  assert.equal(page?.nextPlayerMessageTime, null);
  const bogus = chzzkVideoChatPage({ videoChats: [chat({})], nextPlayerMessageTime: 'soon' });
  assert.equal(bogus?.nextPlayerMessageTime, null);
});

void test('the next offset stops on null, on an empty page and on a cursor that does not advance', () => {
  const full = chzzkVideoChatPage({ videoChats: [chat({})], nextPlayerMessageTime: 315_269 });
  assert.equal(chzzkVideoChatNextOffset(full, 0), 315_269);
  assert.equal(chzzkVideoChatNextOffset(full, 315_269), null);
  assert.equal(chzzkVideoChatNextOffset(full, 400_000), null);
  const last = chzzkVideoChatPage({ videoChats: [chat({})], nextPlayerMessageTime: null });
  assert.equal(chzzkVideoChatNextOffset(last, 0), null);
  const empty = chzzkVideoChatPage({ videoChats: [], nextPlayerMessageTime: 999 });
  assert.equal(chzzkVideoChatNextOffset(empty, 0), null);
});

void test('video numbers are 1–12 digits', () => {
  for (const ok of ['1', '15031050', '123456789012']) assert.ok(CHZZK_VIDEO_NO.test(ok), ok);
  for (const bad of ['', '0123456789012', '15031050x', '-1', '1.5', 'abc'])
    assert.equal(CHZZK_VIDEO_NO.test(bad), false, bad);
});
