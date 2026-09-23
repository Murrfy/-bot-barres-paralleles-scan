import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const resumeStart=sync.indexOf("if (action === 'master-resume' && req.method === 'POST')");
const resumeEnd=sync.indexOf("if (action === 'safety' && req.method === 'GET')",resumeStart);
assert.ok(resumeStart>=0&&resumeEnd>resumeStart,'MASTER resume block missing');
const resume=sync.slice(resumeStart,resumeEnd);

const cancelStart=sync.indexOf("if (action === 'master-pause-cancel' && req.method === 'POST')");
const cancelEnd=sync.indexOf("if (action === 'real-execution-arm' && req.method === 'POST')",cancelStart);
assert.ok(cancelStart>=0&&cancelEnd>cancelStart,'MASTER pause-cancel block missing');
const cancel=sync.slice(cancelStart,cancelEnd);

test('MASTER resume requires the server mode to already be PAUSED',()=>{
  assert.ok(resume.includes('masterMode()'));
  assert.ok(resume.includes("if (currentMode !== 'PAUSED') blockers.push('MASTER_MUST_BE_PAUSED')"));
  assert.ok(resume.includes("trySetMasterRunningFrom("));
  assert.ok(resume.includes("'PAUSED'"));
  assert.ok(
    resume.indexOf("currentMode !== 'PAUSED'") <
    resume.indexOf("trySetMasterRunningFrom(")
  );
});

test('PAUSE_PENDING cancellation remains a separate explicit ADMIN action',()=>{
  assert.ok(cancel.includes("currentMode !== 'PAUSE_PENDING'"));
  assert.ok(cancel.includes("'MASTER_PAUSE_NOT_PENDING'"));
  assert.ok(cancel.includes('verifyMasterAdminCode(req, res, device)'));
  assert.ok(cancel.includes("trySetMasterRunningFrom("));
  assert.ok(cancel.includes("'PAUSE_PENDING'"));
  assert.ok(cancel.includes('currentMaster'));
  assert.ok(cancel.includes("String(masterRoleEpochRaw || '0')"));
});

test('resume cannot act as an implicit PAUSE_PENDING cancellation path',()=>{
  assert.ok(resume.includes("'MASTER_MUST_BE_PAUSED'"));
  assert.equal(resume.includes("'MASTER_PAUSE_NOT_PENDING'"),false);
});


test('RUNNING transitions are atomically fenced against real-trading PANIC',()=>{
  assert.ok(sync.includes("async function trySetMasterRunningFrom(expectedMode, expectedMasterDeviceId, expectedMasterRoleEpochRaw = '0')"));
  assert.ok(sync.includes("if ARGV[2] == '1' and panic ~= '0' then return {-1, mode} end"));
  assert.ok(sync.includes("if mode ~= ARGV[1] then return {-2, mode} end"));
  assert.ok(sync.includes("redis.call('SET', KEYS[2], 'RUNNING')"));
  assert.ok(sync.includes("KEY_EMERGENCY_STOP"));
  assert.ok(sync.includes("REAL_TRADING_ENABLED ? '1' : '0'"));
  assert.ok(cancel.includes("trySetMasterRunningFrom("));
  assert.ok(cancel.includes("'PAUSE_PENDING'"));
  assert.ok(resume.includes("trySetMasterRunningFrom("));
  assert.ok(resume.includes("'PAUSED'"));
  assert.ok(resume.includes('currentMaster'));
  assert.ok(resume.includes("String(masterRoleEpochRaw || '0')"));
  assert.equal(cancel.includes("setMasterMode('RUNNING')"),false);
  assert.equal(resume.includes("setMasterMode('RUNNING')"),false);
});

test('pause cancellation returns fail-closed while PANIC is active',()=>{
  assert.ok(cancel.includes("'EMERGENCY_STOP_ACTIVE'"));
  assert.ok(cancel.includes("runningTransition.reason === 'EMERGENCY_STOP_ACTIVE'"));
  assert.ok(cancel.includes("code === 'EMERGENCY_STOP_ACTIVE' ? 423 : 409"));
});


test('RUNNING transition atomically revalidates MASTER lease, registration and role epoch',()=>{
  assert.ok(sync.includes("local lease = tostring(redis.call('GET', KEYS[3]) or '')"));
  assert.ok(sync.includes("local registered = tostring(redis.call('GET', KEYS[4]) or '')"));
  assert.ok(sync.includes("if lease ~= ARGV[3] or registered ~= ARGV[3] then return {-3, mode} end"));
  assert.ok(sync.includes("local roleEpoch = tostring(redis.call('GET', KEYS[5]) or '0')"));
  assert.ok(sync.includes("if roleEpoch ~= ARGV[4] then return {-4, mode} end"));
  assert.ok(sync.includes('KEY_MASTER'));
  assert.ok(sync.includes('KEY_MASTER_DEVICE'));
  assert.ok(sync.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(sync.includes("'MASTER_LEASE_REQUIRED'"));
  assert.ok(sync.includes("'MASTER_ROLE_CHANGED'"));
});

test('resume and PAUSE_PENDING cancel capture MASTER role epoch before their final RUNNING transition',()=>{
  assert.ok(cancel.includes("redis(['GET', roleAssignmentKey(PREFIX, 'master')])"));
  assert.ok(resume.includes("redis(['GET', roleAssignmentKey(PREFIX, 'master')])"));
  assert.ok(cancel.includes("String(masterRoleEpochRaw || '0')"));
  assert.ok(resume.includes("String(masterRoleEpochRaw || '0')"));
});
