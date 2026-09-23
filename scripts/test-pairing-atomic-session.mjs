import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const start=sync.indexOf("if (action === 'pair' && req.method === 'POST')");
const end=sync.indexOf("if (action === 'controller-replacement-authorize' && req.method === 'POST')",start);
assert.ok(start>=0&&end>start,'pairing action block missing');
const block=sync.slice(start,end);

test('pairing claims role, advances epoch and creates session in one Redis EVAL',()=>{
  assert.ok(block.includes('const pairSessionScript = ['));
  assert.ok(block.includes("local current = redis.call('GET', KEYS[1])"));
  assert.ok(block.includes("if current and current ~= ARGV[1] then return 0 end"));
  assert.ok(block.includes("redis.call('SET', KEYS[1], ARGV[1])"));
  assert.ok(block.includes("redis.call('SET', KEYS[2], ARGV[2])"));
  assert.ok(block.includes("redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])"));
  assert.ok(block.includes("'EVAL', pairSessionScript, '3'"));
  assert.ok(block.includes('roleDeviceKey(role)'));
  assert.ok(block.includes('roleAssignmentKey(PREFIX, role)'));
  assert.ok(block.includes('${PREFIX}:device:${tokenHash}'));
});

test('pairing no longer pre-claims the role outside the atomic session transaction',()=>{
  assert.equal(block.includes('await claimRoleDevice(role, deviceId)'),false);
  assert.equal(sync.includes('async function claimRoleDevice(role, deviceId)'),false);
  assert.ok(block.includes('const pairResult = Number(await redis(['));
  assert.ok(block.includes("if (pairResult !== 1)"));
  assert.ok(block.includes("code: 'ROLE_DEVICE_CONFLICT'"));
});

test('successful atomic pairing still emits the secure server session',()=>{
  assert.ok(block.includes('setDeviceSessionCookie(res, token)'));
  assert.ok(block.includes('sessionReady: true'));
});
