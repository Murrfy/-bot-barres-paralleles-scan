import test from 'node:test';
import assert from 'node:assert/strict';
import { planEntrySymbolConfiguration } from '../lib/binance-symbol-config.mjs';

function config(overrides={}){
  return {
    symbol:'BTCUSDT',
    desiredMargin:500,
    desiredLeverage:7,
    bracketInfo:{symbol:'BTCUSDT',brackets:[
      {bracket:1,initialLeverage:10,notionalFloor:0,notionalCap:10000}
    ]},
    symbolConfig:{symbol:'BTCUSDT',marginType:'ISOLATED',leverage:7},
    positions:[],
    standardOrders:[],
    algoOrders:[],
    ...overrides,
  };
}

test('per-token Binance Futures config is already ready when ISOLATED and leverage match',()=>{
  const plan=planEntrySymbolConfiguration(config());
  assert.equal(plan.ok,true);
  assert.equal(plan.needsMutation,false);
  assert.equal(plan.reason,'SYMBOL_CONFIGURATION_READY');
});

test('different token leverage creates an exact leverage mutation plan',()=>{
  const plan=planEntrySymbolConfiguration(config({
    desiredLeverage:4,
    symbolConfig:{symbol:'BTCUSDT',marginType:'ISOLATED',leverage:10},
  }));
  assert.equal(plan.ok,true);
  assert.equal(plan.needsMarginType,false);
  assert.equal(plan.needsLeverage,true);
  assert.equal(plan.desiredLeverage,4);
});

test('cross margin creates an ISOLATED mutation requirement',()=>{
  const plan=planEntrySymbolConfiguration(config({
    symbolConfig:{symbol:'BTCUSDT',marginType:'CROSSED',leverage:7},
  }));
  assert.equal(plan.ok,true);
  assert.equal(plan.needsMarginType,true);
  assert.equal(plan.needsLeverage,false);
});

test('configuration is never changed while a live position exists',()=>{
  const plan=planEntrySymbolConfiguration(config({
    desiredLeverage:4,
    symbolConfig:{symbol:'BTCUSDT',marginType:'ISOLATED',leverage:10},
    positions:[{symbol:'BTCUSDT',positionAmt:'0.01'}],
  }));
  assert.equal(plan.ok,false);
  assert.equal(plan.reason,'SYMBOL_CONFIGURATION_POSITION_ACTIVE');
});

test('configuration is never changed while any symbol order exists',()=>{
  const plan=planEntrySymbolConfiguration(config({
    desiredLeverage:4,
    symbolConfig:{symbol:'BTCUSDT',marginType:'ISOLATED',leverage:10},
    standardOrders:[{symbol:'BTCUSDT',type:'LIMIT'}],
  }));
  assert.equal(plan.ok,false);
  assert.equal(plan.reason,'SYMBOL_CONFIGURATION_ORDERS_ACTIVE');
});

test('server leverage cap remains 10 even if Binance supports more',()=>{
  assert.throws(()=>planEntrySymbolConfiguration(config({desiredLeverage:11})),/LEVERAGE_OVER_SERVER_CAP/);
});


test('selected amount and leverage are rejected before mutation when Binance bracket is exceeded',()=>{
  const plan=planEntrySymbolConfiguration(config({
    desiredMargin:1000,
    desiredLeverage:10,
    bracketInfo:{symbol:'BTCUSDT',brackets:[
      {bracket:1,initialLeverage:5,notionalFloor:0,notionalCap:20000}
    ]},
    symbolConfig:{symbol:'BTCUSDT',marginType:'ISOLATED',leverage:5},
  }));
  assert.equal(plan.ok,false);
  assert.equal(plan.reason,'LEVERAGE_BRACKET_EXCEEDED');
  assert.equal(plan.desiredNotional,10000);
  assert.equal(plan.bracketMaxLeverage,5);
});

test('selected amount determines the applicable Binance leverage bracket',()=>{
  const plan=planEntrySymbolConfiguration(config({
    desiredMargin:800,
    desiredLeverage:10,
    bracketInfo:{symbol:'BTCUSDT',brackets:[
      {bracket:1,initialLeverage:10,notionalFloor:0,notionalCap:5000},
      {bracket:2,initialLeverage:8,notionalFloor:5000,notionalCap:20000}
    ]},
  }));
  assert.equal(plan.ok,false);
  assert.equal(plan.reason,'LEVERAGE_BRACKET_EXCEEDED');
  assert.equal(plan.desiredNotional,8000);
  assert.equal(plan.bracketMaxLeverage,8);
});

test('missing Binance leverage bracket fails closed',()=>{
  assert.throws(()=>planEntrySymbolConfiguration(config({
    bracketInfo:{symbol:'BTCUSDT',brackets:[]},
  })),/LEVERAGE_BRACKET_UNAVAILABLE/);
});
