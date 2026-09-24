import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/zenith-sync.js','utf8');

function between(startMarker,endMarker){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing block '+startMarker);
  return source.slice(start,end);
}

const reenable=between("if (action === 'engine-reenable'","if (action === 'engine-bootstrap'");
const bootstrap=between("if (action === 'engine-bootstrap'","if (action === 'pair'");
const revoke=between("if (action === 'master-revoke'","if (action === 'master-pause'");

test('revoked 24/7 engine cannot silently bootstrap again',()=>{
  assert.ok(source.includes("const KEY_ENGINE_DISABLED = `${PREFIX}:engine-disabled`;"));
  assert.ok(bootstrap.includes("local disabled = tostring(redis.call('GET', KEYS[17]) or '')"));
  assert.ok(bootstrap.includes("if disabled == '1' then return {-7"));
  assert.ok(bootstrap.includes('KEY_ENGINE_DISABLED'));
  assert.ok(bootstrap.includes("'ENGINE_ADMIN_REENABLE_REQUIRED'"));
  const disabledCheck=bootstrap.indexOf("if disabled == '1'");
  const instanceWrite=bootstrap.indexOf("redis.call('SET', KEYS[4], ARGV[5]");
  assert.ok(disabledCheck>=0&&instanceWrite>disabledCheck);
});

test('MASTER revoke latches only the logical server engine',()=>{
  assert.ok(revoke.includes('KEY_ENGINE_DISABLED'));
  assert.ok(revoke.includes('ENGINE_MASTER_DEVICE_ID'));
  assert.ok(revoke.includes("if registered == ARGV[5] then redis.call('SET', KEYS[21], '1') end"));
  assert.ok(revoke.includes("'EVAL', revokeScript, '21'"));
  assert.ok(
    revoke.indexOf("if registered == ARGV[5] then redis.call('SET', KEYS[21], '1') end") <
    revoke.indexOf("redis.call('DEL', KEYS[1])")
  );
});

test('already-revoked cleanup cannot accidentally clear the engine disable latch',()=>{
  const already=between("const alreadyRevokedScript = [","if (currentMaster && String(currentMaster)");
  assert.equal(already.includes('KEY_ENGINE_DISABLED'),false);
  assert.equal(already.includes('engine-disabled'),false);
});

test('ADMIN re-enable is controller-only, explicit and fail-closed',()=>{
  assert.ok(reenable.includes("requireDevice(req, res, ['controller'])"));
  assert.ok(reenable.includes('verifyMasterAdminCode(req, res, device)'));
  for(const required of [
    'MASTER_STILL_REGISTERED',
    'MASTER_LEASE_ACTIVE',
    'MASTER_MUST_BE_PAUSED',
    'EMERGENCY_STOP_MUST_BE_ACTIVE',
    'PENDING_COMMAND',
    'PROCESSING_COMMAND',
    'USER_STREAM_MUTATION_IN_FLIGHT',
  ]) assert.ok(reenable.includes(required),required);
  assert.ok(reenable.includes("redis.call('DEL', KEYS[10])"));
  assert.ok(reenable.includes("kind:'ENGINE_ADMIN_REENABLED'"));
});

test('re-enable commit is fenced by current controller session and cannot bypass browser-origin protection',()=>{
  assert.ok(reenable.includes("if controller ~= ARGV[1] then return -1 end"));
  assert.ok(reenable.includes("if controllerEpoch > 0 and createdAt < controllerEpoch then return -2 end"));
  assert.ok(reenable.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(reenable.includes("roleAssignmentKey(PREFIX, 'controller')"));
  assert.ok(source.includes("const engineBootstrapRequest = action === 'engine-bootstrap' && req.method === 'POST';"));
  assert.equal(source.includes("action === 'engine-reenable' && req.method === 'POST';\n\n  if (!sameOriginMutation"),false);
});
