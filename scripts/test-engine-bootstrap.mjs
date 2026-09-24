import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/zenith-sync.js','utf8');

function between(startMarker,endMarker){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing source block '+startMarker);
  return source.slice(start,end);
}

const bootstrap=between("if (action === 'engine-bootstrap'","if (action === 'pair'");
const requireDevice=between('async function requireDevice','async function renewEngineInstance');
const renew=between('async function renewEngineInstance','async function masterDeviceId');
const heartbeat=between("if (action === 'master-heartbeat'","if (action === 'master' && req.method === 'GET')");

test('server engine bootstrap is the only mutation allowed to authenticate outside browser same-origin',()=>{
  assert.ok(source.includes("const engineBootstrapRequest = action === 'engine-bootstrap' && req.method === 'POST';"));
  assert.ok(source.includes('if (!sameOriginMutation(req) && !engineBootstrapRequest)'));
  assert.ok(bootstrap.includes('verifyEngineBootstrapSecret(req, res)'));
  assert.ok(bootstrap.includes('engineBootstrapRateAllowed(req)'));
  assert.ok(source.includes('const ENGINE_BOOTSTRAP_RATE_LIMIT = 5;'));
  assert.ok(source.includes('const ENGINE_BOOTSTRAP_GLOBAL_RATE_LIMIT = 30;'));
});

test('engine bootstrap secret is high-entropy and distinct from existing auth secrets',()=>{
  const policy=between('function engineBootstrapSecretPolicyBlockers','function pairingSecretPolicyBlockers');
  assert.ok(policy.includes("secret.length < 32"));
  assert.ok(policy.includes("'ENGINE_BOOTSTRAP_SECRET_TOO_WEAK'"));
  assert.ok(policy.includes("'ENGINE_BOOTSTRAP_SECRET_REUSED'"));
  assert.ok(source.includes("const ENGINE_BOOTSTRAP_SECRET = process.env.ZENITH_ENGINE_BOOTSTRAP_SECRET || '';"));
  assert.equal(bootstrap.includes('ENGINE_BOOTSTRAP_SECRET'),false,'bootstrap response/audit block must not reference the raw secret');
});

test('first server cutover cannot steal an iPad MASTER and requires fail-closed paused panic state',()=>{
  assert.ok(bootstrap.includes("registeredMaster ~= '' and registeredMaster ~= ARGV[1]"));
  assert.ok(bootstrap.includes("'ENGINE_CUTOVER_REQUIRED'"));
  assert.ok(bootstrap.includes("registeredMaster == '' and mode ~= 'PAUSED'"));
  assert.ok(bootstrap.includes("registeredMaster == '' and panic ~= '1'"));
  assert.ok(bootstrap.includes("'ENGINE_INITIAL_CUTOVER_NOT_SAFE'"));
  assert.ok(bootstrap.includes("'MASTER_MUST_BE_PAUSED'"));
  assert.ok(bootstrap.includes("'EMERGENCY_STOP_MUST_BE_ACTIVE'"));
});

test('engine bootstrap atomically fences concurrent instances and rotates MASTER role epoch',()=>{
  assert.ok(source.includes("const KEY_ENGINE_INSTANCE = \`\${PREFIX}:engine-instance\`;"));
  assert.ok(source.includes('const ENGINE_INSTANCE_TTL_SECONDS = 45;'));
  assert.ok(bootstrap.includes("currentInstance ~= '' and currentInstance ~= ARGV[5]"));
  assert.ok(bootstrap.includes("'ENGINE_INSTANCE_ACTIVE'"));
  const instanceWrite=bootstrap.indexOf("redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[6])");
  const roleWrite=bootstrap.indexOf("redis.call('SET', KEYS[1], ARGV[1])");
  const epochWrite=bootstrap.indexOf("redis.call('SET', KEYS[2], ARGV[2])");
  const sessionWrite=bootstrap.indexOf("redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])");
  assert.ok(instanceWrite>=0&&roleWrite>instanceWrite&&epochWrite>roleWrite&&sessionWrite>epochWrite);
  assert.ok(bootstrap.includes("principal: 'engine'"));
  assert.ok(bootstrap.includes('engineInstanceId: instanceId'));
});

test('engine session requests are fenced by the current instance before session touch',()=>{
  const roleCheck=requireDevice.indexOf('verifyRoleDevice(device.role, device)');
  const engineCheck=requireDevice.indexOf("if (device.principal === 'engine')");
  const touch=requireDevice.indexOf('touchDevice(device)');
  assert.ok(roleCheck>=0&&engineCheck>roleCheck&&touch>engineCheck);
  assert.ok(requireDevice.includes('engineInstanceHeader(req)'));
  assert.ok(requireDevice.includes("redis(['GET', KEY_ENGINE_INSTANCE])"));
  assert.ok(requireDevice.includes("'ENGINE_INSTANCE_FENCED'"));
});

test('MASTER heartbeat renews only the same engine instance and exact restart epoch',()=>{
  assert.ok(renew.includes("currentInstance ~= ARGV[1]"));
  assert.ok(renew.includes("registeredMaster ~= ARGV[2]"));
  assert.ok(renew.includes("roleEpoch ~= ARGV[3]"));
  assert.ok(renew.includes("redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])"));
  assert.ok(heartbeat.includes("if (device.principal === 'engine')"));
  assert.ok(heartbeat.includes('renewEngineInstance(device)'));
  assert.ok(heartbeat.includes('clearDeviceSessionCookie(res)'));
});
