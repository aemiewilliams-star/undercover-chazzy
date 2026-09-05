import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLLECTOR_PROXY_HEADER,
  COLLECTOR_PROXY_HEADER_VALUE,
  CollectorProxyConfigurationError,
  createInnertubeFetch,
  isProviderLivenessRequest,
  resolveCollectorProxyBaseUrl,
  rewriteInnertubeUrl,
} from './innertubeFetch';

void test('proxy rewrite preserves InnerTube path and query but replaces the origin', () => {
  const rewritten = rewriteInnertubeUrl(
    'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=abc',
    new URL('https://collector-proxy.example'),
  );
  assert.equal(rewritten.toString(), 'https://collector-proxy.example/youtubei/v1/live_chat/get_live_chat?key=abc');
});

void test('proxy configuration allows HTTPS and local HTTP only', () => {
  assert.equal(resolveCollectorProxyBaseUrl('https://proxy.example').origin, 'https://proxy.example');
  assert.equal(resolveCollectorProxyBaseUrl('http://localhost:4010').origin, 'http://localhost:4010');
  assert.throws(() => resolveCollectorProxyBaseUrl('http://proxy.example'), CollectorProxyConfigurationError);
  assert.throws(
    () => resolveCollectorProxyBaseUrl('https://user:pass@proxy.example'),
    CollectorProxyConfigurationError,
  );
  assert.throws(() => resolveCollectorProxyBaseUrl('https://proxy.example/base'), CollectorProxyConfigurationError);
  assert.throws(() => resolveCollectorProxyBaseUrl('https://proxy.example:8443'), CollectorProxyConfigurationError);
});

void test('HTTP 503 is reported as a provider failure', async () => {
  const originalFetch = globalThis.fetch;
  const observed = { started: 0, succeeded: 0, failed: 0 };
  let forwardedHeader: string | null = null;
  globalThis.fetch = (input) => {
    assert.ok(input instanceof Request);
    forwardedHeader = input.headers.get(COLLECTOR_PROXY_HEADER);
    return Promise.resolve(new Response('unavailable', { status: 503 }));
  };

  try {
    const collectorFetch = createInnertubeFetch(
      {
        onRequestStarted: () => (observed.started += 1),
        onRequestSucceeded: () => (observed.succeeded += 1),
        onRequestFailed: () => (observed.failed += 1),
      },
      new URL('https://collector-proxy.example'),
    );
    const response = await collectorFetch('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=abc');

    assert.equal(response.status, 503);
    assert.equal(forwardedHeader, COLLECTOR_PROXY_HEADER_VALUE);
    assert.deepEqual(observed, { started: 1, succeeded: 0, failed: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('network exceptions are reported and rethrown', async () => {
  const originalFetch = globalThis.fetch;
  let failureCount = 0;
  globalThis.fetch = () => Promise.reject(new TypeError('simulated network failure'));

  try {
    const collectorFetch = createInnertubeFetch(
      { onRequestFailed: () => (failureCount += 1) },
      new URL('https://collector-proxy.example'),
    );
    await assert.rejects(
      collectorFetch('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat'),
      /simulated network failure/,
    );
    assert.equal(failureCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('only live chat polls decide provider liveness', () => {
  assert.equal(isProviderLivenessRequest('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=abc'), true);
  assert.equal(
    isProviderLivenessRequest(new URL('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay')),
    true,
  );
  assert.equal(isProviderLivenessRequest('https://www.youtube.com/youtubei/v1/updated_metadata'), false);
  assert.equal(isProviderLivenessRequest('https://www.youtube.com/youtubei/v1/player'), false);
  assert.equal(isProviderLivenessRequest(new Request('https://www.youtube.com/youtubei/v1/next')), false);
  assert.equal(isProviderLivenessRequest('not a url'), true);
});

void test('a blocked metadata poll is forwarded but does not touch liveness', async () => {
  const originalFetch = globalThis.fetch;
  const observed = { started: 0, succeeded: 0, failed: 0 };
  globalThis.fetch = (input) => {
    assert.ok(input instanceof Request);
    assert.equal(new URL(input.url).pathname, '/youtubei/v1/updated_metadata');
    return Promise.resolve(new Response('{"code":"proxy_route_not_allowed"}', { status: 404 }));
  };

  try {
    const collectorFetch = createInnertubeFetch(
      {
        onRequestStarted: () => (observed.started += 1),
        onRequestSucceeded: () => (observed.succeeded += 1),
        onRequestFailed: () => (observed.failed += 1),
      },
      new URL('https://collector-proxy.example'),
    );
    const response = await collectorFetch('https://www.youtube.com/youtubei/v1/updated_metadata');

    assert.equal(response.status, 404);
    assert.deepEqual(observed, { started: 0, succeeded: 0, failed: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('a metadata network failure is rethrown without a liveness report', async () => {
  const originalFetch = globalThis.fetch;
  let failureCount = 0;
  globalThis.fetch = () => Promise.reject(new TypeError('simulated network failure'));

  try {
    const collectorFetch = createInnertubeFetch(
      { onRequestFailed: () => (failureCount += 1) },
      new URL('https://collector-proxy.example'),
    );
    await assert.rejects(
      collectorFetch('https://www.youtube.com/youtubei/v1/updated_metadata'),
      /simulated network failure/,
    );
    assert.equal(failureCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
