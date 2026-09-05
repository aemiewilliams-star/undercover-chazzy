import assert from 'node:assert/strict';
import test from 'node:test';
import { isCollectorRuntimeConfig } from './contracts';

void test('collector runtime config accepts only bounded base64url-like identifiers', () => {
  assert.equal(
    isCollectorRuntimeConfig({
      bridgeToken: '0123456789abcdef',
      collectorRunId: 'run_12345678',
    }),
    true,
  );
  assert.equal(isCollectorRuntimeConfig({ bridgeToken: 'short', collectorRunId: 'run_12345678' }), false);
  assert.equal(isCollectorRuntimeConfig({ bridgeToken: '0123456789abcde!', collectorRunId: 'run_12345678' }), false);
  assert.equal(isCollectorRuntimeConfig({ bridgeToken: '0123456789abcdef', collectorRunId: 'contains space' }), false);
  assert.equal(isCollectorRuntimeConfig({}), false);
  assert.equal(isCollectorRuntimeConfig(null), false);
});

void test('runtime config accepts an optional recorded playback and refuses malformed ones', () => {
  const base = { bridgeToken: 'token_0123456789abcdef', collectorRunId: 'run_00000001' };
  assert.equal(isCollectorRuntimeConfig(base), true);
  assert.equal(isCollectorRuntimeConfig({ ...base, playback: { kind: 'recorded', startOffsetMs: 0 } }), true);
  assert.equal(isCollectorRuntimeConfig({ ...base, playback: { kind: 'recorded', startOffsetMs: 3_600_000 } }), true);
  assert.equal(isCollectorRuntimeConfig({ ...base, playback: { kind: 'live', startOffsetMs: 0 } }), false);
  assert.equal(isCollectorRuntimeConfig({ ...base, playback: { kind: 'recorded', startOffsetMs: -1 } }), false);
  assert.equal(isCollectorRuntimeConfig({ ...base, playback: { kind: 'recorded', startOffsetMs: 1.5 } }), false);
  assert.equal(isCollectorRuntimeConfig({ ...base, playback: { kind: 'recorded', startOffsetMs: 86_400_001 } }), false);
  assert.equal(isCollectorRuntimeConfig({ ...base, playback: null }), false);
});
