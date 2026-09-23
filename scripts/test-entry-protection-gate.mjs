import test from 'node:test';
import assert from 'node:assert/strict';
import { findCoveringEntryProtection } from '../lib/entry-protection-gate.mjs';

function runtime(orders=[]) {
  return { data:{ binanceOrders:orders } };
}

test('LONG entry requires opposite STOP_MARKET closePosition protection below entry',()=>{
  const r=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,triggerPrice:'49000',clientAlgoId:'zth-MAX-protect-1'
  }]),{symbol:'BTCUSDT',side:'BUY',quantity:0.02,limitPrice:50000});
  assert.equal(r.ready,true);
  assert.equal(r.order.side,'SELL');
  assert.equal(r.order.triggerPrice,49000);
});

test('SHORT entry requires opposite STOP_MARKET closePosition protection above entry',()=>{
  const r=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,stopPrice:'51000',clientAlgoId:'zth-MAX-protect-2'
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


test('future entry gate rejects external STOP_MARKET even when price and side are otherwise valid',()=>{
  const r=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,
    triggerPrice:'49600',clientAlgoId:'manual-stop'
  }]),{symbol:'BTCUSDT',side:'BUY',quantity:1,limitPrice:50000});
  assert.equal(r.ready,false);
});

test('entry protection accepts $400 exactly and rejects anything above the hard cap',()=>{
  const safe=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,
    triggerPrice:'49600',clientAlgoId:'zth-MAX-safe'
  }]),{symbol:'BTCUSDT',side:'BUY',quantity:1,limitPrice:50000});
  assert.equal(safe.ready,true);

  const unsafe=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,
    triggerPrice:'49599.99',clientAlgoId:'zth-MAX-too-far'
  }]),{symbol:'BTCUSDT',side:'BUY',quantity:1,limitPrice:50000});
  assert.equal(unsafe.ready,false);
});

test('SHORT entry gate applies the same managed $400 ceiling',()=>{
  const safe=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,
    triggerPrice:'50400',clientAlgoId:'zth-MAX-short-safe'
  }]),{symbol:'BTCUSDT',side:'SELL',quantity:1,limitPrice:50000});
  assert.equal(safe.ready,true);

  const unsafe=findCoveringEntryProtection(runtime([{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',
    type:'STOP_MARKET',closePosition:true,reduceOnly:false,
    triggerPrice:'50400.01',clientAlgoId:'zth-MAX-short-too-far'
  }]),{symbol:'BTCUSDT',side:'SELL',quantity:1,limitPrice:50000});
  assert.equal(unsafe.ready,false);
});
