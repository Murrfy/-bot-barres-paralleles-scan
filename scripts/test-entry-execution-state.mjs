import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEntryAcceptance,
  streamEntryOrder,
  streamEntryPositionQuantity,
} from '../lib/entry-execution-state.mjs';

function readyState(overrides={}) {
  return {
    connected:true,
    needsReconciliation:false,
    failClosed:false,
    standardOrders:{},
    positions:{},
    ...overrides,
  };
}

const order={
  symbol:'BTCUSDT',
  clientOrderId:'zth-ENT-0123456789abcdef01234567',
  side:'BUY',
  positionSide:'BOTH',
  type:'LIMIT',
  status:'NEW',
  originalQuantity:'0.02',
  cumulativeFilledQuantity:'0',
  reduceOnly:false,
  terminal:false,
};

test('resting real LIMIT entry is accepted only after stream sees the deterministic order',()=>{
  const state=readyState({standardOrders:{x:order}});
  const r=evaluateEntryAcceptance({
    state,symbol:'BTCUSDT',side:'BUY',
    clientOrderId:order.clientOrderId,plannedQuantity:0.02
  });
  assert.equal(r.accepted,true);
  assert.equal(r.orderSeen,true);
  assert.equal(r.positionQuantity,0);
});

test('partial fill is accepted and explicitly reported',()=>{
  const state=readyState({
    standardOrders:{x:{...order,status:'PARTIALLY_FILLED',cumulativeFilledQuantity:'0.01'}},
    positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.01'}}
  });
  const r=evaluateEntryAcceptance({
    state,symbol:'BTCUSDT',side:'BUY',
    clientOrderId:order.clientOrderId,plannedQuantity:0.02
  });
  assert.equal(r.accepted,true);
  assert.equal(r.partialFill,true);
  assert.equal(r.fullyFilled,false);
});

test('fully filled market state can be proven by the resulting position even after open order disappears',()=>{
  const state=readyState({
    positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.02'}}
  });
  const r=evaluateEntryAcceptance({
    state,symbol:'BTCUSDT',side:'BUY',
    clientOrderId:order.clientOrderId,plannedQuantity:0.02
  });
  assert.equal(r.accepted,true);
  assert.equal(r.orderSeen,false);
  assert.equal(r.fullyFilled,true);
});

test('stream discontinuity fails closed even if an order object exists',()=>{
  const state=readyState({
    needsReconciliation:true,
    failClosed:true,
    standardOrders:{x:order}
  });
  const r=evaluateEntryAcceptance({
    state,symbol:'BTCUSDT',side:'BUY',
    clientOrderId:order.clientOrderId,plannedQuantity:0.02
  });
  assert.equal(r.accepted,false);
  assert.ok(r.reasons.includes('USER_STREAM_NOT_READY'));
});

test('terminal unfilled order is never accepted',()=>{
  const state=readyState({
    standardOrders:{x:{...order,status:'CANCELED',terminal:true}}
  });
  const r=evaluateEntryAcceptance({
    state,symbol:'BTCUSDT',side:'BUY',
    clientOrderId:order.clientOrderId,plannedQuantity:0.02
  });
  assert.equal(r.accepted,false);
  assert.ok(r.reasons.includes('ENTRY_ORDER_TERMINAL_UNFILLED'));
});

test('wrong side, reduce-only, hedge mode or oversized position fails closed',()=>{
  for (const bad of [
    {...order,side:'SELL'},
    {...order,reduceOnly:true},
    {...order,positionSide:'LONG'},
  ]) {
    const r=evaluateEntryAcceptance({
      state:readyState({standardOrders:{x:bad}}),
      symbol:'BTCUSDT',side:'BUY',clientOrderId:order.clientOrderId,plannedQuantity:0.02
    });
    assert.equal(r.accepted,false);
  }
  const oversized=evaluateEntryAcceptance({
    state:readyState({positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.03'}}}),
    symbol:'BTCUSDT',side:'BUY',clientOrderId:order.clientOrderId,plannedQuantity:0.02
  });
  assert.equal(oversized.accepted,false);
  assert.ok(oversized.reasons.includes('ENTRY_POSITION_EXCEEDS_PLAN'));
});

test('entry state helpers identify deterministic order and directional position quantity',()=>{
  const state=readyState({
    standardOrders:{x:order},
    positions:{
      p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.012'},
      q:{symbol:'ETHUSDT',positionSide:'BOTH',positionAmount:'2'}
    }
  });
  assert.equal(streamEntryOrder(state,'BTCUSDT',order.clientOrderId)?.clientOrderId,order.clientOrderId);
  assert.equal(streamEntryPositionQuantity(state,'BTCUSDT','BUY'),0.012);
  assert.equal(streamEntryPositionQuantity(state,'BTCUSDT','SELL'),0);
});
