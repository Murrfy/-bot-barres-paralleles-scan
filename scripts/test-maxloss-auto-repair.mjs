import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMaxLossRepairPlan } from '../lib/maxloss-repair.mjs';

const filter={BTCUSDT:{filterType:'PRICE_FILTER',minPrice:'0.1',maxPrice:'1000000',tickSize:'0.1'}};
function report(reasons=['MISSING_BINANCE_PROTECTION','MISSING_BINANCE_MAX_LOSS_PROTECTION']){
  return {
    version:2,status:'MISMATCH',failClosed:true,reasons,
    differences:{
      missingProtections:['BTCUSDT:LONG'],
      missingMaxLossProtections:['BTCUSDT:LONG'],
      ambiguousMaxLossProtections:[],
    }
  };
}

test('builds exact LONG MAX-LOSS repair from live position and controller config',()=>{
  const plan=buildMaxLossRepairPlan({
    report:report(),
    positions:[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.2',entryPrice:'50000',updateTime:123}],
    tokenSettings:{BTCUSDT:{maxLoss:400,margin:1000,targetProfit:3000}},
    settings:{maxLoss:400,margin:1000,targetProfit:3000},
    priceFilters:filter,
  });
  assert.equal(plan.action,'REPAIR');
  assert.equal(plan.target,'BTCUSDT:LONG');
  assert.equal(plan.quantity,0.2);
  assert.equal(plan.triggerPrice,48000);
  assert.ok(plan.actualMaxLossUsd<=400);
  assert.equal(plan.lifecycleAt,123);
});

test('repair accepts configured loss above $400 when token margin allows it',()=>{
  const plan=buildMaxLossRepairPlan({
    report:report(),
    positions:[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.2',entryPrice:'50000'}],
    tokenSettings:{BTCUSDT:{maxLoss:500,margin:1000,targetProfit:40}},
    priceFilters:filter,
  });
  assert.equal(plan.action,'REPAIR');
  assert.equal(plan.maxLossUsd,500);
  assert.ok(plan.actualMaxLossUsd<=500);
});

test('ambiguous duplicate MAX-LOSS never creates a third protection',()=>{
  const r=report(['AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION']);
  r.differences.missingProtections=[];
  r.differences.missingMaxLossProtections=[];
  r.differences.ambiguousMaxLossProtections=['BTCUSDT:LONG'];
  const plan=buildMaxLossRepairPlan({
    report:r,
    positions:[{symbol:'BTCUSDT',positionAmt:'0.2',entryPrice:'50000'}],
    priceFilters:filter,
  });
  assert.equal(plan.action,'NONE');
  assert.equal(plan.reason,'NO_EXACT_REPAIR_TARGET');
});

test('missing position or exchange tick metadata fails closed',()=>{
  const noPosition=buildMaxLossRepairPlan({report:report(),positions:[],priceFilters:filter});
  assert.equal(noPosition.action,'BLOCK');
  assert.equal(noPosition.reason,'REPAIR_POSITION_NOT_FOUND');

  const noFilter=buildMaxLossRepairPlan({
    report:report(),
    positions:[{symbol:'BTCUSDT',positionAmt:'0.2',entryPrice:'50000'}],
    tokenSettings:{BTCUSDT:{maxLoss:400,margin:1000}},
    settings:{maxLoss:400,margin:1000},
    priceFilters:{},
  });
  assert.equal(noFilter.action,'BLOCK');
  assert.equal(noFilter.reason,'REPAIR_PRICE_FILTER_MISSING');
});

test('unsafe existing MAX-LOSS is never auto-repaired blindly',()=>{
  const r=report();
  r.differences.unsafeMaxLossProtections=[{
    key:'BTCUSDT:LONG',symbol:'BTCUSDT',direction:'LONG',
    triggerPrice:47000,impliedLossUsd:600,hardMaxLossUsd:400,
  }];
  const plan=buildMaxLossRepairPlan({
    report:r,
    positions:[{symbol:'BTCUSDT',positionAmt:'0.2',entryPrice:'50000'}],
    priceFilters:filter,
  });
  assert.equal(plan.action,'NONE');
  assert.equal(plan.reason,'NO_EXACT_REPAIR_TARGET');
});


test('builds repair plan from exact local missing MAX-LOSS quarantine',()=>{
  const local={
    version:2,status:'CLEAN_REAL_WITH_QUARANTINES',failClosed:false,reasons:[],
    differences:{
      missingProtections:['BTCUSDT:LONG'],
      missingMaxLossProtections:['BTCUSDT:LONG'],
      ambiguousMaxLossProtections:[],
      unsafeMaxLossProtections:[],
      configuredMaxLossUnavailable:[],
    },
    symbolQuarantines:[{
      symbol:'BTCUSDT',direction:'LONG',reason:'MISSING_MAX_LOSS_REPAIR_PENDING',
      remainingQuantity:null,since:Date.now(),
    }],
  };
  const plan=buildMaxLossRepairPlan({
    report:local,
    positions:[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.2',entryPrice:'50000',updateTime:123}],
    tokenSettings:{BTCUSDT:{maxLoss:400,margin:1000}},
    settings:{maxLoss:400,margin:1000},
    priceFilters:filter,
  });
  assert.equal(plan.action,'REPAIR');
  assert.equal(plan.target,'BTCUSDT:LONG');
  assert.equal(plan.triggerPrice,48000);
  assert.ok(plan.actualMaxLossUsd<=400);
});
