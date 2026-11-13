// Décision Walter 13/11/2026 (incident IDOL) : la MAX-LOSS ne bloque plus jamais
// les paliers, la vente à l'objectif, la fermeture ni les achats.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { maxLossEnforced, neutralizeMaxLossRequirements } from '../lib/max-loss-policy.mjs';
import { evaluateMasterAutoProgressiveProtection } from '../lib/master-auto-protection.mjs';
import { planAutomaticTargetExit } from '../lib/auto-target-exit.mjs';

delete process.env.ZENITH_MAX_LOSS_ENFORCED;

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const reconcile=fs.readFileSync('api/binance-reconcile.js','utf8');
const html=fs.readFileSync('index.html','utf8');

const filter={filterType:'PRICE_FILTER',minPrice:'0.000001',maxPrice:'1000',tickSize:'0.000001'};
// Position IDOL du 13/11/2026 : 50 $ en x8 achetés à 0,013357.
const idol={symbol:'IDOLUSDT',positionSide:'BOTH',positionAmt:'29947',entryPrice:'0.013357',updateTime:1000};
const maxLoss=(id,qty)=>({
  orderClass:'ALGO',symbol:'IDOLUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',
  timeInForce:'IOC',reduceOnly:true,closePosition:false,priceMatch:'OPPONENT',
  origQty:String(qty),triggerPrice:'0.011700',clientAlgoId:id,algoStatus:'NEW',
});
const stages=[
  {enabled:true,arm:20,floor:10},
  {enabled:true,arm:40,floor:30},
  {enabled:true,arm:60,floor:50},
  {enabled:true,arm:80,floor:70},
];

test('MAX-LOSS is disabled by default and only tests can re-enable it',()=>{
  assert.equal(maxLossEnforced(),false);
  process.env.ZENITH_MAX_LOSS_ENFORCED='1';
  try{assert.equal(maxLossEnforced(),true)}
  finally{delete process.env.ZENITH_MAX_LOSS_ENFORCED}
});

for(const [label,orders] of [
  ['no MAX-LOSS on Binance',[]],
  ['two duplicate MAX-LOSS orders (IDOL incident)',[maxLoss('zth-MAX-a',30000),maxLoss('zth-MAX-b',29947)]],
]){
  test('IDOL replay, '+label+' : reconciliation stays clean and the palier is placed',()=>{
    const report=neutralizeMaxLossRequirements({
      status:'MISMATCH',runtimeMode:'REAL',failClosed:true,
      reasons:orders.length?['AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION']:['MISSING_BINANCE_PROTECTION','MISSING_BINANCE_MAX_LOSS_PROTECTION'],
      differences:{
        missingMaxLossProtections:orders.length?[]:['IDOLUSDT:LONG'],
        ambiguousMaxLossProtections:orders.length?['IDOLUSDT:LONG']:[],
        missingProtections:orders.length?[]:['IDOLUSDT:LONG'],
      },
    });
    assert.equal(report.failClosed,false);
    assert.equal(report.status,'CLEAN_REAL');
    assert.deepEqual(report.differences.missingMaxLossProtections,[]);
    assert.deepEqual(report.differences.ambiguousMaxLossProtections,[]);

    // Gain +60 $ environ : le palier 3 (60 → 50) doit être posé, MAX-LOSS ou pas.
    const plan=evaluateMasterAutoProgressiveProtection({
      position:idol,markPrice:0.0154,protectionStages:stages,currentOrders:orders,priceFilter:filter,
    });
    assert.equal(plan.action,'REPLACE',JSON.stringify(plan.reason));
    assert.equal(plan.stage.protectedProfitUsd,50);

    // La vente à l'objectif n'attend plus la MAX-LOSS.
    const target=planAutomaticTargetExit({
      position:idol,currentOrders:orders,tokenSettings:{IDOLUSDT:{targetProfit:20,manualTargetProfit:20}},
      settings:{targetProfit:20},priceFilter:filter,maxLossConfirmed:true,
    });
    assert.notEqual(target.reason,'MAX_LOSS_NOT_CONFIRMED');
  });
}

test('any other reconciliation anomaly still fails closed',()=>{
  const report=neutralizeMaxLossRequirements({
    status:'MISMATCH',runtimeMode:'REAL',failClosed:true,
    reasons:['MISSING_BINANCE_MAX_LOSS_PROTECTION','UNTRACKED_BINANCE_POSITION'],differences:{},
  });
  assert.equal(report.failClosed,true);
  assert.deepEqual(report.reasons,['UNTRACKED_BINANCE_POSITION']);
});

test('reconciliation neutralizes MAX-LOSS before any MAX-LOSS quarantine is created',()=>{
  const at=reconcile.indexOf('neutralizeMaxLossRequirements(result);');
  assert.ok(at>reconcile.indexOf('const result = enforceConfiguredMaxLossSafety('));
  assert.ok(at<reconcile.indexOf('localizeMissingMaxLossRepair(result,started);'));
  assert.ok(at<reconcile.indexOf('detectTriggeredMaxLossRemainders({',at-2000));
});

test('engine no longer lets MAX-LOSS block paliers, objective, entries, repairs or market ACK',()=>{
  assert.match(worker,/const maxLossRed=maxLossEnforced\(\)&&\(/);
  assert.match(worker,/const maxLossConfirmed=!maxLossEnforced\(\)\|\|uniqueManagedMaxLoss\(position,orders,configuredMaxLoss\)/);
  assert.match(worker,/const refreshedMaxLoss=!maxLossEnforced\(\)\|\|uniqueManagedMaxLoss/);
  assert.match(worker,/const repairTarget=maxLossEnforced\(\)\?missingMaxLossRepairTarget\(data\.report\):null/);
  assert.equal((worker.match(/if\(maxLossEnforced\(\)&&symbolMaxLossQuarantined\(config\.symbol\)\)return false;/g)||[]).length,2);
  assert.match(worker,/confirmedPosition&&\(!maxLossEnforced\(\)\|\|/);
});

test('iPhone never refuses palier or objective edits because of MAX-LOSS',()=>{
  assert.match(html,/const MAX_LOSS_ENFORCED=false;/);
  assert.doesNotMatch(html,/\n\s*if\(!inv\.managedMaxLoss\|\|inv\.maxLossConflict\)/);
  assert.match(html,/MAX-LOSS désactivée — marge isolée/);
});
