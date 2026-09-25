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
      orderClass:'STANDARD',symbol:'BTCUSDT',clientOrderId:'zth-ENT-abcdef123456789012345678',
      side:'BUY',positionSide:'BOTH',type:'LIMIT',reduceOnly:false,closePosition:false,
    }],
    userStream:{connected:true,ready:false,failClosed:true,needsReconciliation:true},
  };
  const runtime={updatedAt:Date.now(),masterDeviceId:'master-1',data};
  const report={
    version:2,status:'MISMATCH',failClosed:true,
    reasons:['ENTRY_TRANSITION_PROTECTION_MISSING'],
    observedAt:Date.now(),
    runtimeDataHash:hash(stableStringify(data)),
    differences:{entryTransitions:{missingProtectionPendingEntries:[]}},
  };
  return {runtime,report};
}

test('ordinary protective writes stay blocked while user stream is fail-closed',()=>{
  const {runtime,report}=fixtures();
  assert.equal(executionReadiness(runtime,report,'master-1','',''), 'USER_STREAM_NOT_READY');
});

test('exact pending-entry cancel recovery can pass a connected fail-closed stream only after exact report proof',()=>{
  const {runtime,report}=fixtures();
  assert.equal(executionReadiness(runtime,report,'master-1','',true),'');
  assert.equal(
    executionReadiness(runtime,{...report,runtimeDataHash:'bad'},'master-1','',true),
    'BINANCE_RECONCILIATION_RUNTIME_CHANGED'
  );
  assert.equal(
    executionReadiness({...runtime,updatedAt:Date.now()-31000},report,'master-1','',true),
    'MASTER_RUNTIME_STALE'
  );
});

test('handler wires cancel recovery only through exact classifier and engine principal',async()=>{
  const source=await readFile(new URL('../api/binance-protective-execute.js',import.meta.url),'utf8');
  assert.match(source,/pendingEntryProtectionLossCancelAllowed\(report,/);
  assert.match(source,/type==='EXEC_CANCEL_ENTRY'/);
  assert.match(source,/pendingEntryCancelRecovery&&String\(master\?\.principal\|\|''\)!=='engine'/);
  assert.match(source,/ENTRY_PROTECTION_RECOVERY_ENGINE_REQUIRED/);
});
