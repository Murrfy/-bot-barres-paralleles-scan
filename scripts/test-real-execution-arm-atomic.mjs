import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const statusStart=sync.indexOf("async function realExecutionArmStatus(expectedMasterDeviceId = '')");
const statusEnd=sync.indexOf('function normalizeMasterMode',statusStart);
assert.ok(statusStart>=0&&statusEnd>statusStart,'realExecutionArmStatus block missing');
const statusBlock=sync.slice(statusStart,statusEnd);

const armStart=sync.indexOf("if (action === 'real-execution-arm' && req.method === 'POST')");
const armEnd=sync.indexOf("if (action === 'master-resume' && req.method === 'POST')",armStart);
assert.ok(armStart>=0&&armEnd>armStart,'real-execution-arm block missing');
const armBlock=sync.slice(armStart,armEnd);

test('real execution arm status is fenced by current MASTER role, lease and role epoch',()=>{
  assert.ok(statusBlock.includes("redis(['GET', KEY_REAL_EXECUTION_ARMED])"));
  assert.ok(statusBlock.includes("redis(['GET', KEY_MASTER_DEVICE])"));
  assert.ok(statusBlock.includes("redis(['GET', KEY_MASTER])"));
  assert.ok(statusBlock.includes("redis(['GET', roleAssignmentKey(PREFIX, 'master')])"));
  assert.ok(statusBlock.includes("'REAL_EXECUTION_ARM_MASTER_CHANGED'"));
  assert.ok(statusBlock.includes("'MASTER_LEASE_REQUIRED'"));
  assert.ok(statusBlock.includes("'REAL_EXECUTION_ARM_ROLE_EPOCH_CHANGED'"));
});

test('real arm commit atomically revalidates MASTER state after slow external checks',()=>{
  for(const required of [
    'const armCommitScript = [',
    "if registered ~= ARGV[1] then return -1 end",
    "if lease ~= ARGV[1] then return -2 end",
    "if mode ~= 'PAUSED' then return -3 end",
    "if panic ~= '1' then return -4 end",
    "redis.call('LLEN', KEYS[5]) > 0 or redis.call('LLEN', KEYS[6]) > 0",
    "if roleEpoch ~= ARGV[2] then return -6 end",
    "if requester ~= ARGV[4] then return -7 end",
    "if requesterEpoch > 0 and requesterCreatedAt < requesterEpoch then return -8 end",
    'roleDeviceKey(requesterRole)',
    'roleAssignmentKey(PREFIX, requesterRole)',
    "redis.call('SET', KEYS[8], ARGV[3])",
    "'EVAL', armCommitScript, '10'",
    'KEY_MASTER_DEVICE',
    'KEY_MASTER',
    'KEY_MASTER_MODE',
    'KEY_EMERGENCY_STOP',
    'KEY_PENDING',
    'KEY_PROCESSING',
    "roleAssignmentKey(PREFIX, 'master')",
    'KEY_REAL_EXECUTION_ARMED',
    "'REAL_EXECUTION_ARM_RACE_BLOCKED'",
    "'REQUESTER_ROLE_CHANGED_DURING_ARM'",
    "'REQUESTER_SESSION_REVOKED_DURING_ARM'",
  ]) assert.ok(armBlock.includes(required),required);

  assert.equal(armBlock.includes("await redis(['SET', KEY_REAL_EXECUTION_ARMED"),false);
  assert.ok(
    armBlock.indexOf("if roleEpoch ~= ARGV[2] then return -6 end") <
    armBlock.indexOf("redis.call('SET', KEYS[8], ARGV[3])")
  );
});

test('arm record is bound to the MASTER role epoch and audit happens only after atomic commit',()=>{
  assert.ok(armBlock.includes('masterRoleEpoch,'));
  assert.ok(armBlock.includes("'MASTER_ROLE_EPOCH_CHANGED_DURING_ARM'"));
  assert.ok(
    armBlock.indexOf('if (armCommitResult !== 1)') <
    armBlock.indexOf("kind:'REAL_EXECUTION_ARMED'")
  );
});
