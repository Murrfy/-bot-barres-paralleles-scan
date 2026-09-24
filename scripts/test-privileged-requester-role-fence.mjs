import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const helperStart=sync.indexOf('async function trySetMasterRunningFrom');
const helperEnd=sync.indexOf('function activityCount',helperStart);
assert.ok(helperStart>=0&&helperEnd>helperStart,'RUNNING transition helper missing');
const helper=sync.slice(helperStart,helperEnd);

const cancelStart=sync.indexOf("if (action === 'master-pause-cancel' && req.method === 'POST')");
const cancelEnd=sync.indexOf("if (action === 'real-execution-arm' && req.method === 'POST')",cancelStart);
assert.ok(cancelStart>=0&&cancelEnd>cancelStart,'pause-cancel block missing');
const cancel=sync.slice(cancelStart,cancelEnd);

const resumeStart=sync.indexOf("if (action === 'master-resume' && req.method === 'POST')");
const resumeEnd=sync.indexOf("if (action === 'safety' && req.method === 'GET')",resumeStart);
assert.ok(resumeStart>=0&&resumeEnd>resumeStart,'resume block missing');
const resume=sync.slice(resumeStart,resumeEnd);

const clearStart=sync.indexOf("if (action === 'emergency-stop-clear' && req.method === 'POST')");
const clearEnd=sync.indexOf("if (action === 'audit' && req.method === 'GET')",clearStart);
assert.ok(clearStart>=0&&clearEnd>clearStart,'PANIC clear block missing');
const clear=sync.slice(clearStart,clearEnd);

const armStart=sync.indexOf("if (action === 'real-execution-arm' && req.method === 'POST')");
const armEnd=sync.indexOf("if (action === 'master-resume' && req.method === 'POST')",armStart);
assert.ok(armStart>=0&&armEnd>armStart,'real execution arm block missing');
const arm=sync.slice(armStart,armEnd);

const revokeStart=sync.indexOf("if (action === 'master-revoke' && req.method === 'POST')");
const revokeEnd=sync.indexOf("if (action === 'master-pause' && req.method === 'POST')",revokeStart);
assert.ok(revokeStart>=0&&revokeEnd>revokeStart,'MASTER revoke block missing');
const revoke=sync.slice(revokeStart,revokeEnd);

test('RUNNING helper atomically revalidates the privileged requester role and epoch',()=>{
  assert.ok(helper.includes('requesterDevice = null'));
  assert.ok(helper.includes("local requester = tostring(redis.call('GET', KEYS[6]) or '')"));
  assert.ok(helper.includes("if requester ~= ARGV[5] then return {-5, mode} end"));
  assert.ok(helper.includes("local requesterEpoch = tonumber(redis.call('GET', KEYS[7]) or '0') or 0"));
  assert.ok(helper.includes("if requesterEpoch > 0 and requesterCreatedAt < requesterEpoch then return {-6, mode} end"));
  assert.ok(helper.includes('roleDeviceKey(requesterRole)'));
  assert.ok(helper.includes('roleAssignmentKey(PREFIX, requesterRole)'));
  assert.ok(helper.indexOf("requester ~= ARGV[5]") < helper.indexOf("redis.call('SET', KEYS[2], 'RUNNING')"));
});

test('resume and PAUSE_PENDING cancellation pass the authenticated requester into the final transition',()=>{
  assert.ok(cancel.includes("String(masterRoleEpochRaw || '0'),\n        device"));
  assert.ok(resume.includes("String(masterRoleEpochRaw || '0'),\n        device"));
  assert.ok(cancel.includes("'REQUESTER_ROLE_CHANGED'"));
  assert.ok(cancel.includes("'REQUESTER_SESSION_REVOKED'"));
  assert.ok(resume.includes("'REQUESTER_ROLE_CHANGED'"));
  assert.ok(resume.includes("'REQUESTER_SESSION_REVOKED'"));
  assert.ok(cancel.includes('clearDeviceSessionCookie(res)'));
  assert.ok(resume.includes('clearDeviceSessionCookie(res)'));
});

test('PANIC clear atomically revalidates the requester before clearing the stop key',()=>{
  assert.ok(clear.includes("local requester = tostring(redis.call('GET', KEYS[6]) or '')"));
  assert.ok(clear.includes("if requester ~= ARGV[3] then return -5 end"));
  assert.ok(clear.includes("local requesterEpoch = tonumber(redis.call('GET', KEYS[7]) or '0') or 0"));
  assert.ok(clear.includes("if requesterEpoch > 0 and requesterCreatedAt < requesterEpoch then return -6 end"));
  assert.ok(clear.includes('roleDeviceKey(device.role)'));
  assert.ok(clear.includes('roleAssignmentKey(PREFIX, device.role)'));
  assert.ok(clear.indexOf("requester ~= ARGV[3]") < clear.indexOf("redis.call('SET', KEYS[1], '0')"));
});

test('stale privileged requester session is cleared and cannot complete resume or PANIC clear',()=>{
  for(const block of [cancel,resume,clear]) assert.ok(block.includes('clearDeviceSessionCookie(res)'));
  assert.ok(clear.includes("'CONTROLLER_SESSION_REVOKED'"));
  assert.ok(clear.includes("'MASTER_SESSION_REVOKED'"));
  assert.ok(cancel.includes("'CONTROLLER_ROLE_CHANGED'"));
  assert.ok(resume.includes("'CONTROLLER_ROLE_CHANGED'"));
});


test('real execution arm revalidates requester role and epoch before arming',()=>{
  assert.ok(arm.includes("if requester ~= ARGV[4] then return -7 end"));
  assert.ok(arm.includes("if requesterEpoch > 0 and requesterCreatedAt < requesterEpoch then return -8 end"));
  assert.ok(arm.includes('roleDeviceKey(requesterRole)'));
  assert.ok(arm.includes('roleAssignmentKey(PREFIX, requesterRole)'));
  assert.ok(arm.indexOf("requester ~= ARGV[4]") < arm.indexOf("redis.call('SET', KEYS[8], ARGV[3])"));
  assert.ok(arm.includes('clearDeviceSessionCookie(res)'));
});

test('definitive MASTER revoke revalidates current controller before destructive writes',()=>{
  assert.ok(revoke.includes("if controller ~= ARGV[3] then return -6 end"));
  assert.ok(revoke.includes("if controllerEpoch > 0 and controllerCreatedAt < controllerEpoch then return -7 end"));
  assert.ok(revoke.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(revoke.includes("roleAssignmentKey(PREFIX, 'controller')"));
  assert.ok(revoke.indexOf("controller ~= ARGV[3]") < revoke.indexOf("redis.call('DEL', KEYS[5])"));
  assert.ok(revoke.includes('clearDeviceSessionCookie(res)'));
});

test('fail-safe PANIC remains available independently of requester final-commit fences',()=>{
  const panicStart=sync.indexOf("if (action === 'emergency-stop' && req.method === 'POST')");
  const panicEnd=sync.indexOf("if (action === 'emergency-stop-clear' && req.method === 'POST')",panicStart);
  const panic=sync.slice(panicStart,panicEnd);
  assert.ok(panic.includes("requireDevice(req, res, ['controller', 'master'])"));
  assert.ok(panic.includes('const panicEpoch = await assertEmergencyStop()'));
  assert.equal(panic.includes('verifyMasterAdminCode(req, res, device)'),false);
});
