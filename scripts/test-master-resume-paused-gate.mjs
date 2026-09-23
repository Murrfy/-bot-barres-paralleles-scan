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
  assert.ok(
    resume.indexOf("currentMode !== 'PAUSED'") <
    resume.indexOf("setMasterMode('RUNNING')")
  );
});

test('PAUSE_PENDING cancellation remains a separate explicit ADMIN action',()=>{
  assert.ok(cancel.includes("currentMode !== 'PAUSE_PENDING'"));
  assert.ok(cancel.includes("'MASTER_PAUSE_NOT_PENDING'"));
  assert.ok(cancel.includes('verifyMasterAdminCode(req, res, device)'));
  assert.ok(cancel.includes("setMasterMode('RUNNING')"));
});

test('resume cannot act as an implicit PAUSE_PENDING cancellation path',()=>{
  assert.ok(resume.includes("'MASTER_MUST_BE_PAUSED'"));
  assert.equal(resume.includes("'MASTER_PAUSE_NOT_PENDING'"),false);
});


test('RUNNING transitions are atomically fenced against real-trading PANIC',()=>{
  assert.ok(sync.includes('async function trySetMasterRunningFrom(expectedMode)'));
  assert.ok(sync.includes("if ARGV[2] == '1' and panic ~= '0' then return {-1, mode} end"));
  assert.ok(sync.includes("if mode ~= ARGV[1] then return {-2, mode} end"));
  assert.ok(sync.includes("redis.call('SET', KEYS[2], 'RUNNING')"));
  assert.ok(sync.includes("KEY_EMERGENCY_STOP"));
  assert.ok(sync.includes("REAL_TRADING_ENABLED ? '1' : '0'"));
  assert.ok(cancel.includes("trySetMasterRunningFrom('PAUSE_PENDING')"));
  assert.ok(resume.includes("trySetMasterRunningFrom('PAUSED')"));
  assert.equal(cancel.includes("setMasterMode('RUNNING')"),false);
  assert.equal(resume.includes("setMasterMode('RUNNING')"),false);
});

test('pause cancellation returns fail-closed while PANIC is active',()=>{
  assert.ok(cancel.includes("'EMERGENCY_STOP_ACTIVE'"));
  assert.ok(cancel.includes("runningTransition.reason === 'EMERGENCY_STOP_ACTIVE' ? 423 : 409"));
});
