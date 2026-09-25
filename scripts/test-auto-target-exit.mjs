import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutomaticTargetExit } from '../lib/auto-target-exit.mjs';

const priceFilter={filterType:'PRICE_FILTER',tickSize:'0.1',minPrice:'0.1',maxPrice:'1000000'};
const longPosition={symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'2',entryPrice:'100',updateTime:12345};

test('calculated target uses actual Binance entry and quantity and rounds to a valid profit tick',()=>{
  const plan=planAutomaticTargetExit({
    position:longPosition,currentOrders:[],tokenSettings:{BTCUSDT:{targetProfit:25}},
    settings:{targetProfit:100},priceFilter,maxLossConfirmed:true,
  });
  assert.equal(plan.action,'PLACE');
  assert.equal(plan.targetSource,'TARGET_PROFIT');
  assert.equal(plan.targetPrice,112.5);
  assert.ok(plan.actualTargetProfitUsd>=25);
});

test('exact sale price is preserved exactly when it is on Binance tick and profitable',()=>{
  const plan=planAutomaticTargetExit({
    position:longPosition,currentOrders:[],
    tokenSettings:{BTCUSDT:{exactSaleEnabled:true,exactSalePrice:111.2,targetProfit:25}},
    settings:{targetProfit:100},priceFilter,maxLossConfirmed:true,
  });
  assert.equal(plan.action,'PLACE');
  assert.equal(plan.targetSource,'EXACT_SALE');
  assert.equal(plan.targetPrice,111.2);
});

test('automatic target refuses to exist before unique MAX-LOSS confirmation',()=>{
  const plan=planAutomaticTargetExit({
    position:longPosition,currentOrders:[],tokenSettings:{BTCUSDT:{targetProfit:25}},
    settings:{targetProfit:100},priceFilter,maxLossConfirmed:false,
  });
  assert.equal(plan.action,'BLOCK');
  assert.equal(plan.reason,'MAX_LOSS_NOT_CONFIRMED');
});

test('existing Zenith LIMIT target is kept and never duplicated',()=>{
  const plan=planAutomaticTargetExit({
    position:longPosition,
    currentOrders:[{
      orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
      type:'LIMIT',timeInForce:'GTC',reduceOnly:true,price:'112.5',origQty:'2',
      executedQty:'0',clientOrderId:'zth-EXI-1234567890abcdef'
    }],
    tokenSettings:{BTCUSDT:{targetProfit:25}},settings:{targetProfit:100},
    priceFilter,maxLossConfirmed:true,
  });
  assert.equal(plan.action,'NONE');
  assert.equal(plan.reason,'MANAGED_TARGET_ALREADY_OPEN');
});

test('external or ambiguous reduce-only LIMIT target blocks automatic replacement',()=>{
  const plan=planAutomaticTargetExit({
    position:longPosition,
    currentOrders:[{
      orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
      type:'LIMIT',timeInForce:'GTC',reduceOnly:true,price:'112.5',origQty:'2',
      executedQty:'0',clientOrderId:'external-order'
    }],
    tokenSettings:{BTCUSDT:{targetProfit:25}},settings:{targetProfit:100},
    priceFilter,maxLossConfirmed:true,
  });
  assert.equal(plan.action,'BLOCK');
  assert.equal(plan.reason,'EXTERNAL_EXIT_LIMIT_PRESENT');
});

test('short positions receive a lower LIMIT target',()=>{
  const plan=planAutomaticTargetExit({
    position:{...longPosition,positionAmt:'-2'},currentOrders:[],
    tokenSettings:{BTCUSDT:{targetProfit:25}},settings:{targetProfit:100},
    priceFilter,maxLossConfirmed:true,
  });
  assert.equal(plan.action,'PLACE');
  assert.equal(plan.targetPrice,87.5);
});

test('invalid exact sale never falls back silently to a calculated target',()=>{
  const plan=planAutomaticTargetExit({
    position:longPosition,currentOrders:[],
    tokenSettings:{BTCUSDT:{exactSaleEnabled:true,exactSalePrice:99.9,targetProfit:25}},
    settings:{targetProfit:100},priceFilter,maxLossConfirmed:true,
  });
  assert.equal(plan.action,'BLOCK');
  assert.equal(plan.reason,'LONG_TARGET_NOT_ABOVE_ENTRY');
});
