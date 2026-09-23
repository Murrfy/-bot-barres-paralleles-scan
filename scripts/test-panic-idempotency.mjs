import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/zenith-sync.js','utf8');
const start=source.indexOf("if (action === 'emergency-stop' && req.method === 'POST')");
const end=source.indexOf("if (action === 'emergency-stop-clear' && req.method === 'POST')",start);
assert.ok(start>=0&&end>start,'PANIC block missing');
const panic=source.slice(start,end);
const clearStart=end;
const clearEnd=source.indexOf("if (action === 'audit' && req.method === 'GET')",clearStart);
assert.ok(clearEnd>clearStart,'PANIC clear block missing');
const clear=source.slice(clearStart,clearEnd);

test('repeated PANIC is idempotent and does not flood audit history',()=>{
  assert.ok(panic.includes('emergencyStopActive()'));
  assert.ok(panic.includes("currentMode !== 'RUNNING'"));
  assert.ok(panic.includes('alreadyActive: true'));
  const repeatedGuard=panic.indexOf("if (wasActive && currentMode !== 'RUNNING')");
  const auditWrite=panic.indexOf("redis(['LPUSH', KEY_AUDIT");
  assert.ok(repeatedGuard>=0,'repeated PANIC guard missing');
  assert.ok(auditWrite>repeatedGuard,'audit write must happen only after repeated PANIC early return');
});

test('PANIC still reasserts safety if stop is active but MASTER is unexpectedly running',()=>{
  assert.ok(panic.includes("kind: wasActive ? 'EMERGENCY_STOP_REASSERTED' : 'EMERGENCY_STOP_SET'"));
  assert.ok(panic.includes("await setMasterMode('PAUSE_PENDING')"));
  assert.ok(panic.includes('const panicEpoch = await assertEmergencyStop()'));
  assert.ok(source.includes("redis.call('SET', KEYS[1], '1')"));
  assert.ok(source.includes("redis.call('INCR', KEYS[2])"));
});

test('PANIC remains immediately available without a rate-limit gate',()=>{
  assert.equal(/RATE_LIMIT|rateAllowed|incrementWithExpiry/.test(panic),false);
});


test('every PANIC assertion advances an epoch before a clear can succeed',()=>{
  assert.ok(source.includes('const KEY_EMERGENCY_STOP_EPOCH'));
  assert.ok(source.includes('async function assertEmergencyStop()'));
  assert.ok(source.includes("redis.call('INCR', KEYS[2])"));
  assert.ok(panic.includes('const panicEpoch = await assertEmergencyStop()'));
  assert.ok(panic.includes('panicEpoch'));
});

test('PANIC clear is fenced against a concurrent new PANIC assertion',()=>{
  assert.ok(clear.includes("redis(['GET', KEY_EMERGENCY_STOP_EPOCH])"));
  assert.ok(clear.includes("const panicEpoch = String(panicEpochRaw || '0')"));
  assert.ok(clear.includes("local epoch = tostring(redis.call('GET', KEYS[2]) or '0')"));
  assert.ok(clear.includes("if epoch ~= ARGV[1] then return -1 end"));
  assert.ok(clear.includes("'EMERGENCY_STOP_CHANGED_DURING_CLEAR'"));
  assert.ok(clear.indexOf("if epoch ~= ARGV[1] then return -1 end") < clear.indexOf("redis.call('SET', KEYS[1], '0')"));
});

test('PANIC clear revalidates PAUSED mode and MASTER ownership atomically',()=>{
  assert.ok(clear.includes("if mode ~= 'PAUSED' then return -3 end"));
  assert.ok(clear.includes("if lease ~= ARGV[2] or registered ~= ARGV[2] then return -4 end"));
  assert.ok(clear.includes('KEY_MASTER_MODE'));
  assert.ok(clear.includes('KEY_MASTER'));
  assert.ok(clear.includes('KEY_MASTER_DEVICE'));
});
