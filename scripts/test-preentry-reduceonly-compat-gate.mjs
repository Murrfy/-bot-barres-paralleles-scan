import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const entry=fs.readFileSync('api/binance-entry-execute.js','utf8');

test('real execution arm does not globally require LIMIT pre-entry compatibility',()=>{
  assert.match(sync,/ZENITH_PREENTRY_REDUCE_ONLY_STOP_COMPAT_VERIFIED === '1'/);
  const start=sync.indexOf("if (action === 'real-execution-arm'");
  const end=sync.indexOf("if (action === 'emergency-stop-clear'",start);
  assert.ok(start>=0&&end>start);
  const arm=sync.slice(start,end);
  assert.match(arm,/LIMIT_ONLY_PROTECTIVE_SELLS_AUDIT_REQUIRED/);
  assert.doesNotMatch(arm,/PREENTRY_REDUCE_ONLY_STOP_COMPAT_REQUIRED/);
  assert.match(arm,/REAL_TRADING_DISABLED/);
});

test('entry execution API requires compatibility proof only for LIMIT entry',()=>{
  assert.match(entry,/ZENITH_PREENTRY_REDUCE_ONLY_STOP_COMPAT_VERIFIED==='1'/);
  const marketDef=entry.indexOf("const marketEntry=type==='EXEC_OPEN_MARKET_POSITION'&&phase==='SUBMIT_MARKET_ENTRY'");
  const limitDef=entry.indexOf("const limitEntry=type==='EXEC_OPEN_POSITION'&&['PREPARE_PROTECTION','SUBMIT_ENTRY'].includes(phase)");
  const requestGate=entry.indexOf("if(limitEntry&&!PREENTRY_REDUCE_ONLY_STOP_COMPAT_VERIFIED)");
  const rateGate=entry.indexOf('entryExecutionRateAllowed',requestGate);
  const writeCall=entry.indexOf('placeStandardOrderIdempotent',requestGate);
  assert.ok(marketDef>=0&&limitDef>marketDef&&requestGate>limitDef);
  assert.ok(rateGate>requestGate&&writeCall>rateGate);
  assert.match(entry.slice(requestGate,rateGate),/PREENTRY_REDUCE_ONLY_STOP_COMPAT_REQUIRED/);
  assert.match(entry.slice(requestGate,rateGate),/writeAttempted:false/);
});

test('runtime status still exposes the LIMIT compatibility proof',()=>{
  assert.match(sync,/preEntryReduceOnlyStopCompatVerified: PREENTRY_REDUCE_ONLY_STOP_COMPAT_VERIFIED/);
  assert.match(sync,/preEntryReduceOnlyStopCompatVerified:true/);
});
