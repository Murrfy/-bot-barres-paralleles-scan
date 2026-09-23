import assert from 'node:assert/strict';
import test from 'node:test';

const { adminSecretPolicyBlockers } = await import('../api/zenith-sync.js?admin-secret-test=' + Date.now());

const strongAdmin = 'A'.repeat(20);
const controllerPair = 'B'.repeat(20);
const masterPair = 'C'.repeat(20);

test('strong distinct MASTER admin secret passes policy', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode: strongAdmin,
    pairingCode: controllerPair,
    masterPairingCode: masterPair,
  }), []);
});

test('short MASTER admin secret is blocked for real execution', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode: 'A'.repeat(8),
    pairingCode: controllerPair,
    masterPairingCode: masterPair,
  }), ['MASTER_ADMIN_CODE_TOO_WEAK']);
});

test('reused pairing secret is blocked even when long enough', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode: strongAdmin,
    pairingCode: strongAdmin,
    masterPairingCode: masterPair,
  }), ['MASTER_ADMIN_CODE_REUSED']);
});

test('weak and reused secret reports both blockers', () => {
  const weak = 'D'.repeat(8);
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode: weak,
    pairingCode: weak,
    masterPairingCode: masterPair,
  }), ['MASTER_ADMIN_CODE_TOO_WEAK','MASTER_ADMIN_CODE_REUSED']);
});
