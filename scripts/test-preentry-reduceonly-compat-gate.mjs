import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const entry=fs.readFileSync('api/binance-entry-execute.js','utf8');

test('real execution arm fails closed until pre-entry reduce-only STOP compatibility is explicitly verified',()=>{
  assert.match(sync,/ZENITH_PREENTRY_REDUCE_ONLY_STOP_COMPAT_VERIFIED === '1'/);
  const start=sync.indexOf("if (action === 'real-execution-arm'");
  const end=sync.indexOf("if (action === 'emergency-stop-clear'",start);
  assert.ok(start>=0&&end>start);
  const arm=sync.slice(start,end);
  const audit=arm.indexOf('LIMIT_ONLY_PROTECTIVE_SELLS_AUDIT_REQUIRED');
  const compat=arm.indexOf('PREENTRY_REDUCE_ONLY_STOP_COMPAT_REQUIRED');
  const real=arm.indexOf('REAL_TRADING_DISABLED');
  assert.ok(audit>=0&&compat>audit&&real>compat);
});

test('entry execution API independently refuses writes without compatibility proof',()=>{
  assert.match(entry,/ZENITH_PREENTRY_REDUCE_ONLY_STOP_COMPAT_VERIFIED==='1'/);
  const requestGate=entry.indexOf("code:'PREENTRY_REDUCE_ONLY_STOP_COMPAT_REQUIRED'");
  const rateGate=entry.indexOf('entryExecutionRateAllowed',requestGate);
  const writeCall=entry.indexOf('placeStandardOrderIdempotent',requestGate);
  assert.ok(requestGate>=0&&rateGate>requestGate&&writeCall>rateGate);
  assert.match(entry,/writeAttempted:false/);
});

test('runtime status and arm record expose the compatibility proof',()=>{
  assert.match(sync,/preEntryReduceOnlyStopCompatVerified: PREENTRY_REDUCE_ONLY_STOP_COMPAT_VERIFIED/);
  assert.match(sync,/preEntryReduceOnlyStopCompatVerified:true/);
});
