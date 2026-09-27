import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { orphanZenithCleanupOrders, expiredEntryOrphanProtections, maxLossSymbolIsQuarantined } from '../lib/protective-command.mjs';

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

test('cleanup targets are accepted only for the exact orphan-only reconciliation state',()=>{
  assert.equal(orphanZenithCleanupOrders(report([standard])).length,1);
  assert.equal(orphanZenithCleanupOrders(report([algo])).length,1);
  assert.deepEqual(orphanZenithCleanupOrders(report([standard],[
    'ORPHAN_ZENITH_PROTECTIVE_ORDER','RUNTIME_STATE_STALE'
  ])),[]);
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
