import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

function block(action,nextAction){
  const start=sync.indexOf(`if (action === '${action}' && req.method === 'POST')`);
  const end=sync.indexOf(`if (action === '${nextAction}'`,start);
  assert.ok(start>=0&&end>start,`missing block ${action}`);
  return sync.slice(start,end);
}

const masterAuthorize=block('master-authorize','master-heartbeat');
const replacementAuthorize=block('controller-replacement-authorize','controller-replacement-redeem');

test('controller MASTER activation commit is fenced by current controller role epoch and registered MASTER',()=>{
  assert.ok(masterAuthorize.includes('const authorizeScript = ['));
  assert.ok(masterAuthorize.includes("if controller ~= ARGV[1] then return -1 end"));
  assert.ok(masterAuthorize.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -2 end"));
  assert.ok(masterAuthorize.includes("if registeredMaster ~= ARGV[3] then return -3 end"));
  assert.ok(masterAuthorize.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(masterAuthorize.includes("roleAssignmentKey(PREFIX, 'controller')"));
  assert.ok(masterAuthorize.includes('KEY_MASTER_DEVICE'));
  assert.ok(masterAuthorize.indexOf("controller ~= ARGV[1]") < masterAuthorize.indexOf("redis.call('SET', KEYS[1], '1'"));
  assert.equal(masterAuthorize.includes("await redis([\n        'SET',\n        masterActivationKey"),false);
});

test('stale controller cannot finish MASTER activation after replacement',()=>{
  assert.ok(masterAuthorize.includes("'CONTROLLER_ROLE_CHANGED'"));
  assert.ok(masterAuthorize.includes("'CONTROLLER_SESSION_REVOKED'"));
  assert.ok(masterAuthorize.includes('clearDeviceSessionCookie(res)'));
});

test('controller replacement authorization is fenced by current MASTER owner, lease, epoch and controller identity',()=>{
  assert.ok(replacementAuthorize.includes('const replacementAuthorizeScript = ['));
  assert.ok(replacementAuthorize.includes("if registeredMaster ~= ARGV[1] then return -1 end"));
  assert.ok(replacementAuthorize.includes("if lease ~= ARGV[1] then return -2 end"));
  assert.ok(replacementAuthorize.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end"));
  assert.ok(replacementAuthorize.includes("if currentController ~= ARGV[3] then return -4 end"));
  assert.ok(replacementAuthorize.includes('KEY_MASTER_DEVICE'));
  assert.ok(replacementAuthorize.includes('KEY_MASTER'));
  assert.ok(replacementAuthorize.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(replacementAuthorize.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(replacementAuthorize.indexOf("registeredMaster ~= ARGV[1]") < replacementAuthorize.indexOf("redis.call('SET', KEYS[1], ARGV[4]"));
});

test('stale MASTER cannot mint a controller replacement code after revoke',()=>{
  assert.ok(replacementAuthorize.includes("'MASTER_ROLE_CHANGED'"));
  assert.ok(replacementAuthorize.includes("'MASTER_LEASE_REQUIRED'"));
  assert.ok(replacementAuthorize.includes("'MASTER_SESSION_REVOKED'"));
  assert.ok(replacementAuthorize.includes('clearDeviceSessionCookie(res)'));
});
