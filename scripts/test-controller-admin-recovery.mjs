import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const page=fs.readFileSync('replace-controller.html','utf8');
const index=fs.readFileSync('index.html','utf8');

function between(startMarker,endMarker){
  const start=sync.indexOf(startMarker);
  const end=sync.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing source block '+startMarker);
  return sync.slice(start,end);
}

const verifier=between('async function verifyControllerRecoveryAdminCode','function normalizeReplacementCode');
const endpoint=between("if (action === 'controller-recovery-admin'","if (action === 'whoami'");

test('lost-iPhone recovery uses the server-side ADMIN secret without requiring a MASTER device',()=>{
  assert.ok(endpoint.includes('verifyControllerRecoveryAdminCode(req, res)'));
  assert.equal(endpoint.includes('requireDevice(req, res'),false);
  assert.equal(endpoint.includes('MASTER_LEASE_REQUIRED'),false);
  assert.ok(verifier.includes('MASTER_ADMIN_CODE'));
  assert.ok(verifier.includes('adminSecretPolicyBlockers()'));
  assert.ok(verifier.includes('timingSafeEqualText(supplied, MASTER_ADMIN_CODE)'));
});

test('public ADMIN recovery is bounded and brute-force protected',()=>{
  assert.ok(sync.includes('const CONTROLLER_ADMIN_RECOVERY_RATE_LIMIT = 5;'));
  assert.ok(sync.includes('const CONTROLLER_ADMIN_RECOVERY_GLOBAL_RATE_LIMIT = 30;'));
  assert.ok(sync.includes('async function controllerAdminRecoveryRateAllowed(req)'));
  assert.ok(sync.includes(':controller-admin-recovery-rate:global:'));
  assert.ok(endpoint.includes('controllerAdminRecoveryRateAllowed(req)'));
  assert.ok(endpoint.includes("'CONTROLLER_ADMIN_RECOVERY_RATE_LIMIT'"));
  const bound=verifier.indexOf('MASTER_ADMIN_CODE_INPUT_TOO_LARGE');
  const lockRead=verifier.indexOf("redis(['GET', key])");
  const compare=verifier.indexOf('timingSafeEqualText(supplied, MASTER_ADMIN_CODE)');
  assert.ok(bound>=0&&lockRead>bound);
  assert.ok(compare>bound);
  assert.ok(verifier.includes('incrementWithExpiry(key, MASTER_ADMIN_LOCK_SECONDS)'));
});

test('controller role transfer is atomic and refuses recovery while command queues are not drained',()=>{
  assert.ok(endpoint.includes('const recoveryScript = ['));
  assert.ok(endpoint.includes("local currentController = tostring(redis.call('GET', KEYS[1]) or '')"));
  assert.ok(endpoint.includes("local pendingCount = tonumber(redis.call('LLEN', KEYS[4]) or '0') or 0"));
  assert.ok(endpoint.includes("local processingCount = tonumber(redis.call('LLEN', KEYS[5]) or '0') or 0"));
  const drainGuard=endpoint.indexOf('if pendingCount > 0 or processingCount > 0 then');
  const roleWrite=endpoint.indexOf("redis.call('SET', KEYS[1], ARGV[2])");
  const sessionWrite=endpoint.indexOf("redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])");
  const epochWrite=endpoint.indexOf("redis.call('SET', KEYS[3], ARGV[5])");
  assert.ok(drainGuard>=0&&roleWrite>drainGuard);
  assert.ok(sessionWrite>roleWrite);
  assert.ok(epochWrite>sessionWrite);
  assert.ok(endpoint.includes("'CONTROLLER_RECOVERY_DRAIN_REQUIRED'"));
  assert.ok(endpoint.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(endpoint.includes("roleAssignmentKey(PREFIX, 'controller')"));
  assert.ok(endpoint.includes('KEY_PENDING'));
  assert.ok(endpoint.includes('KEY_PROCESSING'));
});

test('successful recovery rotates ownership, creates a fresh HttpOnly session and audits without the ADMIN code',()=>{
  assert.ok(endpoint.includes("kind: 'CONTROLLER_RECOVERED_BY_ADMIN'"));
  assert.ok(endpoint.includes("redis.call('LPUSH', KEYS[6], ARGV[6])"));
  assert.ok(endpoint.includes('setDeviceSessionCookie(res, token)'));
  const auditStart=endpoint.indexOf('const audit = {');
  const scriptStart=endpoint.indexOf('const recoveryScript = [');
  const auditBlock=endpoint.slice(auditStart,scriptStart);
  assert.equal(auditBlock.includes('adminCode'),false);
  assert.equal(endpoint.includes('MASTER_ADMIN_CODE'),false);
});

test('new-iPhone page asks only for ADMIN recovery and stores no ADMIN secret',()=>{
  assert.ok(page.includes('Code administrateur Zenith'));
  assert.ok(page.includes("type=\"password\""));
  assert.ok(page.includes("action=controller-recovery-admin"));
  assert.ok(page.includes('body:JSON.stringify({\n        adminCode,'));
  assert.ok(page.includes("localStorage.removeItem(DEVICE_TOKEN_KEY)"));
  assert.equal(page.includes('Code temporaire affiché sur l’iPad MASTER'),false);
  assert.equal(page.includes("localStorage.setItem('adminCode'"),false);
  assert.equal(page.includes('localStorage.setItem(ADMIN'),false);
});


test('main Zenith page exposes lost-iPhone recovery only when this device is not recognized',()=>{
  assert.ok(index.includes('id="replaceControllerBtn"'));
  assert.ok(index.includes('href="/replace-controller.html"'));
  assert.ok(index.includes('Reprendre le contrôle sur cet iPhone'));
  assert.ok(index.includes("replaceBtn.hidden=controllerIdentity.paired===true"));
});

test('lost-iPhone recovery path does not invoke PANIC, pause, resume or MASTER replacement',()=>{
  assert.equal(page.includes("action=emergency-stop"),false);
  assert.equal(page.includes("action=master-pause"),false);
  assert.equal(page.includes("action=master-resume"),false);
  assert.equal(page.includes("action=master-revoke"),false);
  assert.ok(page.includes("action=controller-recovery-admin"));
});
