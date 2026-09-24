import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const pauseStart=sync.indexOf('async function tryFinalizePendingPause');
const pauseEnd=sync.indexOf('async function recoverStaleProcessing',pauseStart);
assert.ok(pauseStart>=0&&pauseEnd>pauseStart,'pending pause helper missing');
const pause=sync.slice(pauseStart,pauseEnd);

const commandStart=sync.indexOf("if (action === 'command' && req.method === 'POST')");
const commandEnd=sync.indexOf("if (action === 'command-next' && req.method === 'POST')",commandStart);
assert.ok(commandStart>=0&&commandEnd>commandStart,'command enqueue block missing');
const command=sync.slice(commandStart,commandEnd);

test('PAUSE_PENDING to PAUSED commit is one Redis transaction with empty queues',()=>{
  assert.ok(pause.includes('const finalizeScript = ['));
  assert.ok(pause.includes("if mode ~= 'PAUSE_PENDING' then return {-1, mode, pending, processing} end"));
  assert.ok(pause.includes("if pending > 0 then return {-2, mode, pending, processing} end"));
  assert.ok(pause.includes("if processing > 0 then return {-3, mode, pending, processing} end"));
  assert.ok(pause.includes("redis.call('SET', KEYS[1], 'PAUSED')"));
  assert.ok(pause.indexOf("if pending > 0") < pause.indexOf("redis.call('SET', KEYS[1], 'PAUSED')"));
  assert.ok(pause.indexOf("if processing > 0") < pause.indexOf("redis.call('SET', KEYS[1], 'PAUSED')"));
  assert.equal(pause.includes("await setMasterMode('PAUSED')"),false);
});

test('real pause finalization revalidates MASTER lease role epoch runtime and clean reconciliation',()=>{
  for(const required of [
    "if lease ~= ARGV[1] or registered ~= ARGV[1] then return {-4, mode, pending, processing} end",
    "if roleEpoch == '' or roleEpoch ~= ARGV[2] then return {-5, mode, pending, processing} end",
    "if runtimeRaw ~= ARGV[4] then return {-6, mode, pending, processing} end",
    "if not reconcileRaw then return {-7, mode, pending, processing} end",
    "if type(reasons) ~= 'table' or type(actual) ~= 'table' then return {-7, mode, pending, processing} end",
    "report['failClosed'] ~= false",
    "status ~= 'CLEAN_REAL' and status ~= 'CLEAN_IDLE'",
    "tonumber(actual['positions'] or -1) ~= 0",
    "tonumber(actual['orders'] or -1) ~= 0",
    'KEY_RECONCILE_LAST',
    'KEY_STATE',
    "roleAssignmentKey(PREFIX, 'master')",
  ]) assert.ok(pause.includes(required),required);
});

test('pause completion audit is committed atomically with PAUSED mode',()=>{
  assert.ok(pause.includes("redis.call('LPUSH', KEYS[4], ARGV[5])"));
  assert.ok(pause.includes("redis.call('LTRIM', KEYS[4], 0, 199)"));
  assert.ok(pause.includes("kind: 'MASTER_PAUSE_COMPLETED'"));
});

test('late protective enqueue and final pause are serialized without a stranded command window',()=>{
  assert.ok(command.includes("local mode = tostring(redis.call('GET', KEYS[3]) or 'PAUSED')"));
  assert.ok(command.includes("if mode == 'PAUSED' then return {-2, mode} end"));
  assert.ok(command.includes("redis.call('LPUSH', KEYS[2], ARGV[2])"));
  assert.ok(command.includes("'EVAL', script, '6'"));
  assert.ok(pause.includes("'EVAL', finalizeScript, '9'"));
});

test('queue/runtime races leave mode fail-closed instead of forcing PAUSED',()=>{
  assert.ok(pause.includes("raceBlockers.push('PENDING_COMMAND')"));
  assert.ok(pause.includes("raceBlockers.push('PROCESSING_COMMAND')"));
  assert.ok(pause.includes("raceBlockers.push('MASTER_RUNTIME_CHANGED')"));
  assert.ok(pause.includes("raceBlockers.push('BINANCE_RECONCILIATION_CHANGED')"));
  assert.ok(pause.includes("masterMode: resultCode === -1 ? committedMode : 'PAUSE_PENDING'"));
});
