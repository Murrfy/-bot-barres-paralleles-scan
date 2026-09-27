import assert from 'node:assert/strict';
import test from 'node:test';

const { adminSecretPolicyBlockers, pairingSecretPolicyBlockers } = await import('../api/zenith-sync.js?admin-secret-test=' + Date.now());

const strongAdmin = 'A'.repeat(20);
const controllerPair = 'B'.repeat(20);

test('strong distinct MASTER admin secret passes policy', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode: strongAdmin,
    pairingCode: controllerPair,
  }), []);
});

test('short MASTER admin secret is blocked for real execution', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode: 'A'.repeat(8),
    pairingCode: controllerPair,
  }), ['MASTER_ADMIN_CODE_TOO_WEAK']);
});

test('reused controller pairing secret is blocked even when long enough', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode: strongAdmin,
    pairingCode: strongAdmin,
  }), ['MASTER_ADMIN_CODE_REUSED']);
});

test('weak and reused admin secret reports both blockers', () => {
  const weak = 'D'.repeat(8);
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode: weak,
    pairingCode: weak,
  }), ['MASTER_ADMIN_CODE_TOO_WEAK','MASTER_ADMIN_CODE_REUSED']);
});

test('strong distinct controller pairing secret passes policy', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'controller',
    pairingCode: controllerPair,
    adminCode: strongAdmin,
  }), []);
});

test('short controller pairing secret is blocked', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'controller',
    pairingCode: 'B'.repeat(8),
    adminCode: strongAdmin,
  }), ['PAIRING_CODE_TOO_WEAK']);
});

test('browser MASTER pairing role is always invalid', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'master',
    pairingCode: controllerPair,
    adminCode: strongAdmin,
  }), ['PAIRING_ROLE_INVALID']);
});

test('controller pairing secret cannot reuse MASTER admin secret', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'controller',
    pairingCode: strongAdmin,
    adminCode: strongAdmin,
  }), ['PAIRING_CODE_REUSES_ADMIN']);
});
