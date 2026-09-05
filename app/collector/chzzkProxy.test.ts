import assert from 'node:assert/strict';
import test from 'node:test';
import { ChzzkProxyRequestError, chzzkUpstreamUrl, safeChzzkResponseHeaders } from './chzzkProxy';

const id = '0123456789abcdef0123456789abcdef';
const url = (path: string) => new URL(`https://collector.example${path}`);

void test('the three CHZZK endpoints map to their upstream hosts and nothing else passes', () => {
  assert.equal(
    chzzkUpstreamUrl(
      url(`/chzzk-api/service/v1/channels/${id}`),
      `/chzzk-api/service/v1/channels/${id}`,
      'GET',
    ).toString(),
    `https://api.chzzk.naver.com/service/v1/channels/${id}`,
  );
  assert.equal(
    chzzkUpstreamUrl(
      url(`/chzzk-api/polling/v2/channels/${id}/live-status`),
      `/chzzk-api/polling/v2/channels/${id}/live-status`,
      'GET',
    ).toString(),
    `https://api.chzzk.naver.com/polling/v2/channels/${id}/live-status`,
  );
  assert.equal(
    chzzkUpstreamUrl(
      url('/chzzk-api/nng_main/v1/chats/access-token?channelId=N1abc_-&chatType=STREAMING'),
      '/chzzk-api/nng_main/v1/chats/access-token',
      'GET',
    ).toString(),
    'https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=N1abc_-&chatType=STREAMING',
  );
  for (const [path, search, method] of [
    [`/chzzk-api/service/v1/channels/${id}`, '', 'POST'],
    [`/chzzk-api/service/v1/channels/${id}`, '?x=1', 'GET'],
    ['/chzzk-api/service/v1/channels/not-hex', '', 'GET'],
    [`/chzzk-api/service/v1/channels/${id}/extra`, '', 'GET'],
    ['/chzzk-api/nng_main/v1/chats/access-token', '?channelId=N1&chatType=CHAT', 'GET'],
    ['/chzzk-api/nng_main/v1/chats/access-token', '?channelId=bad%20id&chatType=STREAMING', 'GET'],
    ['/chzzk-api/nng_main/v1/chats/access-token', '?channelId=N1', 'GET'],
    ['/chzzk-api/service/v2/channels/' + id, '', 'GET'],
    ['/chzzk-api/../service/v1/channels/' + id, '', 'GET'],
  ] as const) {
    assert.throws(
      () => chzzkUpstreamUrl(url(path + search), path, method),
      ChzzkProxyRequestError,
      `${method} ${path}${search}`,
    );
  }
});

void test('upstream response headers are reduced to a safe JSON subset', () => {
  const headers = safeChzzkResponseHeaders(
    new Headers({ 'content-type': 'application/json;charset=UTF-8', 'set-cookie': 'a=b', 'x-powered-by': 'x' }),
  );
  assert.equal(headers.get('content-type'), 'application/json;charset=UTF-8');
  assert.equal(headers.get('set-cookie'), null);
  assert.equal(headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(safeChzzkResponseHeaders(new Headers({ 'content-type': 'text/html' })).get('content-type'), null);
});

void test('VOD routes: metadata without query, chat page with exactly one non-negative integer offset', () => {
  const base = 'https://collector.example';
  const url = (path: string) => new URL(path, base);
  assert.equal(
    chzzkUpstreamUrl(
      url('/chzzk-api/service/v2/videos/15031050'),
      '/chzzk-api/service/v2/videos/15031050',
      'GET',
    ).toString(),
    'https://api.chzzk.naver.com/service/v2/videos/15031050',
  );
  assert.equal(
    chzzkUpstreamUrl(
      url('/chzzk-api/service/v1/videos/15031050/chats?playerMessageTime=0'),
      '/chzzk-api/service/v1/videos/15031050/chats',
      'GET',
    ).toString(),
    'https://api.chzzk.naver.com/service/v1/videos/15031050/chats?playerMessageTime=0',
  );
  assert.equal(
    chzzkUpstreamUrl(
      url('/chzzk-api/service/v1/videos/15031050/chats?playerMessageTime=7200000'),
      '/chzzk-api/service/v1/videos/15031050/chats',
      'GET',
    ).search,
    '?playerMessageTime=7200000',
  );
  for (const [path, search] of [
    ['/chzzk-api/service/v2/videos/15031050', '?x=1'],
    ['/chzzk-api/service/v2/videos/0123456789012', ''],
    ['/chzzk-api/service/v2/videos/abc', ''],
    ['/chzzk-api/service/v1/videos/15031050/chats', ''],
    ['/chzzk-api/service/v1/videos/15031050/chats', '?playerMessageTime=-1'],
    ['/chzzk-api/service/v1/videos/15031050/chats', '?playerMessageTime=01'],
    ['/chzzk-api/service/v1/videos/15031050/chats', '?playerMessageTime=1.5'],
    ['/chzzk-api/service/v1/videos/15031050/chats', '?playerMessageTime=1000000000'],
    ['/chzzk-api/service/v1/videos/15031050/chats', '?playerMessageTime=0&previousVideoChatSize=50'],
    ['/chzzk-api/service/v1/videos/15031050/chats/extra', '?playerMessageTime=0'],
  ] as const) {
    assert.throws(
      () => chzzkUpstreamUrl(url(path + search), path, 'GET'),
      /proxy_(route_not_allowed|request_invalid)/,
      path + search,
    );
  }
});
