import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { orphanZenithCleanupOrders, expiredEntryOrphanProtections, maxLossSymbolIsQuarantined } from '../lib/protective-command.mjs';
import { executionReadiness } from '../api/binance-protective-execute.js';

function stableStringify(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>v===undefined?'null':stableStringify(v)).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableStringify(value[k])).join(',')+'}';
}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}

function report(rows,reasons=['ORPHAN_ZENITH_PROTECTIVE_ORDER']){
  return {
    version:2,status:'MISMATCH',failClosed:true,reasons,
    differences:{orphanZenithProtectiveOrders:rows}
  };
}

const standard={
  orderClass:'STANDARD',symbol:'BTCUSDT',clientOrderId:'zth-EXI-0123456789abcdef01234567',
  side:'SELL',positionSide:'BOTH',type:'LIMIT',reduceOnly:true,closePosition:false,
  price:'51000',timeInForce:'GTC'
};
const algo={
  orderClass:'ALGO',symbol:'BTCUSDT',clientAlgoId:'zth-PRO-0123456789abcdef01234567',
  side:'SELL',positionSide:'BOTH',type:'STOP',reduceOnly:true,closePosition:false,
  price:'50500',triggerPrice:'50500',timeInForce:'GTC'
};

const maxLoss={
  orderClass:'ALGO',symbol:'BTCUSDT',clientAlgoId:'zth-MAX-fedcba9876543210fedcba98',
  side:'SELL',positionSide:'BOTH',type:'STOP',reduceOnly:true,closePosition:false,
  triggerPrice:'49600',priceMatch:'OPPONENT',origQty:'1',timeInForce:'IOC'
};


test('cleanup targets are accepted only for the exact orphan-only reconciliation state',()=>{
  assert.equal(orphanZenithCleanupOrders(report([standard])).length,1);
  assert.equal(orphanZenithCleanupOrders(report([algo])).length,1);
  assert.deepEqual(orphanZenithCleanupOrders(report([standard],[
    'ORPHAN_ZENITH_PROTECTIVE_ORDER','RUNTIME_STATE_STALE'
  ])),[]);
});

test('full close keeps every Zenith exit/protection in the exact orphan cleanup set',()=>{
  const rows=orphanZenithCleanupOrders(report([standard,maxLoss,algo]));
  assert.equal(rows.length,3);
  assert.deepEqual(
    rows.map(row=>row.orderClass==='ALGO'?row.clientAlgoId:row.clientOrderId),
    [standard.clientOrderId,maxLoss.clientAlgoId,algo.clientAlgoId]
  );
});

test('external or malformed order ids are never eligible for automatic cleanup',()=>{
  assert.deepEqual(orphanZenithCleanupOrders(report([{...standard,clientOrderId:'manual-exit'}])),[]);
  assert.deepEqual(orphanZenithCleanupOrders(report([{...algo,clientAlgoId:'manual-stop'}])),[]);
});

test('orphan cleanup endpoint requires direct Binance flat-position proof before cancellation',async()=>{
  const api=await readFile(new URL('../api/binance-protective-update-execute.js',import.meta.url),'utf8');
  assert.match(api,/EXEC_CLEAN_ORPHAN_PROTECTION/);
  assert.match(api,/\/fapi\/v3\/positionRisk/);
  assert.match(api,/DIRECT_POSITION_PROOF_MISSING/);
  assert.match(api,/ORPHAN_CLEANUP_POSITION_NOT_FLAT/);
  assert.match(api,/cancelReduceOnlyOrderIdempotent/);
  assert.match(api,/cancelAlgoOrderIdempotent/);
});

test('24/7 server only auto-cleans report-confirmed orphan targets and waits for stream terminal proof',async()=>{
  const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');
  assert.match(worker,/orphanZenithCleanupOrders\(data\.report\)/);
  assert.match(worker,/for\(const target of orphanTargets\)/);
  assert.match(worker,/EXEC_CLEAN_ORPHAN_PROTECTION/);
  assert.match(worker,/waitForStreamOrder\(\{/);
  assert.match(worker,/ORPHAN_CLEANUP_STREAM_NOT_CONFIRMED/);
});

test('UI distinguishes private account access from public Binance market data',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/COMPTE BINANCE INACCESSIBLE/);
  assert.match(html,/prix publics Binance disponibles · compte Futures privé inaccessible/);
  assert.doesNotMatch(html,/BINANCE HORS LIGNE/);
});


function localReport(rows,symbol='BTCUSDT'){
  return {
    version:2,status:'CLEAN_REAL_WITH_QUARANTINES',failClosed:false,reasons:[],
    symbolQuarantines:[
      {symbol,direction:'LONG',reason:'ORPHAN_PROTECTION_CLEANUP_PENDING',remainingQuantity:null,since:1700000000000},
      {symbol,direction:'SHORT',reason:'ORPHAN_PROTECTION_CLEANUP_PENDING',remainingQuantity:null,since:1700000000000},
    ],
    differences:{orphanZenithProtectiveOrders:rows,entryTransitions:{expiredProtectionOnly:[]}}
  };
}

