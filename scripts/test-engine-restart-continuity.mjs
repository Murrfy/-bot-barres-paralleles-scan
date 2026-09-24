import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/zenith-sync.js','utf8');

function between(startMarker,endMarker){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing source block '+startMarker);
  return source.slice(start,end);
}

const authorization=between('async function persistEngineRestartAuthorization','async function masterDeviceId');
const bootstrap=between("if (action === 'engine-bootstrap'","if (action === 'pair'");
const heartbeat=between("if (action === 'master-heartbeat'","if (action === 'master' && req.method === 'GET')");
const revoke=between("if (action === 'master-revoke'","if (action === 'master-pause'");

test('persistent engine restart authority can only be created after a freshly acquired ADMIN-authorized MASTER lease',()=>{
  assert.ok(source.includes("const KEY_ENGINE_AUTHORIZED = \`\${PREFIX}:engine-authorized\`;"));
  assert.ok(heartbeat.includes('persistEngineRestartAuthorization(device, lease.acquired === true)'));
  assert.ok(authorization.includes("if ARGV[6] ~= '1' then return 0 end"));
  assert.ok(authorization.includes("redis.call('SET', KEYS[5], ARGV[4])"));
  assert.ok(authorization.includes("kind:'ENGINE_RESTART_AUTHORIZED'"));
  assert.ok(authorization.includes("currentInstance ~= ARGV[1]"));
  assert.ok(authorization.includes("registeredMaster ~= ARGV[2]"));
  assert.ok(authorization.includes("lease ~= ARGV[2]"));
  assert.ok(authorization.includes("currentEpoch ~= ARGV[3]"));
});

test('authorized restart gets a fresh lease while a still-active different engine instance cannot be stolen',()=>{
  assert.ok(bootstrap.includes("if currentInstance ~= '' and currentInstance ~= ARGV[5] and currentLease == ARGV[1] then return {-2"));
  assert.ok(bootstrap.includes("if authorized == 1 then"));
  assert.ok(bootstrap.includes("redis.call('SET', KEYS[5], ARGV[1], 'EX', ARGV[8])"));
  assert.ok(bootstrap.includes("code:'ENGINE_INSTANCE_ACTIVE'"));
  assert.ok(bootstrap.includes('String(MASTER_TTL_SECONDS)'));
});

test('restart rotates epoch and carries real arm only for the same logical engine, exact old epoch and exact deployment SHA',()=>{
  assert.ok(bootstrap.includes("local oldRoleEpoch = tostring(redis.call('GET', KEYS[2]) or '')"));
  assert.ok(bootstrap.includes("tostring(arm['masterDeviceId'] or '') == ARGV[1]"));
  assert.ok(bootstrap.includes("tostring(arm['masterRoleEpoch'] or '') == oldRoleEpoch"));
  assert.ok(bootstrap.includes("tostring(arm['deploymentSha'] or '') == ARGV[9]"));
  assert.ok(bootstrap.includes("arm['masterRoleEpoch'] = tonumber(ARGV[2])"));
  assert.ok(bootstrap.includes("redis.call('SET', KEYS[10], cjson.encode(arm))"));
  assert.ok(bootstrap.includes('DEPLOYMENT_SHA'));
  assert.ok(bootstrap.includes('realExecutionArmCarried'));
});

test('deployment or arm mismatch while RUNNING forces PANIC plus PAUSE_PENDING instead of silently resuming entries',()=>{
  assert.ok(bootstrap.includes("if armCarried == 0 and mode == 'RUNNING' then"));
  assert.ok(bootstrap.includes("redis.call('SET', KEYS[7], '1')"));
  assert.ok(bootstrap.includes("redis.call('SET', KEYS[6], 'PAUSE_PENDING')"));
  assert.ok(bootstrap.includes('restartFailClosed'));
});

test('every engine bootstrap discards stale runtime evidence before the new process can work',()=>{
  for(const required of [
    'KEY_MASTER_HEARTBEAT',
    'KEY_MASTER_CONFIG_ACK',
    'KEY_RECONCILE_LAST',
    'KEY_STATE',
    'KEY_USER_STREAM_SESSION',
  ]) assert.ok(bootstrap.includes(required),required);
  for(const index of [11,12,13,14,15]){
    assert.ok(bootstrap.includes("redis.call('DEL', KEYS["+index+"])"),'missing stale-state delete '+index);
  }
});

test('restart is refused while a Binance user-stream mutation lock is still alive',()=>{
  assert.ok(bootstrap.includes("local streamLock = tostring(redis.call('GET', KEYS[16]) or '')"));
  assert.ok(bootstrap.includes("if registeredMaster ~= '' and streamLock ~= '' then return {-6"));
  assert.ok(bootstrap.includes("code:'ENGINE_RESTART_MUTATION_IN_FLIGHT'"));
  assert.ok(bootstrap.includes('KEY_USER_STREAM_MUTATION_LOCK'));
});

test('initial server registration cannot inherit an old authorization or real arm record',()=>{
  assert.ok(bootstrap.includes("if registeredMaster == '' then"));
  assert.ok(bootstrap.includes("redis.call('DEL', KEYS[9])"));
  assert.ok(bootstrap.includes("redis.call('DEL', KEYS[10])"));
});

test('ADMIN MASTER revoke permanently clears server restart authority and current engine instance',()=>{
  assert.ok(revoke.includes('KEY_ENGINE_AUTHORIZED'));
  assert.ok(revoke.includes('KEY_ENGINE_INSTANCE'));
  assert.ok(revoke.includes('KEY_ENGINE_DISABLED'));
  assert.ok(revoke.includes("redis.call('DEL', KEYS[19])"));
  assert.ok(revoke.includes("redis.call('DEL', KEYS[20])"));
  assert.ok(revoke.includes("'EVAL', revokeScript, '21'"));
  assert.ok(revoke.includes("'EVAL', alreadyRevokedScript, '12'"));
});
