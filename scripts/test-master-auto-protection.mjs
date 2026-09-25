import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMasterAutoProgressiveProtection } from '../lib/master-auto-protection.mjs';

const filter={filterType:'PRICE_FILTER',minPrice:'0.1',maxPrice:'1000000',tickSize:'0.1'};
const long={symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'1',entryPrice:'100',updateTime:1000};
const stages=[
  {enabled:true,arm:40,floor:39.8},
  {enabled:true,arm:105,floor:100},
  {enabled:true,arm:205,floor:200},
  {enabled:true,arm:2905,floor:2900},
];

test('39.99 does not arm a 40 stage',()=>{
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:139.99,protectionStages:stages,currentOrders:[],priceFilter:filter
  });
  assert.equal(r.action,'NONE');
  assert.equal(r.reason,'NO_PROTECTION_STAGE_REACHED');
});

test('40, 41 or 45 all arm the 40 stage',()=>{
  for(const pnl of [40,41,45]){
    const r=evaluateMasterAutoProgressiveProtection({
      position:long,markPrice:100+pnl,protectionStages:stages,currentOrders:[],priceFilter:filter
    });
    assert.equal(r.action,'REPLACE');
    assert.equal(r.stage.armProfitUsd,40);
    assert.equal(r.stage.protectedProfitUsd,39.8);
  }
});

test('30 to 3000 jump immediately selects protected 2900',()=>{
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:3100,protectionStages:stages,currentOrders:[],priceFilter:filter,
    previousHighWaterProfitUsd:30
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.stage.armProfitUsd,2905);
  assert.equal(r.stage.protectedProfitUsd,2900);
  assert.equal(r.level.triggerPrice,r.level.limitPrice);
  assert.ok(r.level.actualProtectedProfitUsd>=2900);
});

test('high-water keeps the reached stage armed after price falls back',()=>{
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:120,protectionStages:stages,currentOrders:[],priceFilter:filter,
    previousHighWaterProfitUsd:45
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.stage.armProfitUsd,40);
  assert.equal(r.stage.protectedProfitUsd,39.8);
  assert.equal(r.highWaterProfitUsd,45);
});

test('MASTER never downgrades an already higher Zenith protection',()=>{
  const existing=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'GTC',reduceOnly:true,
    triggerPrice:'300',price:'300',priceMatch:'NONE',clientAlgoId:'zth-PRO-existing'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:145,protectionStages:stages,currentOrders:existing,priceFilter:filter
  });
  assert.equal(r.action,'NONE');
  assert.equal(r.reason,'PROTECTION_ALREADY_AT_OR_ABOVE_STAGE');
});

test('external or non-exact progressive protection blocks automatic replacement',()=>{
  const external=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'GTC',reduceOnly:true,
    triggerPrice:'139.8',price:'139.8',clientAlgoId:'manual-stop'
  }];
  const a=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:145,protectionStages:stages,currentOrders:external,priceFilter:filter
  });
  assert.equal(a.action,'BLOCK');
  assert.equal(a.reason,'EXTERNAL_PROGRESSIVE_PROTECTION');

  const opponent=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'GTC',reduceOnly:true,
    triggerPrice:'139.8',price:'0',priceMatch:'OPPONENT',clientAlgoId:'zth-PRO-old'
  }];
  const b=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:145,protectionStages:stages,currentOrders:opponent,priceFilter:filter
  });
  assert.equal(b.action,'BLOCK');
  assert.equal(b.reason,'PROGRESSIVE_ORDER_NOT_EXACT_LIMIT');
});


test('triggered or external standard reduce-only LIMIT blocks automatic progressive recreation',()=>{
  const pending=[{
    orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'LIMIT',timeInForce:'GTC',reduceOnly:true,
    clientOrderId:'child-or-manual-limit',price:'139.8'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:145,protectionStages:stages,currentOrders:pending,priceFilter:filter
  });
  assert.equal(r.action,'BLOCK');
  assert.equal(r.reason,'STANDARD_REDUCE_ONLY_LIMIT_ALREADY_OPEN');
});

test('normal Zenith exit LIMIT may coexist with automatic progressive protection',()=>{
  const target=[{
    orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'LIMIT',timeInForce:'GTC',reduceOnly:true,
    clientOrderId:'zth-EXI-0123456789abcdef01234567',price:'300'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:145,protectionStages:stages,currentOrders:target,priceFilter:filter
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.stage.armProfitUsd,40);
});


test('a direct jump from level 1 to level 100 selects level 100 immediately',()=>{
  const hundredStages=Array.from({length:100},(_,i)=>({
    enabled:true,
    arm:105+i*100,
    floor:100+i*100,
  }));
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,
    markPrice:10105,
    protectionStages:hundredStages,
    currentOrders:[],
    priceFilter:filter,
    previousHighWaterProfitUsd:105,
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.stage.armProfitUsd,10005);
  assert.equal(r.stage.protectedProfitUsd,10000);
  assert.equal(r.stage.index,99);
  assert.equal(r.level.triggerPrice,10100);
  assert.ok(r.level.actualProtectedProfitUsd>=10000);
});
