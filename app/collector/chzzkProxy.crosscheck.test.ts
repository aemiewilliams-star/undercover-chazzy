import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedChzzkBody, safeChzzkResponseHeaders } from './chzzkProxy';

void test('oversized chunked responses are cancelled before the entire upstream body is consumed', async () => {
  let pulled = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (pulled === 40) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(boundedChzzkBody(response), /CHZZK_RESPONSE_TOO_LARGE/);
  assert.equal(cancelled, true);
  assert.ok(pulled <= 6, `consumed ${pulled} chunks rather than stopping at the 1 MiB boundary`);
});

void test('exactly 1 MiB is accepted and preserved', async () => {
  const input = new Uint8Array(1024 * 1024).fill(42);
  assert.deepEqual(new Uint8Array(await boundedChzzkBody(new Response(input))), input);
});

void test('an excessive declared size cancels the unread response body', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: { 'content-length': String(1024 * 1024 + 1) },
    },
  );
  await assert.rejects(boundedChzzkBody(response), /CHZZK_RESPONSE_TOO_LARGE/);
  assert.equal(cancelled, true);
});

void test('JSON lookalike media types are not forwarded as JSON', () => {
  for (const contentType of ['application/jsonp', 'application/json-malicious', 'application/json+html']) {
    assert.equal(safeChzzkResponseHeaders(new Headers({ 'content-type': contentType })).get('content-type'), null);
  }
});
