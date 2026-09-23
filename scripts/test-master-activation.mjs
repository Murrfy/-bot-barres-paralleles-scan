import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const index=fs.readFileSync('index.html','utf8');

const start=sync.indexOf("if (action === 'master-authorize' && req.method === 'POST')");
const end=sync.indexOf("if (action === 'master-heartbeat' && req.method === 'POST')",start);
assert.ok(start>=0&&end>start,'MASTER authorize block missing');
const block=sync.slice(start,end);

test('MASTER activation is controller-only and ADMIN protected',()=>{
  assert.ok(block.includes("requireDevice(req, res, ['controller'])"));
  assert.ok(block.includes('verifyMasterAdminCode(req, res, device)'));
  assert.ok(block.indexOf('verifyMasterAdminCode') < block.indexOf('masterActivationKey(masterDevice)'));
});

test('MASTER activation remains short-lived and one-shot',()=>{
  assert.ok(sync.includes('MASTER_ACTIVATION_TTL_SECONDS = 120'));
  assert.ok(block.includes("masterActivationKey(masterDevice)"));
  assert.ok(block.includes("String(MASTER_ACTIVATION_TTL_SECONDS)"));
  const acquireStart=sync.indexOf('async function acquireOrRenewMaster');
  const acquireEnd=sync.indexOf('\n}',acquireStart)+2;
  const acquire=sync.slice(acquireStart,acquireEnd);
  assert.ok(acquire.includes("redis.call('DEL', KEYS[2])"),'activation token must be consumed');
  assert.ok(acquire.includes("redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])"),'MASTER lease must stay TTL-bound');
});

test('iPhone controller exposes explicit ADMIN-protected MASTER activation control',()=>{
  assert.ok(index.includes('id="masterAuthorizeBtn"'));
  assert.ok(index.includes('async function controllerAuthorizeMaster()'));
  assert.ok(index.includes("prompt('Code ADMIN MASTER pour autoriser l’iPad MASTER :')"));
  assert.ok(index.includes("action=master-authorize"));
  assert.ok(index.includes('body:JSON.stringify({adminCode})'));
  assert.ok(index.includes("masterControlState.masterRegistered!==true||masterControlState.masterLeaseActive===true"));
  assert.ok(index.includes("$('masterAuthorizeBtn').onclick=controllerAuthorizeMaster"));
});
