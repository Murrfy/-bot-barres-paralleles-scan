import assert from 'node:assert/strict';
import test from 'node:test';

const { adminSecretPolicyBlockers, pairingSecretPolicyBlockers } = await import('../api/zenith-sync.js?admin-secret-test=' + Date.now());

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


test('strong distinct controller pairing secret passes policy', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'controller',
    pairingCode: controllerPair,
    masterPairingCode: masterPair,
    adminCode: strongAdmin,
  }), []);
});

test('strong distinct MASTER pairing secret passes policy', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'master',
    pairingCode: controllerPair,
    masterPairingCode: masterPair,
    adminCode: strongAdmin,
  }), []);
});

test('short pairing secrets are blocked', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'controller',
    pairingCode: 'short-code',
    masterPairingCode: masterPair,
    adminCode: strongAdmin,
  }), ['PAIRING_CODE_TOO_WEAK']);
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'master',
    pairingCode: controllerPair,
    masterPairingCode: 'short-code',
    adminCode: strongAdmin,
  }), ['MASTER_PAIRING_CODE_TOO_WEAK']);
});

test('controller and MASTER pairing secrets must be distinct', () => {
  const reused='P'.repeat(20);
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'controller',
    pairingCode: reused,
    masterPairingCode: reused,
    adminCode: strongAdmin,
  }), ['PAIRING_CODES_REUSED']);
});

test('pairing secret must not reuse MASTER admin secret', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'controller',
    pairingCode: strongAdmin,
    masterPairingCode: masterPair,
    adminCode: strongAdmin,
  }), ['PAIRING_CODE_REUSES_MASTER_ADMIN_CODE']);
  assert.deepEqual(pairingSecretPolicyBlockers({
    role: 'master',
    pairingCode: controllerPair,
    masterPairingCode: strongAdmin,
    adminCode: strongAdmin,
  }), ['MASTER_PAIRING_CODE_REUSES_MASTER_ADMIN_CODE']);
});