test('localized orphan quarantine blocks both directions and remains eligible for exact cleanup',()=>{
  const local=localReport([standard]);
  assert.equal(maxLossSymbolIsQuarantined(local,'BTCUSDT','LONG'),true);
  assert.equal(maxLossSymbolIsQuarantined(local,'BTCUSDT','SHORT'),true);
  assert.equal(orphanZenithCleanupOrders(local).length,1);
  assert.deepEqual(orphanZenithCleanupOrders(localReport([standard],'ETHUSDT')),[]);
});

test('expired entry orphan metadata survives localized cleanup state',()=>{
  const maxLoss={
    orderClass:'ALGO',symbol:'BTCUSDT',clientAlgoId:'zth-MAX-0123456789abcdef01234567',
    side:'SELL',positionSide:'BOTH',type:'STOP',reduceOnly:true,closePosition:false,
    triggerPrice:'49600',priceMatch:'OPPONENT',origQty:'1',timeInForce:'IOC'
  };
  const local=localReport([maxLoss]);
  local.differences.entryTransitions.expiredProtectionOnly=[{
    state:'PROTECTION_PREPARED',commandId:'auto-entry-BTCUSDT-12345678',
    symbol:'BTCUSDT',direction:'LONG',quantity:1,protectionTriggerPrice:49600,
    protectionClientAlgoId:maxLoss.clientAlgoId,entryClientOrderId:'',expiresAt:1700000001000
  }];
  const rows=expiredEntryOrphanProtections(local);
  assert.equal(rows.length,1);
  assert.equal(rows[0].protectionClientAlgoId,maxLoss.clientAlgoId);
});

test('server worker keeps localized orphan cleanup failures local but legacy mismatch failures global',async()=>{
  const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');
  const helperStart=worker.indexOf('async function markOrphanCleanupFailure');
  const helperEnd=worker.indexOf('async function waitForWriteAheadEntryEvidence',helperStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart);
  const helper=worker.slice(helperStart,helperEnd);
  assert.match(helper,/symbolOrphanCleanupQuarantined\(wanted\)/);
  assert.match(helper,/await publishRuntime\(\)\.catch/);
  assert.match(helper,/await invalidateStream\(code\)\.catch/);
  assert.match(helper,/scheduleReconcile\(1500\)/);

  const reconcileStart=worker.indexOf('const orphanTargets=orphanZenithCleanupOrders(data.report)');
  const reconcileEnd=worker.indexOf('const repairTarget=missingMaxLossRepairTarget',reconcileStart);
  const block=worker.slice(reconcileStart,reconcileEnd);
  assert.match(block,/markOrphanCleanupFailure\([\s\S]*ORPHAN_CLEANUP_RECONCILIATION_FAILED/);
  assert.match(block,/markOrphanCleanupFailure\(reason,target\.symbol\)/);
  assert.match(block,/markOrphanCleanupFailure\('ORPHAN_CLEANUP_STREAM_NOT_CONFIRMED',target\.symbol\)/);
});


test('orphan cleanup quarantine blocks re-entry on the same symbol but not another clean symbol',()=>{
  const now=Date.now();
  const data={
    executionMode:'REAL',
    userStream:{connected:true,ready:true,failClosed:false,needsReconciliation:false},
  };
  const runtimeState={masterDeviceId:'engine-master',updatedAt:now,data};
  const local=localReport([standard]);
  local.observedAt=now;
  local.runtimeDataHash=sha256(stableStringify(data));

  assert.equal(
    executionReadiness(runtimeState,local,'engine-master','',false,false,'BTCUSDT:LONG',false),
    'SYMBOL_MAX_LOSS_QUARANTINED'
  );
  assert.equal(
    executionReadiness(runtimeState,local,'engine-master','',false,false,'ETHUSDT:LONG',false),
    ''
  );
});

test('both LIMIT and immediate MARKET entry paths pass through the same symbol-local readiness fence',async()=>{
  const api=await readFile(new URL('../api/binance-entry-execute.js',import.meta.url),'utf8');
  const readiness=api.indexOf('const beforeReason=entryReadinessReason(before,master.deviceId,symbol,side,pendingEntryRecovery)');
  const preflight=api.indexOf('let preflight=await runLiveEntryPreflight',readiness);
  assert.ok(readiness>=0&&preflight>readiness);
  assert.match(api,/const marketEntry=type==='EXEC_OPEN_MARKET_POSITION'&&phase==='SUBMIT_MARKET_ENTRY'/);
  assert.match(api,/const limitEntry=type==='EXEC_OPEN_POSITION'&&\['PREPARE_PROTECTION','SUBMIT_ENTRY'\]\.includes\(phase\)/);
});
