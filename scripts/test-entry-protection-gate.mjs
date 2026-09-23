import test from 'node:test';
import assert from 'node:assert/strict';
import { findCoveringEntryProtection } from '../lib/entry-protection-gate.mjs';

function runtime(orders=[]) {
  return { data:{ binanceOrders:orders } };
}

test('LONG entry requires opposite STOP_MARKET closePosition protection below entry',()=>{
  const r=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,triggerPrice:'49000',clientAlgoId:'protect-1'
  }]),{symbol:'BTCUSDT',side:'BUY',quantity:0.02,limitPrice:50000});
  assert.equal(r.ready,true);
  assert.equal(r.order.side,'SELL');
  assert.equal(r.order.triggerPrice,49000);
});

test('SHORT entry requires opposite STOP_MARKET closePosition protection above entry',()=>{
  const r=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,stopPrice:'51000',clientAlgoId:'protect-2'
  }]),{symbol:'BTCUSDT',side:'SELL',quantity:0.02,limitPrice:50000});
  assert.equal(r.ready,true);
  assert.equal(r.order.side,'BUY');
});

test('wrong side, wrong trigger direction, reduceOnly mix, or non-close-all protection fails closed',()=>{
  const cases=[
    {symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',type:'STOP_MARKET',closePosition:true,reduceOnly:false,triggerPrice:'49000'},
    {symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',closePosition:true,reduceOnly:false,triggerPrice:'51000'},
    {symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',closePosition:true,reduceOnly:true,triggerPrice:'49000'},
    {symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',closePosition:false,reduceOnly:true,triggerPrice:'49000'},
  ];
  for(const [i,order] of cases.entries()){
    const r=findCoveringEntryProtection(runtime([order]),{symbol:'BTCUSDT',side:'BUY',quantity:0.02,limitPrice:50000});
    if(i===0) assert.equal(r.ready,false,'same-side protection');
    else assert.equal(r.ready,false,'case '+i);
  }
});

test('missing protection fails closed',()=>{
  const r=findCoveringEntryProtection(runtime([]),{symbol:'BTCUSDT',side:'BUY',quantity:0.02,limitPrice:50000});
  assert.equal(r.ready,false);
  assert.equal(r.reason,'ENTRY_PROTECTION_NOT_ARMED');
});
