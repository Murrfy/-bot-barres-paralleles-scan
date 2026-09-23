import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEntryOpenConfirmation } from '../lib/entry-open-state.mjs';

function state({status='NEW',executed='0',positionAmt='0',ready=true,price='50000',qty='0.02'}={}) {
  const s={
    connected:ready,
    needsReconciliation:!ready,
    failClosed:!ready,
    standardOrders:{
      'BTCUSDT:client:zth-entry':{
        symbol:'BTCUSDT',clientOrderId:'zth-entry',side:'BUY',positionSide:'BOTH',
        type:'LIMIT',timeInForce:'GTC',originalQuantity:qty,originalPrice:price,
        cumulativeFilledQuantity:executed,status,reduceOnly:false,
      }
    },
    positions:{},
  };
  if(Number(positionAmt)!==0){
    s.positions['BTCUSDT:BOTH']={
      symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:String(positionAmt),entryPrice:'50000'
    };
  }
  return s;
}

const input={symbol:'BTCUSDT',side:'BUY',quantity:0.02,limitPrice:50000,clientOrderId:'zth-entry'};

test('visible NEW entry is not ACK-safe until protection is confirmed',()=>{
  const r=evaluateEntryOpenConfirmation({...input,state:state(),protectionReady:false});
  assert.equal(r.confirmed,true);
  assert.equal(r.safeToAck,false);
  assert.equal(r.requiresProtection,true);
  assert.equal(r.reason,'ENTRY_PROTECTION_CONFIRMATION_REQUIRED');
});

test('visible NEW entry becomes ACK-safe only with ready stream and protection proof',()=>{
  const r=evaluateEntryOpenConfirmation({...input,state:state(),protectionReady:true});
  assert.equal(r.confirmed,true);
  assert.equal(r.safeToAck,true);
  assert.equal(r.reason,'ENTRY_CONFIRMED');
});

test('partial fill requires matching live position and protection',()=>{
  const r=evaluateEntryOpenConfirmation({
    ...input,state:state({status:'PARTIALLY_FILLED',executed:'0.01',positionAmt:'0.01'}),protectionReady:true
  });
  assert.equal(r.confirmed,true);
  assert.equal(r.safeToAck,true);
  assert.equal(r.executedQty,0.01);
  assert.equal(r.positionQty,0.01);
});

test('fill without matching position fails closed',()=>{
  const r=evaluateEntryOpenConfirmation({
    ...input,state:state({status:'PARTIALLY_FILLED',executed:'0.01',positionAmt:'0'}),protectionReady:true
  });
  assert.equal(r.safeToAck,false);
  assert.equal(r.reason,'ENTRY_FILL_POSITION_MISMATCH');
});

test('unfilled terminal entry cannot be acknowledged',()=>{
  const r=evaluateEntryOpenConfirmation({
    ...input,state:state({status:'CANCELED'}),protectionReady:true
  });
  assert.equal(r.confirmed,false);
  assert.equal(r.safeToAck,false);
  assert.equal(r.reason,'ENTRY_ORDER_TERMINAL_UNFILLED');
});

test('identity mismatch fails closed',()=>{
  const r=evaluateEntryOpenConfirmation({
    ...input,state:state({price:'50001'}),protectionReady:true
  });
  assert.equal(r.safeToAck,false);
  assert.equal(r.reason,'ENTRY_ORDER_IDENTITY_MISMATCH');
});

test('stream not ready blocks ACK even when order and protection exist',()=>{
  const r=evaluateEntryOpenConfirmation({
    ...input,state:state({ready:false}),protectionReady:true
  });
  assert.equal(r.confirmed,true);
  assert.equal(r.safeToAck,false);
  assert.equal(r.reason,'USER_STREAM_NOT_READY');
});
