import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import crypto from 'node:crypto';
const requireHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

const source = fs.readFileSync('api/zenith-sync.js', 'utf8').replace(
  /^import \{ deviceTokenCandidates, setDeviceSessionCookie, clearDeviceSessionCookie, sameOriginMutation \} from '\.\.\/lib\/device-session\.mjs';\n/m,
  "const deviceTokenCandidates=()=>[]; const setDeviceSessionCookie=()=>{}; const clearDeviceSessionCookie=()=>{}; const sameOriginMutation=()=>true;\n"
);
const { masterConfigSyncStatus, stableStringify, reconciliationRuntimeMatches, executionRuntimeReadinessStatus } = await import(
  'data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { masterConfigSyncStatus, stableStringify, reconciliationRuntimeMatches, executionRuntimeReadinessStatus };').toString('base64')
);

const controller = (revision = 3, hash = 'hash-3') => ({
  revision,
  stateHash: hash,
  data: { settings: {}, tokenSettings: {}, manualTokens: {}, validated: {} },
});
const applied = (revision = 3, hash = 'hash-3', masterDeviceId = 'master-1') => ({
  revision,
  stateHash: hash,
  appliedAt: Date.now(),
  masterDeviceId,
});
const runtime = (positions = [], orders = [], masterDeviceId = 'master-1') => ({
  updatedAt: Date.now(),
  masterDeviceId,
  data: { openPositions: positions, openOrders: orders },
});

test('matching applied revision is synchronized', () => {
  const s = masterConfigSyncStatus(controller(), applied(), runtime(), 'master-1');
  assert.equal(s.synchronized, true);
  assert.equal(s.failClosed, false);
  assert.equal(s.reason, 'SYNCED');
});

test('a newer controller revision fails closed until MASTER applies it', () => {
  const s = masterConfigSyncStatus(controller(4, 'hash-4'), applied(3, 'hash-3'), runtime(), 'master-1');
  assert.equal(s.synchronized, false);
  assert.equal(s.applyAllowed, true);
  assert.equal(s.failClosed, true);
  assert.equal(s.reason, 'MASTER_CONFIG_OUT_OF_SYNC');
});

test('full configuration apply is deferred while a position is active', () => {
  const s = masterConfigSyncStatus(
    controller(4, 'hash-4'),
    applied(3, 'hash-3'),
    runtime([{ symbol: 'BTCUSDT' }], []),
    'master-1'
  );
  assert.equal(s.synchronized, false);
  assert.equal(s.applyAllowed, false);
  assert.equal(s.applyDeferred, true);
  assert.equal(s.reason, 'MASTER_CONFIG_APPLY_DEFERRED');
});

test('open orders also defer a full configuration apply', () => {
  const s = masterConfigSyncStatus(
    controller(4, 'hash-4'),
    applied(3, 'hash-3'),
    runtime([], [{ symbol: 'BTCUSDT' }]),
    'master-1'
  );
  assert.equal(s.applyAllowed, false);
  assert.equal(s.applyDeferred, true);
});

test('an acknowledgement from a replaced MASTER is never accepted as synchronized', () => {
  const s = masterConfigSyncStatus(controller(), applied(3, 'hash-3', 'old-master'), runtime(), 'master-1');
  assert.equal(s.synchronized, false);
  assert.equal(s.failClosed, true);
});

test('missing controller state is fail-closed', () => {
  const s = masterConfigSyncStatus(null, null, runtime(), 'master-1');
  assert.equal(s.synchronized, false);
  assert.equal(s.reason, 'NO_CONTROLLER_STATE');
  assert.equal(s.failClosed, true);
});

test('canonical controller hashing ignores object key order', () => {
  const a = { settings: { z: 1, a: 2 }, validated: { BTC: { buy: 3 } } };
  const b = { validated: { BTC: { buy: 3 } }, settings: { a: 2, z: 1 } };
  assert.equal(stableStringify(a), stableStringify(b));
});

