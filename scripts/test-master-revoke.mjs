import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { deviceRoleAssignmentActive } from '../lib/device-session.mjs';

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
  assert.ok(block.includes('await assertEmergencyStop()'));
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


test('MASTER revoke requires the normal pause drain before destructive revocation',()=>{
  assert.ok(block.includes("const pauseTransition = await tryFinalizePendingPause(registeredMaster, 'PAUSE_PENDING')"));
  assert.ok(block.includes("pauseTransition.masterMode !== 'PAUSED'"));
  assert.ok(block.includes("'PENDING_COMMAND'"));
  assert.ok(block.includes("'PROCESSING_COMMAND'"));
  assert.ok(block.includes('freshCleanReconciliation()'));
  assert.ok(block.indexOf("tryFinalizePendingPause(registeredMaster, 'PAUSE_PENDING')") < block.indexOf('fetchLiveBinanceActivity()'));
});

test('MASTER revoke atomically refuses new queue activity and advances the MASTER role epoch',()=>{
  assert.ok(block.includes("redis.call('LLEN', KEYS[13]) > 0"));
  assert.ok(block.includes("redis.call('LLEN', KEYS[14]) > 0"));
  assert.ok(block.includes("redis.call('SET', KEYS[15], ARGV[2])"));
  assert.equal(block.includes("redis.call('DEL', KEYS[15])"),false);
  assert.equal(block.includes("redis.call('DEL', KEYS[13])"),false);
  assert.equal(block.includes("redis.call('DEL', KEYS[14])"),false);
});

test('MASTER role epoch invalidates sessions issued before revoke',()=>{
  assert.equal(deviceRoleAssignmentActive({createdAt:1000},1001),false);
  assert.equal(deviceRoleAssignmentActive({createdAt:1001},1001),true);
  assert.ok(block.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(block.includes('masterRoleEpochAdvancedAt: revokedAt'));
});

test('PANIC and lease invalidation remain fail-closed after MASTER revoke',()=>{
  assert.ok(block.includes("redis.call('SET', KEYS[2], '1')"));
  assert.ok(block.includes("redis.call('DEL', KEYS[5])"));
  assert.ok(block.includes('masterActivationKey(registeredMaster)'));
  assert.ok(block.includes("redis.call('DEL', KEYS[11])"));
  assert.ok(block.includes('emergencyStopActive: true'));
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


test('MASTER revoke refuses definitive revocation while a user-stream mutation is in flight',()=>{
  assert.ok(block.includes("redis.call('GET', KEYS[16])"));
  assert.ok(block.includes("'EVAL', revokeScript, '21'"));
  assert.ok(block.includes('KEY_USER_STREAM_MUTATION_LOCK'));
  assert.ok(block.includes("'USER_STREAM_MUTATION_IN_FLIGHT'"));
  assert.ok(block.indexOf("redis.call('GET', KEYS[16])") < block.indexOf("redis.call('DEL', KEYS[5])"));
});


test('MASTER revoke final commit is fenced by the current controller role and epoch',()=>{
  assert.ok(block.includes("local controller = tostring(redis.call('GET', KEYS[17]) or '')"));
  assert.ok(block.includes("if controller ~= ARGV[3] then return -6 end"));
  assert.ok(block.includes("local controllerEpoch = tonumber(redis.call('GET', KEYS[18]) or '0') or 0"));
  assert.ok(block.includes("if controllerEpoch > 0 and controllerCreatedAt < controllerEpoch then return -7 end"));
  assert.ok(block.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(block.includes("roleAssignmentKey(PREFIX, 'controller')"));
  assert.ok(block.includes("'CONTROLLER_ROLE_CHANGED_DURING_REVOKE'"));
  assert.ok(block.includes("'CONTROLLER_SESSION_REVOKED_DURING_REVOKE'"));
  assert.ok(block.indexOf("controller ~= ARGV[3]") < block.indexOf("redis.call('DEL', KEYS[5])"));
});

test('already-revoked cleanup is also fenced by the current controller session',()=>{
  assert.ok(block.includes('const alreadyRevokedScript = ['));
  assert.ok(block.includes("if controller ~= ARGV[1] then return -1 end"));
  assert.ok(block.includes("if controllerEpoch > 0 and sessionCreatedAt < controllerEpoch then return -2 end"));
  assert.ok(block.includes("'EVAL', alreadyRevokedScript, '7'"));
  assert.ok(block.includes('clearDeviceSessionCookie(res)'));
});


test('already-revoked MASTER finalizes PAUSE_PENDING when safe',()=>{
  assert.ok(block.includes("const pauseCompletion = await tryFinalizePendingPause('', 'PAUSE_PENDING')"));
  assert.ok(block.includes("masterMode: pauseCompletion.masterMode"));
  assert.ok(block.includes("pauseQueued: pauseCompletion.masterMode === 'PAUSE_PENDING'"));
  assert.ok(block.includes("blockers: pauseCompletion.blockers || []"));
});


test('MASTER revoke also removes persistent 24/7 engine restart authority',()=>{
  assert.ok(block.includes('KEY_ENGINE_AUTHORIZED'));
  assert.ok(block.includes('KEY_ENGINE_INSTANCE'));
  assert.ok(block.includes('KEY_ENGINE_DISABLED'));
  assert.ok(block.includes("redis.call('DEL', KEYS[19])"));
  assert.ok(block.includes("redis.call('DEL', KEYS[20])"));
  assert.ok(block.includes("if registered == ARGV[5] then redis.call('SET', KEYS[21], '1') end"));
});
