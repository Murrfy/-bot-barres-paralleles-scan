import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_ORDER_ID_MAX_LENGTH,
  deterministicClientOrderId,
  buildEntryOrderPlan,
  buildExitOrderPlan,
} from '../lib/order-intent.mjs';

const now=1_800_000_000_000;
function risk(overrides={}) {
  return {
    ready:true,
    observedAt:now-1000,
    normalized:{
      symbol:'BTCUSDT',
      positionMode:'ONE_WAY',
      marginType:'ISOLATED',
      leverage:10,
      quantity:0.02,
      referencePrice:50000,
      ...overrides,
    },
  };
}

test('client order ids are deterministic, leg-specific and Binance-length safe',()=>{
  const a=deterministicClientOrderId({commandId:'cmd-12345678',symbol:'BTCUSDT',leg:'ENTRY'});
  const b=deterministicClientOrderId({commandId:'cmd-12345678',symbol:'BTCUSDT',leg:'ENTRY'});
  const c=deterministicClientOrderId({commandId:'cmd-12345678',symbol:'BTCUSDT',leg:'EXIT_LIMIT'});
  assert.equal(a,b);
  assert.notEqual(a,c);
  assert.ok(a.length<=CLIENT_ORDER_ID_MAX_LENGTH);
  assert.match(a,/^[A-Za-z0-9._:-]+$/);
});

test('LIMIT entry plan is derived only from a fresh matching risk snapshot',()=>{
  const p=buildEntryOrderPlan({
    command:{id:'cmd-12345678',symbol:'BTCUSDT',side:'BUY',orderType:'LIMIT',limitPrice:50000},
    riskSnapshot:risk(),now
  });
  assert.equal(p.writeAllowed,false);
  assert.equal(p.params.type,'LIMIT');
  assert.equal(p.params.timeInForce,'GTC');
  assert.equal(p.params.price,'50000');
  assert.equal(p.params.quantity,'0.02');
  assert.equal(p.params.reduceOnly,'false');
});

test('LIMIT entry price must exactly match the fresh preflight price',()=>{
  assert.throws(()=>buildEntryOrderPlan({
    command:{id:'cmd-12345678',symbol:'BTCUSDT',side:'BUY',orderType:'LIMIT',limitPrice:50000.1},
    riskSnapshot:risk(),now
  }),/ENTRY_PREFLIGHT_PRICE_MISMATCH/);
});

test('stale risk snapshot blocks entry planning',()=>{
  assert.throws(()=>buildEntryOrderPlan({
    command:{id:'cmd-12345678',symbol:'BTCUSDT',side:'BUY',orderType:'MARKET'},
    riskSnapshot:{...risk(),observedAt:now-6000},now
  }),/ENTRY_PREFLIGHT_STALE/);
});

test('Hedge Mode and non-isolated snapshots block entry planning',()=>{
  assert.throws(()=>buildEntryOrderPlan({
    command:{id:'cmd-12345678',symbol:'BTCUSDT',side:'BUY',orderType:'MARKET'},
    riskSnapshot:risk({positionMode:'HEDGE'}),now
  }),/POSITION_MODE_NOT_ONE_WAY/);
  assert.throws(()=>buildEntryOrderPlan({
    command:{id:'cmd-12345678',symbol:'BTCUSDT',side:'BUY',orderType:'MARKET'},
    riskSnapshot:risk({marginType:'CROSSED'}),now
  }),/MARGIN_TYPE_NOT_ISOLATED/);
});

test('normal exit is exact LIMIT GTC and reduce-only',()=>{
  const p=buildExitOrderPlan({commandId:'cmd-12345678',symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'NORMAL_LIMIT',targetPrice:51000});
  assert.equal(p.params.side,'SELL');
  assert.equal(p.params.type,'LIMIT');
  assert.equal(p.params.timeInForce,'GTC');
  assert.equal(p.params.price,'51000');
  assert.equal(p.params.reduceOnly,'true');
  assert.equal('priceMatch' in p.params,false);
});

test('protective exit uses LIMIT IOC OPPONENT without explicit price',()=>{
  const p=buildExitOrderPlan({commandId:'cmd-12345678',symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'PROTECTIVE_IOC'});
  assert.equal(p.params.type,'LIMIT');
  assert.equal(p.params.timeInForce,'IOC');
  assert.equal(p.params.priceMatch,'OPPONENT');
  assert.equal('price' in p.params,false);
  assert.equal(p.params.reduceOnly,'true');
});

test('last-resort exit is reduce-only market',()=>{
  const p=buildExitOrderPlan({commandId:'cmd-12345678',symbol:'BTCUSDT',direction:'SHORT',quantity:0.02,exitMode:'MARKET_LAST_RESORT'});
  assert.equal(p.params.side,'BUY');
  assert.equal(p.params.type,'MARKET');
  assert.equal(p.params.reduceOnly,'true');
});

test('protective IOC accepts audited OPPONENT escalation values only',()=>{
  for (const priceMatch of ['OPPONENT','OPPONENT_5','OPPONENT_10','OPPONENT_20']) {
    const p=buildExitOrderPlan({commandId:'cmd-12345678',symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'PROTECTIVE_IOC',priceMatch});
    assert.equal(p.params.priceMatch,priceMatch);
    assert.equal(p.params.timeInForce,'IOC');
    assert.equal('price' in p.params,false);
  }
  assert.throws(()=>buildExitOrderPlan({commandId:'cmd-12345678',symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'PROTECTIVE_IOC',priceMatch:'QUEUE'}),/PRICE_MATCH_INVALID/);
});
