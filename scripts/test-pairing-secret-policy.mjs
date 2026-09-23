import assert from 'node:assert/strict';
import test from 'node:test';

const { pairingSecretPolicyBlockers } = await import('../api/zenith-sync.js?pairing-secret-test=' + Date.now());

const strongController = 'C'.repeat(20);
const strongMaster = 'M'.repeat(20);
const strongAdmin = 'A'.repeat(20);

test('strong distinct pairing secrets pass real-execution policy', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    pairingCode: strongController,
    masterPairingCode: strongMaster,
    adminCode: strongAdmin,
  }), []);
});

test('short controller and MASTER pairing secrets are blocked', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    pairingCode: '12345678',
    masterPairingCode: '87654321',
    adminCode: strongAdmin,
  }), ['PAIRING_CODE_TOO_WEAK','MASTER_PAIRING_CODE_TOO_WEAK']);
});

test('controller and MASTER pairing secrets must differ', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    pairingCode: strongController,
    masterPairingCode: strongController,
    adminCode: strongAdmin,
  }), ['PAIRING_CODES_MUST_DIFFER']);
});

test('pairing secrets must not reuse MASTER admin secret', () => {
  assert.deepEqual(pairingSecretPolicyBlockers({
    pairingCode: strongAdmin,
    masterPairingCode: strongMaster,
    adminCode: strongAdmin,
  }), ['PAIRING_CODE_REUSES_MASTER_ADMIN']);

  assert.deepEqual(pairingSecretPolicyBlockers({
    pairingCode: strongController,
    masterPairingCode: strongAdmin,
    adminCode: strongAdmin,
  }), ['MASTER_PAIRING_CODE_REUSES_MASTER_ADMIN']);
});
