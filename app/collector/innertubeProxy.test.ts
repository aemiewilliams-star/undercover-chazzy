import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import {
  assertCollectorProxyRequest,
  boundedRequestBody,
  COLLECTOR_PROXY_HEADER,
  COLLECTOR_PROXY_HEADER_VALUE,
  InnertubeProxyRequestError,
  safeYoutubeResponseHeaders,
  youtubeRequestHeaders,
  youtubeUpstreamUrl,
} from './innertubeProxy';
import { POST } from '../youtubei/[...path]/route';
import { GET as getSessionData } from '../sw.js_data/route';

const originalFetch = globalThis.fetch;
const originalEnabled = process.env.COLLECTOR_PROXY_ENABLED;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnabled == null) delete process.env.COLLECTOR_PROXY_ENABLED;
  else process.env.COLLECTOR_PROXY_ENABLED = originalEnabled;
});

function proxyHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    [COLLECTOR_PROXY_HEADER]: COLLECTOR_PROXY_HEADER_VALUE,
    'content-type': 'application/json',
    ...extra,
  });
}

void test('proxy policy pins exact YouTube routes, method and query', () => {
  const target = youtubeUpstreamUrl(
    new URL('https://collector.example/youtubei/v1/player?key=public-key'),
    '/youtubei/v1/player',
    'POST',
  );
  assert.equal(target.toString(), 'https://www.youtube.com/youtubei/v1/player?key=public-key');
  assert.throws(
    () => youtubeUpstreamUrl(new URL('https://collector.example/youtubei/v1/search'), '/youtubei/v1/search', 'POST'),
    (error: unknown) =>
      error instanceof InnertubeProxyRequestError && error.status === 404 && error.code === 'proxy_route_not_allowed',
  );
  assert.throws(
    () => youtubeUpstreamUrl(new URL('https://collector.example/youtubei/v1/player'), '/youtubei/v1/player', 'GET'),
    InnertubeProxyRequestError,
  );
});

void test('proxy request requires the collector marker and caps request bodies', async () => {
  assert.throws(() => assertCollectorProxyRequest(new Headers()), InnertubeProxyRequestError);
  assertCollectorProxyRequest(proxyHeaders());

  const oversized = new Request('https://collector.example/youtubei/v1/player', {
    method: 'POST',
    body: 'x'.repeat(1024 * 1024 + 1),
  });
  await assert.rejects(() => boundedRequestBody(oversized), {
    status: 413,
    code: 'proxy_payload_too_large',
  });
});

void test('upstream headers drop credentials and response headers stay closed', () => {
  const forwarded = youtubeRequestHeaders(
    proxyHeaders({
      authorization: 'Bearer secret',
      cookie: 'session=secret',
      'x-youtube-client-name': '1',
      'x-youtube-client-version': '2.20260901.00.00',
    }),
  );
  assert.equal(forwarded.get('authorization'), null);
  assert.equal(forwarded.get('cookie'), null);
  assert.equal(forwarded.get(COLLECTOR_PROXY_HEADER), null);
  assert.equal(forwarded.get('x-youtube-client-name'), '1');
  assert.equal(forwarded.get('origin'), 'https://www.youtube.com');

  const safe = safeYoutubeResponseHeaders(
    new Headers({
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': 'SID=secret',
      'access-control-allow-origin': '*',
    }),
  );
  assert.equal(safe.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(safe.get('set-cookie'), null);
  assert.equal(safe.get('access-control-allow-origin'), null);
  assert.equal(safe.get('cache-control'), 'private, no-store, max-age=0');
});

void test('route forwards an allowed player request and returns only the provider payload', async () => {
  process.env.COLLECTOR_PROXY_ENABLED = '1';
  let observedUrl = '';
  let observedBody = '';
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    observedUrl = String(input);
    assert.ok(init?.body instanceof ArrayBuffer);
    observedBody = new TextDecoder().decode(init.body);
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    return Promise.resolve(
      new Response('{"playabilityStatus":{"status":"OK"}}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'SID=forbidden' },
      }),
    );
  };

  const response = await POST(
    new NextRequest('https://collector.example/youtubei/v1/player?key=abc', {
      method: 'POST',
      headers: proxyHeaders({ authorization: 'Bearer secret' }),
      body: '{"videoId":"XjeftzkwQkg"}',
    }),
    { params: Promise.resolve({ path: ['v1', 'player'] }) },
  );
  assert.equal(response.status, 200);
  assert.equal(observedUrl, 'https://www.youtube.com/youtubei/v1/player?key=abc');
  assert.equal(observedBody, '{"videoId":"XjeftzkwQkg"}');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /playabilityStatus/);
});

void test('route is fail-closed when disabled or missing the collector marker', async () => {
  delete process.env.COLLECTOR_PROXY_ENABLED;
  const disabled = await POST(
    new NextRequest('https://collector.example/youtubei/v1/player', {
      method: 'POST',
      headers: proxyHeaders(),
      body: '{}',
    }),
    { params: Promise.resolve({ path: ['v1', 'player'] }) },
  );
  assert.equal(disabled.status, 404);

  process.env.COLLECTOR_PROXY_ENABLED = '1';
  const unmarked = await POST(
    new NextRequest('https://collector.example/youtubei/v1/player', { method: 'POST', body: '{}' }),
    { params: Promise.resolve({ path: ['v1', 'player'] }) },
  );
  assert.equal(unmarked.status, 404);
});

void test('session bootstrap route proxies only marked /sw.js_data GET requests', async () => {
  process.env.COLLECTOR_PROXY_ENABLED = '1';
  globalThis.fetch = (input: string | URL | Request) => {
    assert.equal(String(input), 'https://www.youtube.com/sw.js_data');
    return Promise.resolve(
      new Response(")]}'[[0,0,[]]]", { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  const response = await getSessionData(
    new NextRequest('https://collector.example/sw.js_data', { headers: proxyHeaders() }),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^\)\]\}'/);
});
