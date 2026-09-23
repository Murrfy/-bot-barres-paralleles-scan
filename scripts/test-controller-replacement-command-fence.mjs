import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const replacementStart=sync.indexOf("if (action === 'controller-replacement-redeem' && req.method === 'POST')");
const replacementEnd=sync.indexOf("if (action === 'whoami' && req.method === 'GET')",replacementStart);
assert.ok(replacementStart>=0&&replacementEnd>replacementStart,'controller replacement redeem block missing');
const replacement=sync.slice(replacementStart,replacementEnd);

const commandStart=sync.indexOf("if (action === 'command' && req.method === 'POST')");
const commandEnd=sync.indexOf("if (action === 'command-next' && req.method === 'POST')",commandStart);
assert.ok(commandStart>=0&&commandEnd>commandStart,'controller command submit block missing');
const command=sync.slice(commandStart,commandEnd);

test('controller replacement atomically refuses a role switch while commands are pending or processing',()=>{
  assert.ok(replacement.includes("local pendingCount = redis.call('LLEN', KEYS[5])"));
  assert.ok(replacement.includes("local processingCount = redis.call('LLEN', KEYS[6])"));
  assert.ok(replacement.includes("if pendingCount > 0 or processingCount > 0 then"));
  assert.ok(replacement.includes("'EVAL', script, '6'"));
  assert.ok(replacement.includes('KEY_PENDING'));
  assert.ok(replacement.includes('KEY_PROCESSING'));
  assert.ok(replacement.includes("'CONTROLLER_REPLACEMENT_DRAIN_REQUIRED'"));
  assert.ok(
    replacement.indexOf("if pendingCount > 0 or processingCount > 0 then") <
    replacement.indexOf("redis.call('SET', KEYS[2], ARGV[1])")
  );
});

test('controller command enqueue atomically revalidates current controller and role epoch',()=>{
  assert.ok(command.includes("local currentController = tostring(redis.call('GET', KEYS[5]) or '')"));
  assert.ok(command.includes("if currentController ~= ARGV[6] then return {-5, currentController} end"));
  assert.ok(command.includes("local roleIssuedAt = tonumber(redis.call('GET', KEYS[6]) or '0') or 0"));
  assert.ok(command.includes("local sessionCreatedAt = tonumber(ARGV[7]) or 0"));
  assert.ok(command.includes("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return {-6, tostring(roleIssuedAt)} end"));
  assert.ok(command.includes("'EVAL', script, '6'"));
  assert.ok(command.includes('KEY_CONTROLLER_DEVICE'));
  assert.ok(command.includes("roleAssignmentKey(PREFIX, 'controller')"));
  assert.ok(command.includes('String(device.deviceId)'));
  assert.ok(command.includes('String(Number(device.createdAt || 0))'));
  assert.ok(command.includes("'CONTROLLER_ROLE_CHANGED'"));
  assert.ok(command.includes("'CONTROLLER_SESSION_REVOKED'"));
  assert.ok(
    command.indexOf("if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt") <
    command.indexOf("redis.call('LPUSH', KEYS[2], ARGV[2])")
  );
});

test('replacement command fence closes both race orderings',()=>{
  assert.ok(replacement.includes("redis.call('LLEN', KEYS[5])"));
  assert.ok(command.includes("currentController ~= ARGV[6]"));
  assert.ok(command.includes("sessionCreatedAt < roleIssuedAt"));
});
