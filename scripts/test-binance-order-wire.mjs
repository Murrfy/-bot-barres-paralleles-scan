import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStandardOrderPlan} from '../lib/binance-order-wire.mjs';

function plan(params){
  return {writeAllowed:false,endpoint:'/fapi/v1/order',method:'POST',params};
}

test('exact LIMIT GTC entry validates',()=>{
  const p=validateStandardOrderPlan(plan({
    symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',type:'LIMIT',quantity:'0.02',
    reduceOnly:'false',newClientOrderId:'zth-ENT-12345678',timeInForce:'GTC',price:'50000'
  }));
  assert.equal(p.price,'50000');
  assert.equal('priceMatch' in p,false);
});

test('protective LIMIT IOC priceMatch validates',()=>{
  const p=validateStandardOrderPlan(plan({
    symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',quantity:'0.02',
    reduceOnly:'true',newClientOrderId:'zth-EXT-12345678',timeInForce:'IOC',priceMatch:'OPPONENT'
  }));
  assert.equal(p.priceMatch,'OPPONENT');
  assert.equal('price' in p,false);
});

test('price and priceMatch together are rejected',()=>{
  assert.throws(()=>validateStandardOrderPlan(plan({
    symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',quantity:'0.02',
    reduceOnly:'true',newClientOrderId:'zth-EXT-12345678',timeInForce:'IOC',price:'50000',priceMatch:'OPPONENT'
  })),/LIMIT_REQUIRES_EXACTLY_ONE_PRICE_MODE/);
});

test('Hedge Mode plan is rejected',()=>{
  assert.throws(()=>validateStandardOrderPlan(plan({
    symbol:'BTCUSDT',side:'SELL',positionSide:'LONG',type:'MARKET',quantity:'0.02',
    reduceOnly:'true',newClientOrderId:'zth-MKT-12345678'
  })),/POSITION_SIDE_NOT_ONE_WAY/);
});

test('executable plan flag is never accepted by validator',()=>{
  assert.throws(()=>validateStandardOrderPlan({
    writeAllowed:true,endpoint:'/fapi/v1/order',method:'POST',
    params:{symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',type:'MARKET',quantity:'0.02',reduceOnly:'false',newClientOrderId:'zth-MKT-12345678'}
  }),/ORDER_PLAN_MUST_REMAIN_NON_EXECUTING/);
});
