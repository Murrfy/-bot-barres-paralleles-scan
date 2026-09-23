import test from 'node:test';
import assert from 'node:assert/strict';
import {
  streamPositionQuantity,
  evaluateProtectiveClose,
  PROTECTIVE_CLOSE_ATTEMPTS,
} from '../lib/protective-close-state.mjs';

function ready(overrides={}) {
  return {
    connected:true,
    needsReconciliation:false,
    failClosed:false,
    positions:{},
    standardOrders:{},
    ...overrides,
  };
}

test('full close is confirmed only by position inventory reduction',()=>{
  const s=ready({
    positions:{},
    standardOrders:{a:{clientOrderId:'cid-1',status:'FILLED'}}
  });
  const r=evaluateProtectiveClose({state:s,symbol:'BTCUSDT',direction:'LONG',beforeQuantity:0.02,requestedQuantity:0.02,clientOrderId:'cid-1'});
  assert.equal(r.confirmed,true);
  assert.equal(r.afterQuantity,0);
});

test('partial IOC expiry permits a retry only after reconciled stream is ready',()=>{
  const s=ready({
    positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.01'}},
    standardOrders:{a:{clientOrderId:'cid-1',status:'EXPIRED'}}
  });
  const r=evaluateProtectiveClose({state:s,symbol:'BTCUSDT',direction:'LONG',beforeQuantity:0.02,requestedQuantity:0.02,clientOrderId:'cid-1'});
  assert.equal(r.confirmed,false);
  assert.equal(r.progressed,true);
  assert.equal(r.safeToRetry,true);
});

test('no terminal order confirmation means never retry blindly',()=>{
  const s=ready({
    positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.02'}},
    standardOrders:{}
  });
  const r=evaluateProtectiveClose({state:s,symbol:'BTCUSDT',direction:'LONG',beforeQuantity:0.02,requestedQuantity:0.02,clientOrderId:'cid-1'});
  assert.equal(r.confirmed,false);
  assert.equal(r.safeToRetry,false);
});

test('FILLED without expected position reduction is inconsistent and blocks retry',()=>{
  const s=ready({
    positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.02'}},
    standardOrders:{a:{clientOrderId:'cid-1',status:'FILLED'}}
  });
  const r=evaluateProtectiveClose({state:s,symbol:'BTCUSDT',direction:'LONG',beforeQuantity:0.02,requestedQuantity:0.02,clientOrderId:'cid-1'});
  assert.equal(r.inconsistentFilled,true);
  assert.equal(r.safeToRetry,false);
});

test('short one-way position quantity is read by sign',()=>{
  const s=ready({positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'-0.03'}}});
  assert.equal(streamPositionQuantity(s,'BTCUSDT','SHORT'),0.03);
  assert.equal(streamPositionQuantity(s,'BTCUSDT','LONG'),0);
});

test('protective escalation is LIMIT-first and market is last resort',()=>{
  assert.deepEqual(PROTECTIVE_CLOSE_ATTEMPTS.map(x=>x.exitMode),[
    'PROTECTIVE_IOC','PROTECTIVE_IOC','PROTECTIVE_IOC','MARKET_LAST_RESORT'
  ]);
  assert.deepEqual(PROTECTIVE_CLOSE_ATTEMPTS.slice(0,3).map(x=>x.priceMatch),[
    'OPPONENT','OPPONENT_5','OPPONENT_10'
  ]);
});
