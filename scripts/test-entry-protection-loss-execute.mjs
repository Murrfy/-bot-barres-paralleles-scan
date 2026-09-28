import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { executionReadiness } from '../api/binance-protective-execute.js';

function stableStringify(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>v===undefined?'null':stableStringify(v)).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableStringify(value[k])).join(',')+'}';
}
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');

function fixtures(){
  const data={
    executionMode:'REAL',
    binancePositions:[],
    binanceOrders:[{
      orderClass:'STANDARD',symbol:'BTCUSDT',
      clientOrderId:'zth-ENT-abcdef123456789012345678',
      side:'BUY',positionSide:'BOTH',type:'LIMIT',reduceOnly:false,closePosition:false,
    }],
    userStream:{connected:true,ready:false,failClosed:true,needsReconciliation:true},
  };
  const runtime={updatedAt:Date.now(),masterDeviceId:'master-1',data};
  const report={
    version:2,status:'MISMATCH',failClosed:true,
    reasons:['ENTRY_TRANSITION_PROTECTION_MISSING'],
    observedAt:Date.now(),runtimeDataHash:hash(stableStringify(data)),
    differences:{entryTransitions:{missingProtectionPendingEntries:[]}},
  };
  return {runtime,report};
}

test('ordinary protective writes stay blocked while stream is fail-closed',()=>{
  const {runtime,report}=fixtures();
  assert.equal(executionReadiness(runtime,report,'master-1','',''), 'USER_STREAM_NOT_READY');
});

test('exact pending-entry cancel can pass connected fail-closed stream only with fresh exact report',()=>{
  const {runtime,report}=fixtures();
  assert.equal(executionReadiness(runtime,report,'master-1','',true),'');
  assert.equal(
    executionReadiness(runtime,{...report,runtimeDataHash:'bad'},'master-1','',true),
    'BINANCE_RECONCILIATION_RUNTIME_CHANGED'
  );
});

test('handler wires entry cancel recovery only through exact classifiers and engine principal',async()=>{
  const source=await readFile(new URL('../api/binance-protective-execute.js',import.meta.url),'utf8');
  assert.match(source,/pendingEntryCancelRecoveryAllowed\(report,/);
  assert.match(source,/pendingEntryPartialFillFlatTargets\(report\)/);
  assert.match(source,/type==='EXEC_CANCEL_ENTRY'/);
  assert.match(source,/ENTRY_PROTECTION_RECOVERY_ENGINE_REQUIRED/);
  assert.match(source,/ENTRY_PARTIAL_FILL_FLAT_RECOVERY_ENGINE_REQUIRED/);
});

test('flat partial-entry cancel proves terminal entry and certified flat before clearing transition',async()=>{
  const source=await readFile(new URL('../api/binance-protective-execute.js',import.meta.url),'utf8');
  const start=source.indexOf("if(type==='EXEC_CANCEL_ENTRY')");
  const end=source.indexOf("const symbol=String(req.body?.symbol||'').toUpperCase();",start+30);
  assert.ok(start>=0&&end>start);
  const block=source.slice(start,end);
  const cancelAt=block.indexOf('cancelEntryOrderIdempotent({');
  const terminalAt=block.indexOf("const terminal=['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status)",cancelAt);
  const flatAt=block.indexOf('liveBinancePositionQuantity({',terminalAt);
  const clearAt=block.indexOf('clearPartialEntryTransitionAfterCertifiedFlat(partialEntryFlatTarget)',flatAt);
  assert.ok(cancelAt>=0&&terminalAt>cancelAt&&flatAt>terminalAt&&clearAt>flatAt);
  assert.match(block,/status==='FILLED'\|\|disposition==='ALREADY_FILLED'/);
  assert.match(block,/liveQty>1e-12/);
  assert.match(block,/transitionCleared:false/);
  assert.match(block,/protectionCleanupRequired:partialEntryFlatTarget\.protectionPresent===true/);
});

test('flat partial-entry transition clear is exact and atomic, never a broad Redis delete',async()=>{
  const source=await readFile(new URL('../api/binance-protective-execute.js',import.meta.url),'utf8');
  const start=source.indexOf('async function clearPartialEntryTransitionAfterCertifiedFlat');
  const end=source.indexOf('async function requireCurrentMaster',start);
  const block=source.slice(start,end);
  assert.match(block,/HGET/);
  assert.match(block,/ENTRY_SUBMITTED/);
  assert.match(block,/entryClientOrderId/);
  assert.match(block,/protectionClientAlgoId/);
  assert.match(block,/HDEL/);
  assert.match(block,/KEY_ENTRY_TRANSITIONS/);
});


test('worker cancels flat partial entry before write-ahead and restarts a fresh pass for orphan cleanup',async()=>{
  const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');
  assert.match(worker,/pendingEntryCancelRecoveryTargets/);
  const reconcileStart=worker.indexOf('async function reconcile(secondPass=false)');
  const reconcileEnd=worker.indexOf('async function awaitReconciliation',reconcileStart);
  const block=worker.slice(reconcileStart,reconcileEnd);
  const cancelAt=block.indexOf('pendingEntryCancelRecoveryTargets(data.report)');
  const writeAheadAt=block.indexOf('pendingEntryWriteAheadRecoveryTargets(data.report)',cancelAt);
  const orphanAt=block.indexOf('orphanZenithCleanupOrders(data.report)',writeAheadAt);
  assert.ok(cancelAt>=0&&writeAheadAt>cancelAt&&orphanAt>writeAheadAt);
  assert.match(block,/partialFillFlatRecovery\?false:true/);
  assert.match(worker,/ENTRY_PARTIAL_FILL_FLAT_CANCELED/);
  assert.match(worker,/ENTRY_PARTIAL_FILL_FLAT_RACE/);
});
