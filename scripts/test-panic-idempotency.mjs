import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/zenith-sync.js','utf8');
const start=source.indexOf("if (action === 'emergency-stop' && req.method === 'POST')");
const end=source.indexOf("if (action === 'emergency-stop-clear' && req.method === 'POST')",start);
assert.ok(start>=0&&end>start,'PANIC block missing');
const panic=source.slice(start,end);

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
  assert.ok(panic.includes("await redis(['SET', KEY_EMERGENCY_STOP, '1'])"));
});

test('PANIC remains immediately available without a rate-limit gate',()=>{
  assert.equal(/RATE_LIMIT|rateAllowed|incrementWithExpiry/.test(panic),false);
});
