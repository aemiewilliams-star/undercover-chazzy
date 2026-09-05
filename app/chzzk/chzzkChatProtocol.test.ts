import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChzzkCmd,
  chzzkChatItemsFromBody,
  chzzkConnectFrame,
  chzzkPongFrame,
  parseChzzkFrame,
} from './chzzkChatProtocol';

const chat = (overrides: Record<string, unknown> = {}) => ({
  msgTypeCode: 1,
  msgStatusType: 'NORMAL',
  profile: JSON.stringify({ userIdHash: 'a1b2c3d4e5f6', nickname: '닉네임' }),
  extras: JSON.stringify({ chatType: 'STREAMING', emojis: {} }),
  msg: '안녕하세요 {:d_1:} 반가워요',
  msgTime: 1788594530000,
  ...overrides,
});

void test('CONNECT and PONG frames follow the CHZZK shape', () => {
  const connect: unknown = JSON.parse(chzzkConnectFrame('N1abc', 'tok'));
  assert.deepEqual(connect, {
    bdy: { accTkn: 'tok', auth: 'READ', devType: 2001, uid: null },
    cmd: ChzzkCmd.CONNECT,
    tid: 1,
    cid: 'N1abc',
    svcid: 'game',
    ver: '2',
  });
  assert.deepEqual(JSON.parse(chzzkPongFrame()) as unknown, { ver: '2', cmd: ChzzkCmd.PONG });
});

void test('frames parse to cmd and body; garbage is null', () => {
  assert.deepEqual(parseChzzkFrame(JSON.stringify({ cmd: 0, ver: '2' })), { cmd: 0, body: undefined });
  assert.deepEqual(parseChzzkFrame(JSON.stringify({ cmd: 93101, bdy: [] })), { cmd: 93101, body: [] });
  assert.equal(parseChzzkFrame('not json'), null);
  assert.equal(parseChzzkFrame(JSON.stringify({ ver: '2' })), null);
  assert.equal(parseChzzkFrame(new ArrayBuffer(2)), null);
});

void test('chat bodies keep text and text-bearing cheese chats, drop hidden, system and malformed entries', () => {
  const items = chzzkChatItemsFromBody([
    chat(),
    chat({ msgStatusType: 'HIDDEN', msg: '숨김' }),
    chat({ msgTypeCode: 30, msg: '시스템' }),
    chat({ msgTypeCode: 10, extras: JSON.stringify({ donationType: 'CHAT', payAmount: 1000 }), msg: '치즈 응원' }),
    chat({ msgTypeCode: 10, extras: JSON.stringify({ donationType: 'VIDEO' }), msg: '영상 후원' }),
    chat({ profile: 'not json' }),
    chat({ profile: JSON.stringify({ userIdHash: 'bad id!' }) }),
    chat({ msg: 42, msgTime: 'x' }),
    'garbage',
  ]);
  assert.deepEqual(items, [
    { authorOpaqueKey: 'a1b2c3d4e5f6', text: '안녕하세요 [이모지] 반가워요', timestamp: 1788594530000 },
    { authorOpaqueKey: 'a1b2c3d4e5f6', text: '치즈 응원', timestamp: 1788594530000 },
    { authorOpaqueKey: 'a1b2c3d4e5f6', text: '', timestamp: null },
  ]);
  assert.deepEqual(chzzkChatItemsFromBody({ not: 'an array' }), []);
});
