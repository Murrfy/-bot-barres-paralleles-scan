import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const acquireStart=sync.indexOf('async function acquireOrRenewMaster');
const acquireEnd=sync.indexOf('async function emergencyStopActive',acquireStart);
assert.ok(acquireStart>=0&&acquireEnd>acquireStart,'MASTER lease helper missing');
const acquire=sync.slice(acquireStart,acquireEnd);

const authorizeStart=sync.indexOf("if (action === 'master-authorize' && req.method === 'POST')");
const heartbeatStart=sync.indexOf("if (action === 'master-heartbeat' && req.method === 'POST')",authorizeStart);
const masterGetStart=sync.indexOf("if (action === 'master' && req.method === 'GET')",heartbeatStart);
assert.ok(authorizeStart>=0&&heartbeatStart>authorizeStart&&masterGetStart>heartbeatStart);
const authorize=sync.slice(authorizeStart,heartbeatStart);
const heartbeat=sync.slice(heartbeatStart,masterGetStart);

test('MASTER activation commit is fenced against revoked MASTER and replaced controller',()=>{
  assert.ok(authorize.includes('const activationScript = ['));
  assert.ok(authorize.includes("if registeredMaster ~= ARGV[1] then return -1 end"));
  assert.ok(authorize.includes("if currentController ~= ARGV[2] then return -2 end"));
  assert.ok(authorize.includes("if controllerEpoch > 0 and sessionCreatedAt < controllerEpoch then return -3 end"));
  assert.ok(authorize.includes('KEY_MASTER_DEVICE'));
  assert.ok(authorize.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(authorize.includes("roleAssignmentKey(PREFIX, 'controller')"));
  assert.ok(authorize.indexOf("registeredMaster ~= ARGV[1]") < authorize.indexOf("redis.call('SET', KEYS[1], '1'"));
  assert.ok(authorize.includes("'MASTER_ROLE_CHANGED'"));
  assert.ok(authorize.includes("'CONTROLLER_ROLE_CHANGED'"));
  assert.ok(authorize.includes("'CONTROLLER_SESSION_REVOKED'"));
});

test('MASTER lease acquisition and renewal revalidate registration and MASTER role epoch atomically',()=>{
  assert.ok(acquire.includes("local registered = tostring(redis.call('GET', KEYS[3]) or '')"));
  assert.ok(acquire.includes("if registered ~= ARGV[1] then return -2 end"));
  assert.ok(acquire.includes("local roleIssuedAt = tonumber(redis.call('GET', KEYS[4]) or '0') or 0"));
  assert.ok(acquire.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end"));
  assert.ok(acquire.includes('KEY_MASTER_DEVICE'));
  assert.ok(acquire.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(acquire.indexOf("registered ~= ARGV[1]") < acquire.indexOf("redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])"));
});

test('heartbeat cannot resurrect stale MASTER heartbeat after revoke',()=>{
  assert.ok(heartbeat.includes('const heartbeatScript = ['));
  assert.ok(heartbeat.includes("if registered ~= ARGV[2] then return -1 end"));
  assert.ok(heartbeat.includes("if lease ~= ARGV[2] then return -2 end"));
  assert.ok(heartbeat.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end"));
  assert.ok(heartbeat.includes('KEY_MASTER_HEARTBEAT'));
  assert.ok(heartbeat.includes('KEY_MASTER_DEVICE'));
  assert.ok(heartbeat.includes('KEY_MASTER'));
  assert.ok(heartbeat.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(heartbeat.indexOf("registered ~= ARGV[2]") < heartbeat.indexOf("redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])"));
  assert.equal(heartbeat.includes("await redis([\n        'SET', KEY_MASTER_HEARTBEAT"),false);
});

test('stale MASTER role/session failure clears secure session cookie',()=>{
  assert.ok(heartbeat.includes('clearDeviceSessionCookie(res)'));
  assert.ok(heartbeat.includes("'MASTER_ROLE_CHANGED'"));
  assert.ok(heartbeat.includes("'MASTER_SESSION_REVOKED'"));
});
