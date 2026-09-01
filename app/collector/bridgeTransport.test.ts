import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeDeliveryAccepted } from './bridgeTransport';

void test('Flutter bridge must explicitly return true before a batch is acknowledged', () => {
  assert.equal(bridgeDeliveryAccepted(true), true);
  assert.equal(bridgeDeliveryAccepted(false), false);
  assert.equal(bridgeDeliveryAccepted(null), false);
  assert.equal(bridgeDeliveryAccepted(undefined), false);
  assert.equal(bridgeDeliveryAccepted({ accepted: true }), false);
});
