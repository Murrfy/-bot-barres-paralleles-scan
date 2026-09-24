import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const helperStart=sync.indexOf('async function moveProcessingToPendingAtomic');
const helperEnd=sync.indexOf('function deferredCommandPayload',helperStart);
assert.ok(helperStart>=0&&helperEnd>helperStart,'atomic processing-to-pending helper missing');
const helper=sync.slice(helperStart,helperEnd);

test('processing-to-pending move is one Redis script fenced by MASTER owner, lease and role epoch',()=>{
  for(const required of [
    "if registered ~= ARGV[3] then return -1 end",
    "if lease ~= ARGV[3] then return -2 end",
    "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
    "redis.call('LREM', KEYS[1], 1, ARGV[1])",
    "redis.call('LPUSH', KEYS[2], ARGV[2])",
    "redis.call('RPUSH', KEYS[2], ARGV[2])",
    "roleAssignmentKey(PREFIX, 'master')",
    "KEY_MASTER_DEVICE",
    "KEY_MASTER",
  ]) assert.ok(helper.includes(required),required);
  assert.ok(helper.indexOf("if lease ~= ARGV[3]") < helper.indexOf("redis.call('LREM'"));
  assert.ok(helper.indexOf("roleIssuedAt > 0") < helper.indexOf("redis.call('LREM'"));
});

test('deferred execution retries cannot create a zero-queue revoke window',()=>{
  const start=sync.indexOf('async function deferClaimedCommand');
  const end=sync.indexOf('export default async function handler',start);
  const block=sync.slice(start,end);
  assert.ok(block.includes('moveProcessingToPendingAtomic('));
  assert.equal(block.includes("redis(['LREM', KEY_PROCESSING"),false);
  assert.equal(block.includes("redis(['LPUSH', KEY_PENDING"),false);
});

test('stale recovery requeues through the same atomic fenced move',()=>{
  const start=sync.indexOf('async function recoverStaleProcessing');
  const end=sync.indexOf('async function claimNextCommand',start);
  const block=sync.slice(start,end);
  assert.ok(block.includes('moveProcessingToPendingAtomic('));
  assert.ok(block.includes("'RPUSH'"));
  assert.equal(block.includes("await redis(['RPUSH', KEY_PENDING"),false);
});

test('manual command requeue uses atomic fenced move instead of LREM then LPUSH',()=>{
  const start=sync.indexOf("if (action === 'command-requeue' && req.method === 'POST')");
  const end=sync.indexOf("if (action === 'emergency-stop'",start);
  const block=sync.slice(start,end);
  assert.ok(block.includes('moveProcessingToPendingAtomic('));
  assert.ok(block.includes("'LPUSH'"));
  assert.equal(block.includes("await redis(['LPUSH', KEY_PENDING"),false);
});

test('definitive MASTER revoke still atomically refuses non-empty pending or processing queues',()=>{
  const start=sync.indexOf("if (action === 'master-revoke' && req.method === 'POST')");
  const end=sync.indexOf("if (action === 'master-pause' && req.method === 'POST')",start);
  const block=sync.slice(start,end);
  assert.ok(block.includes("redis.call('LLEN', KEYS[13]) > 0"));
  assert.ok(block.includes("redis.call('LLEN', KEYS[14]) > 0"));
});
