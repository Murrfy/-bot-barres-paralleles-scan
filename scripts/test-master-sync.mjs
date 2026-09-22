import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('api/zenith-sync.js', 'utf8');
const { masterConfigSyncStatus } = await import(
  'data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { masterConfigSyncStatus };').toString('base64')
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
const runtime = (positions = [], orders = []) => ({
  updatedAt: Date.now(),
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
