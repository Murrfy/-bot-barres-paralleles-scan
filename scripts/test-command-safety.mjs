import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

process.env.ZENITH_REAL_TRADING_ENABLED = '0';
process.env.ZENITH_PAIRING_DISABLED = '0';

const source = fs.readFileSync('api/zenith-sync.js', 'utf8')
  .replace(
    /^import \{ deviceTokenCandidates, setDeviceSessionCookie, clearDeviceSessionCookie, sameOriginMutation \} from '\.\.\/lib\/device-session\.mjs';\n/m,
    "const deviceTokenCandidates=()=>[]; const setDeviceSessionCookie=()=>{}; const clearDeviceSessionCookie=()=>{}; const sameOriginMutation=()=>true;\n"
  )
  .replace(
    /^import \{ normalizeProtectiveUpdatePayload, protectionOnlyMismatchTarget, protectiveRepairTarget \} from '\.\.\/lib\/protective-command\.mjs';\n/m,
    "const normalizeProtectiveUpdatePayload=()=>{ throw new Error('NOT_USED_BY_COMMAND_SAFETY_TESTS'); }; const protectionOnlyMismatchTarget=()=>''; const protectiveRepairTarget=()=>'';\n"
  );
const { commandTypeAllowed, commandExpired, executionGate, deferredCommandPayload } = await import(
  'data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { commandTypeAllowed, commandExpired, executionGate, deferredCommandPayload };').toString('base64')
);

test('only audited protective command types are accepted', () => {
  for (const type of [
    'UPDATE_EXIT',
    'UPDATE_PROTECTION',
    'CLOSE_POSITION',
    'CANCEL_ENTRY',
    'EXEC_UPDATE_EXIT',
    'EXEC_UPDATE_PROTECTION',
    'EXEC_CLOSE_POSITION',
    'EXEC_CANCEL_ENTRY',
  ]) assert.equal(commandTypeAllowed(type), true, type);

  for (const type of ['OPEN_POSITION', 'EXEC_OPEN_POSITION', 'BUY', 'EXEC_BUY', 'UNKNOWN']) {
    assert.equal(commandTypeAllowed(type), false, type);
  }
});

test('commands require a bounded explicit expiry', () => {
  const now = 1_000_000;
  assert.equal(commandExpired({ createdAt: now - 1_000, expiresAt: now + 1_000 }, now), false);
  assert.equal(commandExpired({ createdAt: now - 180_000, expiresAt: now + 1_000 }, now), true);
  assert.equal(commandExpired({ createdAt: now - 1_000, expiresAt: now - 1 }, now), true);
  assert.equal(commandExpired({ createdAt: now - 1_000 }, now), true);
});

test('execution gate fails closed while real trading is disabled', () => {
  const gate = executionGate('EXEC_CLOSE_POSITION', false);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'REAL_TRADING_DISABLED');
});

test('temporary execution unavailability defers instead of destroying protective command', () => {
  const command = {
    id:'command-12345678',
    type:'EXEC_CLOSE_POSITION',
    createdAt:1_000_000,
    expiresAt:1_120_000,
    claimedAt:1_010_000,
    claimedBy:'master-1',
    payload:{symbol:'BTCUSDT'},
  };
  const deferred = deferredCommandPayload(command,'USER_STREAM_NOT_READY','master-1',1_020_000,1500);
  assert.equal(deferred.id,command.id);
  assert.equal(deferred.expiresAt,command.expiresAt);
  assert.equal(deferred.claimedAt,undefined);
  assert.equal(deferred.claimedBy,undefined);
  assert.equal(deferred.deferredReason,'USER_STREAM_NOT_READY');
  assert.equal(deferred.notBefore,1_021_500);
  assert.deepEqual(deferred.payload,command.payload);
});

test('defer notBefore never extends beyond original command expiry', () => {
  const deferred = deferredCommandPayload({
    id:'command-12345678',type:'EXEC_CLOSE_POSITION',createdAt:1000,expiresAt:2000
  },'MASTER_RUNTIME_STALE','master-1',1900,1500);
  assert.equal(deferred.notBefore,2000);
});
