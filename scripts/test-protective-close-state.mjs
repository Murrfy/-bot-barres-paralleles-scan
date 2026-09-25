import test from 'node:test';
import assert from 'node:assert/strict';
import {
  streamPositionQuantity,
  evaluateFullProtectiveClose,
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

test('full close is confirmed by reconciled zero position inventory',()=>{
  const s=ready({positions:{},standardOrders:{a:{clientOrderId:'cid-1',status:'FILLED'}}});
  const r=evaluateFullProtectiveClose({state:s,symbol:'BTCUSDT',direction:'LONG',beforeQuantity:0.02,clientOrderId:'cid-1'});
  assert.equal(r.confirmed,true);
  assert.equal(r.afterQuantity,0);
});

test('partial IOC expiry permits retry only after stream is reconciled',()=>{
  const s=ready({
    positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.01'}},
    standardOrders:{a:{clientOrderId:'cid-1',status:'EXPIRED'}}
  });
  const r=evaluateFullProtectiveClose({state:s,symbol:'BTCUSDT',direction:'LONG',beforeQuantity:0.02,clientOrderId:'cid-1'});
  assert.equal(r.confirmed,false);
  assert.equal(r.progressed,true);
  assert.equal(r.safeToRetry,true);
});

test('no terminal order confirmation never authorizes blind retry',()=>{
  const s=ready({positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.02'}},standardOrders:{}});
  const r=evaluateFullProtectiveClose({state:s,symbol:'BTCUSDT',direction:'LONG',beforeQuantity:0.02,clientOrderId:'cid-1'});
  assert.equal(r.safeToRetry,false);
});

test('FILLED while position still exists is inconsistent and blocks retry',()=>{
  const s=ready({
    positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.02'}},
    standardOrders:{a:{clientOrderId:'cid-1',status:'FILLED'}}
  });
  const r=evaluateFullProtectiveClose({state:s,symbol:'BTCUSDT',direction:'LONG',beforeQuantity:0.02,clientOrderId:'cid-1'});
  assert.equal(r.inconsistentFilled,true);
  assert.equal(r.safeToRetry,false);
});

test('short one-way position quantity is read from signed amount',()=>{
  const s=ready({positions:{p:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'-0.03'}}});
  assert.equal(streamPositionQuantity(s,'BTCUSDT','SHORT'),0.03);
  assert.equal(streamPositionQuantity(s,'BTCUSDT','LONG'),0);
});

test('all protective close escalation attempts remain LIMIT IOC only',()=>{
  assert.deepEqual(PROTECTIVE_CLOSE_ATTEMPTS.map(x=>x.exitMode),[
    'PROTECTIVE_IOC','PROTECTIVE_IOC','PROTECTIVE_IOC','PROTECTIVE_IOC'
  ]);
  assert.deepEqual(PROTECTIVE_CLOSE_ATTEMPTS.map(x=>x.priceMatch),[
    'OPPONENT','OPPONENT_5','OPPONENT_10','OPPONENT_20'
  ]);
  assert.equal(PROTECTIVE_CLOSE_ATTEMPTS.some(x=>String(x.exitMode).includes('MARKET')),false);
});
