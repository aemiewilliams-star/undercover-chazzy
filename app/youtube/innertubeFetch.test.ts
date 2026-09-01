import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CollectorProxyConfigurationError,
  createInnertubeFetch,
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
});

void test('HTTP 503 is reported as a provider failure', async () => {
  const originalFetch = globalThis.fetch;
  const observed = { started: 0, succeeded: 0, failed: 0 };
  globalThis.fetch = () => Promise.resolve(new Response('unavailable', { status: 503 }));

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
