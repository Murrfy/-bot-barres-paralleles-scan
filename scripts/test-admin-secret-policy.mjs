import assert from 'node:assert/strict';
import test from 'node:test';

const { adminSecretPolicyBlockers } = await import('../api/zenith-sync.js?admin-secret-test=' + Date.now());

test('strong distinct MASTER admin secret passes policy', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode:'Admin-Secret-9f4a7c2e',
    pairingCode:'Controller-Pair-Alpha',
    masterPairingCode:'Master-Pair-Beta',
  }), []);
});

test('short MASTER admin secret is blocked for real execution', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode:'123456',
    pairingCode:'Controller-Pair-Alpha',
    masterPairingCode:'Master-Pair-Beta',
  }), ['MASTER_ADMIN_CODE_TOO_WEAK']);
});

test('reused pairing secret is blocked even when long enough', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode:'Shared-Secret-123456789',
    pairingCode:'Shared-Secret-123456789',
    masterPairingCode:'Different-Master-Pair',
  }), ['MASTER_ADMIN_CODE_REUSED']);
});

test('weak and reused secret reports both blockers', () => {
  assert.deepEqual(adminSecretPolicyBlockers({
    adminCode:'same-short',
    pairingCode:'same-short',
    masterPairingCode:'other',
  }), ['MASTER_ADMIN_CODE_TOO_WEAK','MASTER_ADMIN_CODE_REUSED']);
});
