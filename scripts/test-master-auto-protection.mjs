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


test('a disabled protection stage is skipped while later enabled stages remain active',()=>{
  const custom=[
    {enabled:true,arm:30,floor:20},
    {enabled:false,arm:105,floor:100},
    {enabled:true,arm:205,floor:200},
  ];
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:350,protectionStages:custom,currentOrders:[],priceFilter:filter
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.stage.armProfitUsd,205);
  assert.equal(r.stage.protectedProfitUsd,200);
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
    triggerPrice:'300',price:'300',origQty:'1',executedQty:'0',priceMatch:'NONE',clientAlgoId:'zth-PRO-existing'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:145,protectionStages:stages,currentOrders:existing,priceFilter:filter
  });
  assert.equal(r.action,'NONE');
  assert.equal(r.reason,'PROTECTION_ALREADY_AT_OR_ABOVE_STAGE');
});

test('progressive protection is replaced when its remaining quantity no longer covers the live position',()=>{
  const existing=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'GTC',reduceOnly:true,
    triggerPrice:'139.8',price:'139.8',origQty:'1',executedQty:'0',priceMatch:'NONE',
    clientAlgoId:'zth-PRO-oldqty'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:{...long,positionAmt:'2'},markPrice:125,protectionStages:stages,
    currentOrders:existing,priceFilter:filter
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.reason,'PROGRESSIVE_QUANTITY_REFRESH_REQUIRED');
  assert.equal(r.live.quantity,2);
  assert.equal(r.previousClientAlgoId,'zth-PRO-oldqty');
  assert.equal(r.level.quantity,2);
});

test('progressive protection with matching remaining quantity can remain in place',()=>{
  const existing=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'GTC',reduceOnly:true,
    triggerPrice:'139.8',price:'139.8',origQty:'2',executedQty:'0',priceMatch:'NONE',
    clientAlgoId:'zth-PRO-rightqty'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:{...long,positionAmt:'2'},markPrice:125,protectionStages:stages,
    currentOrders:existing,priceFilter:filter
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


test('managed emergency MAX-LOSS does not block a due progressive gain protection',()=>{
  const maxLoss=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'IOC',reduceOnly:true,closePosition:false,
    triggerPrice:'60',priceMatch:'OPPONENT',origQty:'1',executedQty:'0',
    clientAlgoId:'zth-MAX-0123456789abcdef'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:145,protectionStages:stages,currentOrders:maxLoss,priceFilter:filter
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.reason,'FIRST_STAGE_REACHED');
  assert.equal(r.stage.armProfitUsd,40);
  assert.equal(r.stage.protectedProfitUsd,39.8);
});

test('unknown IOC STOP remains conservative and cannot masquerade as managed MAX-LOSS',()=>{
  const unknown=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'IOC',reduceOnly:true,closePosition:false,
    triggerPrice:'60',priceMatch:'OPPONENT',origQty:'1',executedQty:'0',
    clientAlgoId:'manual-stop'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,markPrice:145,protectionStages:stages,currentOrders:unknown,priceFilter:filter
  });
  assert.equal(r.action,'BLOCK');
  assert.equal(r.reason,'EXTERNAL_PROGRESSIVE_PROTECTION');
});


test('MAX-LOSS red memory falls back to the highest protection still executable',()=>{
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,
    markPrice:160,
    protectionStages:stages,
    currentOrders:[],
    priceFilter:filter,
    previousHighWaterProfitUsd:110,
    redBlockedHighWaterProfitUsd:110,
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.redRecoveryActive,true);
  assert.equal(r.stage.armProfitUsd,40);
  assert.equal(r.stage.protectedProfitUsd,39.8);
  assert.equal(r.redRecoverySatisfied,false);
});

test('MAX-LOSS red memory upgrades to the originally reached stage once executable again',()=>{
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,
    markPrice:220,
    protectionStages:stages,
    currentOrders:[],
    priceFilter:filter,
    previousHighWaterProfitUsd:110,
    redBlockedHighWaterProfitUsd:110,
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.stage.armProfitUsd,105);
  assert.equal(r.stage.protectedProfitUsd,100);
  assert.equal(r.redRecoverySatisfied,true);
});

test('fallback is never used without a MAX-LOSS red memory marker',()=>{
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,
    markPrice:160,
    protectionStages:stages,
    currentOrders:[],
    priceFilter:filter,
    previousHighWaterProfitUsd:110,
  });
  assert.equal(r.action,'REPLACE');
  assert.equal(r.stage.armProfitUsd,105);
  assert.equal(r.redRecoveryActive,false);
});

test('lower fallback protection keeps the red debt until the higher reached stage is secured',()=>{
  const existing=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'GTC',reduceOnly:true,
    triggerPrice:'139.8',price:'139.8',origQty:'1',executedQty:'0',
    priceMatch:'NONE',clientAlgoId:'zth-PRO-red-fallback'
  }];
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,
    markPrice:160,
    protectionStages:stages,
    currentOrders:existing,
    priceFilter:filter,
    previousHighWaterProfitUsd:110,
    redBlockedHighWaterProfitUsd:110,
  });
  assert.equal(r.action,'NONE');
  assert.equal(r.reason,'PROTECTION_ALREADY_AT_OR_ABOVE_STAGE');
  assert.equal(r.stage.armProfitUsd,40);
  assert.equal(r.redRecoverySatisfied,false);
});

test('red recovery waits if even the first reached floor is no longer executable',()=>{
  const r=evaluateMasterAutoProgressiveProtection({
    position:long,
    markPrice:120,
    protectionStages:stages,
    currentOrders:[],
    priceFilter:filter,
    previousHighWaterProfitUsd:110,
    redBlockedHighWaterProfitUsd:110,
  });
  assert.equal(r.action,'NONE');
  assert.equal(r.reason,'RED_MAX_LOSS_REACHED_STAGE_NOT_CURRENTLY_EXECUTABLE');
  assert.equal(r.redRecoverySatisfied,false);
});
