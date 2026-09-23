import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const index=fs.readFileSync('index.html','utf8');

const start=sync.indexOf("if (action === 'master-revoke' && req.method === 'POST')");
const end=sync.indexOf("if (action === 'master-pause' && req.method === 'POST')",start);
assert.ok(start>=0&&end>start,'MASTER revoke block missing');
const block=sync.slice(start,end);

test('MASTER revoke is controller-only and ADMIN protected',()=>{
  assert.ok(block.includes("requireDevice(req, res, ['controller'])"));
  assert.ok(block.includes('verifyMasterAdminCode(req, res, device)'));
});

test('MASTER revoke fails closed and checks live Binance before invalidating MASTER',()=>{
  assert.ok(block.includes("redis(['SET', KEY_EMERGENCY_STOP, '1'])"));
  assert.ok(block.includes("setMasterMode('PAUSE_PENDING')"));
  assert.ok(block.includes('fetchLiveBinanceActivity()'));
  assert.ok(block.includes("'BINANCE_ACTIVITY_CHECK_FAILED'"));
  assert.ok(block.includes("'MASTER_REVOKE_DRAIN_REQUIRED'"));
  assert.ok(block.includes('liveActivity.activePositions > 0 || liveActivity.openOrders > 0'));
  assert.ok(block.indexOf('fetchLiveBinanceActivity()') < block.indexOf("const revokeScript = ["));
  assert.ok(block.indexOf("'MASTER_REVOKE_DRAIN_REQUIRED'") < block.indexOf("const revokeScript = ["));
});

test('MASTER revoke direct Binance check covers positions, standard orders and algo orders',()=>{
  assert.ok(sync.includes("signedFuturesGet('/fapi/v3/positionRisk'"));
  assert.ok(sync.includes("signedFuturesGet('/fapi/v1/openOrders'"));
  assert.ok(sync.includes("signedFuturesGet('/fapi/v1/openAlgoOrders'"));
  assert.ok(sync.includes("algoType: 'CONDITIONAL'"));
});

test('MASTER revoke destroys real execution authority and stale MASTER state atomically',()=>{
  for(const required of [
    'KEY_REAL_EXECUTION_ARMED',
    'KEY_MASTER',
    'KEY_MASTER_HEARTBEAT',
    'KEY_MASTER_CONFIG_ACK',
    'KEY_RECONCILE_LAST',
    'KEY_STATE',
    'KEY_USER_STREAM_SESSION',
    'KEY_PENDING',
    'KEY_PROCESSING',
    "roleAssignmentKey(PREFIX, 'master')",
    'KEY_MASTER_DEVICE',
    "'MASTER_REVOKED'",
  ]) assert.ok(block.includes(required),required);
});

test('iPhone controller exposes explicit confirmed MASTER revoke control',()=>{
  assert.ok(index.includes('id="masterRevokeBtn"'));
  assert.ok(index.includes('async function controllerRevokeMaster()'));
  assert.ok(index.includes("action=master-revoke"));
  assert.ok(index.includes("confirm('Révoquer le MASTER ?"));
  assert.ok(index.includes("await requestAdminCode('Code ADMIN MASTER pour révoquer le MASTER :')"));
  assert.ok(index.includes('id="adminCodeInput" type="password"'));
  assert.ok(index.includes("$('masterRevokeBtn').onclick=controllerRevokeMaster"));
});
