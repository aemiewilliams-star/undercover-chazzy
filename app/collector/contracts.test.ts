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
