import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const index=fs.readFileSync('index.html','utf8');

const start=sync.indexOf("if (action === 'master-revoke' && req.method === 'POST')");
const end=sync.indexOf("if (action === 'master-pause' && req.method === 'POST')",start);
assert.ok(start>=0&&end>start,'MASTER revoke block missing');
const block=sync.slice(start,end);

test('MASTER revoke is controller-only and ADMIN protected',()=>{
  assert.ok(block.includes("requireDevice(req, res, ['controller'])"));
  assert.ok(block.includes('verifyMasterAdminCode(req, res, device)'));
});

test('MASTER revoke fails closed before invalidating an active MASTER',()=>{
  assert.ok(block.includes("redis(['SET', KEY_EMERGENCY_STOP, '1'])"));
  assert.ok(block.includes("setMasterMode('PAUSE_PENDING')"));
  assert.ok(block.includes("tryFinalizePendingPause(currentMaster, 'PAUSE_PENDING')"));
  assert.ok(block.includes("'MASTER_REVOKE_DRAIN_REQUIRED'"));
  assert.ok(block.indexOf("'MASTER_REVOKE_DRAIN_REQUIRED'") < block.indexOf("const revokeScript = ["));
});

test('MASTER revoke destroys real execution authority and stale MASTER state atomically',()=>{
  for(const required of [
    'KEY_REAL_EXECUTION_ARMED',
    'KEY_MASTER',
    'KEY_MASTER_HEARTBEAT',
    'KEY_MASTER_CONFIG_ACK',
    'KEY_RECONCILE_LAST',
    'KEY_STATE',
    'KEY_USER_STREAM_SESSION',
    "roleAssignmentKey(PREFIX, 'master')",
    'KEY_MASTER_DEVICE',
    "'MASTER_REVOKED'",
  ]) assert.ok(block.includes(required),required);
});

test('iPhone controller exposes explicit confirmed MASTER revoke control',()=>{
  assert.ok(index.includes('id="masterRevokeBtn"'));
  assert.ok(index.includes('async function controllerRevokeMaster()'));
  assert.ok(index.includes("action=master-revoke"));
  assert.ok(index.includes("confirm('Révoquer le MASTER ?"));
  assert.ok(index.includes("prompt('Code ADMIN MASTER pour révoquer le MASTER :')"));
  assert.ok(index.includes("$('masterRevokeBtn').onclick=controllerRevokeMaster"));
});
