import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const start=sync.indexOf("if (action === 'controller-replacement-authorize' && req.method === 'POST')");
const end=sync.indexOf("if (action === 'controller-replacement-redeem' && req.method === 'POST')",start);
assert.ok(start>=0&&end>start,'controller replacement authorization block missing');
const block=sync.slice(start,end);

test('controller replacement authorization commit is fenced by current MASTER owner, lease and role epoch',()=>{
  assert.ok(block.includes('const replacementAuthorizeScript = ['));
  assert.ok(block.includes("if registeredMaster ~= ARGV[1] then return -1 end"));
  assert.ok(block.includes("if lease ~= ARGV[1] then return -2 end"));
  assert.ok(block.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end"));
  assert.ok(block.includes("if currentController ~= ARGV[3] then return -4 end"));
  assert.ok(block.includes('KEY_MASTER_DEVICE'));
  assert.ok(block.includes('KEY_MASTER'));
  assert.ok(block.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(block.includes('KEY_CONTROLLER_DEVICE'));
});

test('replacement code and audit are created only after all role/lease checks pass',()=>{
  const guard=block.indexOf("if currentController ~= ARGV[3] then return -4 end");
  const write=block.indexOf("redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5])");
  assert.ok(guard>=0&&write>guard);
  assert.ok(block.includes("redis.call('LPUSH', KEYS[6], ARGV[6])"));
  assert.ok(block.includes("redis.call('LTRIM', KEYS[6], 0, 199)"));
  assert.equal(block.includes("await redis([\n        'SET',\n        replacementKey"),false);
});

test('stale MASTER authorization request fails closed after revoke or lease loss',()=>{
  assert.ok(block.includes("'MASTER_ROLE_CHANGED'"));
  assert.ok(block.includes("'MASTER_LEASE_REQUIRED'"));
  assert.ok(block.includes("'MASTER_SESSION_REVOKED'"));
  assert.ok(block.includes("'CONTROLLER_ROLE_CHANGED'"));
  assert.ok(block.includes('clearDeviceSessionCookie(res)'));
});
