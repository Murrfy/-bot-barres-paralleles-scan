import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

function actionBlock(action){
  const start=sync.indexOf(`if (action === '${action}' && req.method === 'POST')`);
  const end=sync.indexOf("\n    if (action === '",start+10);
  assert.ok(start>=0&&end>start,`missing action block: ${action}`);
  return sync.slice(start,end);
}

const controller=actionBlock('controller-state');
const ack=actionBlock('master-config-ack');
const state=actionBlock('state');

test('controller-state commit atomically revalidates controller owner and role epoch',()=>{
  assert.ok(controller.includes("local currentController = tostring(redis.call('GET', KEYS[4]) or '')"));
  assert.ok(controller.includes("if currentController ~= ARGV[4] then return {-2, currentController, ''} end"));
  assert.ok(controller.includes("local roleIssuedAt = tonumber(redis.call('GET', KEYS[5]) or '0') or 0"));
  assert.ok(controller.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return {-3, tostring(roleIssuedAt), ''} end"));
  assert.ok(controller.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(controller.includes("roleAssignmentKey(PREFIX, 'controller')"));
  assert.ok(controller.indexOf("currentController ~= ARGV[4]") < controller.indexOf("redis.call('SET', KEYS[1], snapshotRaw)"));
  assert.ok(controller.includes("'CONTROLLER_ROLE_CHANGED'"));
  assert.ok(controller.includes("'CONTROLLER_SESSION_REVOKED'"));
});

test('MASTER runtime-state commit cannot resurrect state after lease, owner or epoch changes',()=>{
  assert.ok(state.includes('const stateCommitScript = ['));
  assert.ok(state.includes("if registered ~= ARGV[2] then return -1 end"));
  assert.ok(state.includes("if lease ~= ARGV[2] then return -2 end"));
  assert.ok(state.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end"));
  assert.ok(state.includes('KEY_MASTER_DEVICE'));
  assert.ok(state.includes('KEY_MASTER'));
  assert.ok(state.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(state.indexOf("if registered ~= ARGV[2]") < state.indexOf("redis.call('SET', KEYS[1], ARGV[1])"));
  assert.equal(state.includes("await redis(['SET', KEY_STATE"),false);
});

test('MASTER config ACK atomically binds current MASTER and current controller revision/hash',()=>{
  assert.ok(ack.includes('const ackScript = ['));
  assert.ok(ack.includes("if registered ~= ARGV[3] then return -1 end"));
  assert.ok(ack.includes("if lease ~= ARGV[3] then return -2 end"));
  assert.ok(ack.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end"));
  assert.ok(ack.includes("if tonumber(controller['revision'] or 0) ~= tonumber(ARGV[5]) then return -5 end"));
  assert.ok(ack.includes("if tostring(controller['stateHash'] or '') ~= ARGV[6] then return -5 end"));
  assert.ok(ack.includes('KEY_CONTROLLER_STATE'));
  assert.ok(ack.indexOf("controller['revision']") < ack.indexOf("redis.call('SET', KEYS[1], ARGV[1])"));
  assert.equal(ack.includes("await redis(['SET', KEY_MASTER_CONFIG_ACK"),false);
});

test('role-epoch failures clear the stale secure device session',()=>{
  assert.ok(controller.includes('clearDeviceSessionCookie(res)'));
  assert.ok(state.includes('clearDeviceSessionCookie(res)'));
  assert.ok(ack.includes('clearDeviceSessionCookie(res)'));
});
