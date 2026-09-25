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
    tokenSettings:{BTCUSDT:{maxLoss:400,targetProfit:3000}},
    settings:{maxLoss:400,targetProfit:3000},
    priceFilters:filter,
  });
  assert.equal(plan.action,'REPAIR');
  assert.equal(plan.target,'BTCUSDT:LONG');
  assert.equal(plan.quantity,0.2);
  assert.equal(plan.triggerPrice,48000);
  assert.ok(plan.actualMaxLossUsd<=400);
  assert.equal(plan.lifecycleAt,123);
});

test('repair clamps legacy configured loss to hard server cap',()=>{
  const plan=buildMaxLossRepairPlan({
    report:report(),
    positions:[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.2',entryPrice:'50000'}],
    tokenSettings:{BTCUSDT:{maxLoss:9999,targetProfit:40}},
    priceFilters:filter,
  });
  assert.equal(plan.action,'REPAIR');
  assert.equal(plan.maxLossUsd,400);
  assert.ok(plan.actualMaxLossUsd<=400);
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
  assert.equal(plan.action,'BLOCK');
  assert.equal(plan.reason,'AMBIGUOUS_MAX_LOSS_REPAIR_UNSAFE');
});

test('missing position or exchange tick metadata fails closed',()=>{
  const noPosition=buildMaxLossRepairPlan({report:report(),positions:[],priceFilters:filter});
  assert.equal(noPosition.action,'BLOCK');
  assert.equal(noPosition.reason,'REPAIR_POSITION_NOT_FOUND');

  const noFilter=buildMaxLossRepairPlan({
    report:report(),
    positions:[{symbol:'BTCUSDT',positionAmt:'0.2',entryPrice:'50000'}],
    priceFilters:{},
  });
  assert.equal(noFilter.action,'BLOCK');
  assert.equal(noFilter.reason,'REPAIR_PRICE_FILTER_MISSING');
});
