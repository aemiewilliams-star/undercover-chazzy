import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { collectorDeploymentReadiness } from './deploymentReadiness';
import { immutableCollectorSourceUrl } from './sourceNotice';

const KEYS = [
  'COLLECTOR_ONLY_MODE',
  'COLLECTOR_PUBLIC_ORIGIN',
  'COLLECTOR_PROXY_ENABLED',
  'NEXT_PUBLIC_COLLECTOR_BRIDGE_DEBUG',
  'NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL',
  'NEXT_PUBLIC_SOURCE_CODE_URL',
  'NEXT_PUBLIC_SOURCE_REVISION',
] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

void test('deployment is ready only with same-origin proxy and immutable source revision', () => {
  const revision = '57b4478af4897957c8eb770e4df479345003359a';
  process.env.COLLECTOR_ONLY_MODE = '1';
  process.env.COLLECTOR_PUBLIC_ORIGIN = 'https://collector.example';
  process.env.COLLECTOR_PROXY_ENABLED = '1';
  process.env.NEXT_PUBLIC_COLLECTOR_BRIDGE_DEBUG = '0';
  process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL = 'https://collector.example';
  process.env.NEXT_PUBLIC_SOURCE_REVISION = revision;
  process.env.NEXT_PUBLIC_SOURCE_CODE_URL = `https://github.com/example/undercover-chazzy/tree/${revision}`;

  const readiness = collectorDeploymentReadiness();
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.checks, {
    collectorOnly: true,
    bridgeDebugDisabled: true,
    selfHostedProxy: true,
    immutableSourceNotice: true,
  });
});

void test('deployment fails closed for an external proxy, debug bridge or mutable source URL', () => {
  process.env.COLLECTOR_ONLY_MODE = '1';
  process.env.COLLECTOR_PUBLIC_ORIGIN = 'https://collector.example';
  process.env.COLLECTOR_PROXY_ENABLED = '1';
  process.env.NEXT_PUBLIC_COLLECTOR_BRIDGE_DEBUG = '1';
  process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL = 'https://upstream-proxy.example';
  process.env.NEXT_PUBLIC_SOURCE_REVISION = '57b4478af4897957c8eb770e4df479345003359a';
  process.env.NEXT_PUBLIC_SOURCE_CODE_URL = 'https://github.com/AiOO/chazzy';

  const readiness = collectorDeploymentReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.checks.bridgeDebugDisabled, false);
  assert.equal(readiness.checks.selfHostedProxy, false);
  assert.equal(readiness.checks.immutableSourceNotice, false);
});

void test('source notice rejects credentials, query strings and non-immutable revisions', () => {
  const revision = '57b4478af4897957c8eb770e4df479345003359a';
  assert.equal(
    immutableCollectorSourceUrl(`https://github.com/example/repo/tree/${revision}`, revision)?.toString(),
    `https://github.com/example/repo/tree/${revision}`,
  );
  assert.equal(
    immutableCollectorSourceUrl(`https://user:pass@github.com/example/repo/tree/${revision}`, revision),
    null,
  );
  assert.equal(immutableCollectorSourceUrl(`https://github.com/example/repo/tree/${revision}?raw=1`, revision), null);
  assert.equal(immutableCollectorSourceUrl('https://github.com/example/repo/tree/main', revision), null);
});
