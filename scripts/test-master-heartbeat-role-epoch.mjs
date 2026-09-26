import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const acquireStart=sync.indexOf('async function acquireOrRenewMaster');
const acquireEnd=sync.indexOf('async function commitMasterHeartbeat',acquireStart);
const commitStart=acquireEnd;
const commitEnd=sync.indexOf('async function emergencyStopActive',commitStart);
const heartbeatStart=sync.indexOf("if (action === 'master-heartbeat' && req.method === 'POST')");
const heartbeatEnd=sync.indexOf("if (action === 'master' && req.method === 'GET')",heartbeatStart);

assert.ok(acquireStart>=0&&acquireEnd>acquireStart);
assert.ok(commitStart>=0&&commitEnd>commitStart);
assert.ok(heartbeatStart>=0&&heartbeatEnd>heartbeatStart);

const acquire=sync.slice(acquireStart,acquireEnd);
const commit=sync.slice(commitStart,commitEnd);
const heartbeat=sync.slice(heartbeatStart,heartbeatEnd);

test('MASTER lease acquisition and renewal are bound to registered MASTER and role epoch',()=>{
  assert.ok(acquire.includes("local registered = tostring(redis.call('GET', KEYS[3]) or '')"));
  assert.ok(acquire.includes("if registered ~= ARGV[1] then return -2 end"));
  assert.ok(acquire.includes("local roleIssuedAt = tonumber(redis.call('GET', KEYS[4]) or '0') or 0"));
  assert.ok(acquire.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end"));
  assert.ok(acquire.includes('KEY_MASTER_DEVICE'));
  assert.ok(acquire.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(acquire.indexOf("registered ~= ARGV[1]") < acquire.indexOf("local approved = redis.call('GET', KEYS[2])"));
});

test('stale MASTER cannot consume a new activation after revoke and same-id re-pair',()=>{
  assert.ok(acquire.includes('sessionRevoked: result === -3'));
  assert.ok(acquire.includes('roleChanged: result === -2'));
  assert.ok(heartbeat.includes('lease.roleChanged || lease.sessionRevoked'));
  assert.ok(heartbeat.includes('clearDeviceSessionCookie(res)'));
  assert.ok(heartbeat.includes("'MASTER_SESSION_REVOKED'"));
});

test('heartbeat persistence is atomically fenced by registered MASTER, lease and role epoch',()=>{
  assert.ok(commit.includes("if registered ~= ARGV[2] then return -1 end"));
  assert.ok(commit.includes("if lease ~= ARGV[2] then return -2 end"));
  assert.ok(commit.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end"));
  assert.ok(commit.includes("redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])"));
  assert.ok(commit.includes('KEY_MASTER_HEARTBEAT'));
  assert.ok(commit.includes('KEY_MASTER_DEVICE'));
  assert.ok(commit.includes('KEY_MASTER'));
  assert.ok(commit.includes("roleAssignmentKey(PREFIX, 'master')"));
});

test('heartbeat handler no longer writes heartbeat with an unfenced SET',()=>{
  assert.ok(heartbeat.includes('const heartbeatCommit = await commitMasterHeartbeat(heartbeat, device)'));
  assert.equal(heartbeat.includes("'SET', KEY_MASTER_HEARTBEAT"),false);
  assert.ok(heartbeat.includes("'MASTER_LEASE_REQUIRED'"));
  assert.ok(heartbeat.includes("'MASTER_ROLE_CHANGED'"));
  assert.ok(heartbeat.includes("'MASTER_SESSION_REVOKED'"));
});


test('authorized fenced engine may reacquire an expired MASTER lease without controller presence',()=>{
  assert.ok(acquire.includes("if ARGV[4] == '1' then"));
  assert.ok(acquire.includes("local currentInstance = tostring(redis.call('GET', KEYS[6]) or '')"));
  assert.ok(acquire.includes("if currentInstance == '' or currentInstance ~= ARGV[5] then return -4 end"));
  assert.ok(acquire.includes("local authorizationRaw = redis.call('GET', KEYS[5])"));
  assert.ok(acquire.includes("tonumber(authorization['version'] or 0) ~= 1"));
  assert.ok(acquire.includes("tostring(authorization['masterDeviceId'] or '') ~= ARGV[1]"));
  assert.ok(acquire.includes("return 3"));
  assert.ok(acquire.includes('KEY_ENGINE_AUTHORIZED'));
  assert.ok(acquire.includes('KEY_ENGINE_INSTANCE'));
  assert.ok(acquire.includes('reacquiredPersistent: result === 3'));
  assert.ok(acquire.includes('authorized: result === 1 || result === 2 || result === 3'));
  assert.ok(heartbeat.includes('lease.engineInstanceFenced'));
  assert.ok(heartbeat.includes("'ENGINE_INSTANCE_FENCED'"));
  assert.ok(heartbeat.includes('reacquiredPersistent: lease.reacquiredPersistent === true'));
});

test('non-engine MASTER still requires the short-lived controller activation after lease loss',()=>{
  assert.ok(acquire.includes("if approved == '1' then"));
  assert.ok(acquire.includes("redis.call('DEL', KEYS[2])"));
  assert.ok(acquire.includes("if ARGV[4] == '1' then"));
  assert.ok(acquire.includes("return 0"));
  assert.ok(acquire.includes("isEngine ? '1' : '0'"));
});