test('real-mode synchronization fails closed without a fresh MASTER runtime', () => {
  const missing = masterConfigSyncStatus(controller(), applied(), null, 'master-1', true);
  assert.equal(missing.synchronized, false);
  assert.equal(missing.failClosed, true);
  assert.equal(missing.reason, 'MASTER_RUNTIME_UNAVAILABLE');

  const staleRuntime = runtime();
  staleRuntime.updatedAt = Date.now() - 31000;
  const stale = masterConfigSyncStatus(controller(), applied(), staleRuntime, 'master-1', true);
  assert.equal(stale.synchronized, false);
  assert.equal(stale.reason, 'MASTER_RUNTIME_STALE');
});

test('real-mode synchronization rejects runtime from another MASTER', () => {
  const wrongMaster = masterConfigSyncStatus(controller(), applied(), runtime([], [], 'old-master'), 'master-1', true);
  assert.equal(wrongMaster.synchronized, false);
  assert.equal(wrongMaster.failClosed, true);
  assert.equal(wrongMaster.reason, 'MASTER_RUNTIME_WRONG_DEVICE');
});

test('reconciliation data hash survives heartbeat-only runtime timestamp changes', () => {
  const runtimeA = { version: 2, updatedAt: 1000, masterDeviceId: 'master-1', data: { executionMode:'SIMULATION', binancePositions:[], binanceOrders:[] } };
  const runtimeB = { ...runtimeA, updatedAt: 9000 };
  const runtimeDataHash = sha256ForTest(stableStringify(runtimeA.data));
  assert.equal(reconciliationRuntimeMatches({ runtimeDataHash }, JSON.stringify(runtimeB)), true);
});

test('reconciliation data hash detects actual runtime inventory changes', () => {
  const runtimeA = { version: 2, updatedAt: 1000, data: { executionMode:'SIMULATION', binancePositions:[], binanceOrders:[] } };
  const runtimeB = { version: 2, updatedAt: 2000, data: { executionMode:'SIMULATION', binancePositions:[{symbol:'BTCUSDT'}], binanceOrders:[] } };
  const runtimeDataHash = sha256ForTest(stableStringify(runtimeA.data));
  assert.equal(reconciliationRuntimeMatches({ runtimeDataHash }, JSON.stringify(runtimeB)), false);
});

function sha256ForTest(value) {
  return requireHash(value);
}

test('real execution runtime requires a fresh matching MASTER and ready reconciled user stream', () => {
  const good = {
    updatedAt: Date.now(),
    masterDeviceId: 'master-1',
    data: {
      executionMode: 'REAL',
      userStream: { connected:true, ready:true, failClosed:false, needsReconciliation:false, failReasons:[] },
    },
  };
  assert.equal(executionRuntimeReadinessStatus(good, 'master-1').ready, true);

  for (const [change, reason] of [
    [{ data:{...good.data,executionMode:'SIMULATION'} }, 'MASTER_RUNTIME_NOT_REAL'],
    [{ data:{...good.data,userStream:{...good.data.userStream,connected:false}} }, 'USER_STREAM_DISCONNECTED'],
    [{ data:{...good.data,userStream:{...good.data.userStream,ready:false}} }, 'USER_STREAM_NOT_READY'],
    [{ data:{...good.data,userStream:{...good.data.userStream,failClosed:true}} }, 'USER_STREAM_FAIL_CLOSED'],
    [{ data:{...good.data,userStream:{...good.data.userStream,needsReconciliation:true}} }, 'USER_STREAM_RECONCILIATION_REQUIRED'],
  ]) {
    const candidate={...good,...change};
    assert.equal(executionRuntimeReadinessStatus(candidate,'master-1').reason,reason);
  }
});

test('real execution runtime rejects another MASTER identity and stale runtime', () => {
  const base = {
    updatedAt: Date.now(),
    masterDeviceId:'master-1',
    data:{executionMode:'REAL',userStream:{connected:true,ready:true,failClosed:false,needsReconciliation:false,failReasons:[]}},
  };
  assert.equal(executionRuntimeReadinessStatus(base,'master-2').reason,'MASTER_RUNTIME_WRONG_DEVICE');
  assert.equal(executionRuntimeReadinessStatus({...base,updatedAt:Date.now()-31000},'master-1').reason,'MASTER_RUNTIME_STALE');
});
