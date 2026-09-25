import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreparedEntryBundle } from '../lib/entry-bundle.mjs';

const now=1000000;
const risk={
  ready:true,observedAt:now-100,
  normalized:{
    symbol:'BTCUSDT',margin:1000,leverage:10,maxLoss:400,
    referencePrice:50000,quantity:0.2,positionMode:'ONE_WAY',marginType:'ISOLATED',
    priceTickSize:0.1,minPrice:0.1,maxPrice:1000000,
  }
};
const base={
  command:{id:'entry-intent-12345678',symbol:'BTCUSDT',side:'BUY',orderType:'LIMIT',limitPrice:50000,margin:1000,leverage:10,maxLoss:400,targetProfit:40},
  riskSnapshot:risk,validatedAt:900000,controllerRevision:14,
  masterDeviceId:'zenith-server-engine-v1',masterRoleEpoch:'123',
  engineInstanceId:'engine-instance-test',now,
};

test('prepared entry bundle deterministically binds LIMIT entry and pre-entry MAX-LOSS',()=>{
  const a=buildPreparedEntryBundle(base);
  const b=buildPreparedEntryBundle(base);
  assert.equal(a.entryPlan.params.type,'LIMIT');
  assert.equal(a.entryPlan.params.timeInForce,'GTC');
  assert.equal(a.entryPlan.params.reduceOnly,'false');
  assert.equal(a.entryPlan.params.newClientOrderId,b.entryPlan.params.newClientOrderId);
  assert.equal(a.protectionPlan.protectionKind,'MAX_LOSS');
  assert.equal(a.protectionPlan.params.type,'STOP_MARKET');
  assert.equal(a.protectionPlan.params.closePosition,'true');
  assert.equal(a.protectionPlan.params.clientAlgoId,b.protectionPlan.params.clientAlgoId);
  assert.equal(a.transition.protectionClientAlgoId,a.protectionPlan.params.clientAlgoId);
  assert.equal(a.transition.quantity,0.2);
  assert.equal(a.transition.protectionTriggerPrice,48000);
  assert.ok(a.transition.impliedLossUsd<=400);
});

test('prepared entry bundle fails closed on stale preflight or missing authority',()=>{
  assert.throws(()=>buildPreparedEntryBundle({...base,riskSnapshot:{...risk,observedAt:now-6000}}),/ENTRY_PREFLIGHT_STALE/);
  assert.throws(()=>buildPreparedEntryBundle({...base,engineInstanceId:''}),/ENTRY_TRANSITION_AUTHORITY_INVALID/);
});

test('prepared short bundle puts MAX-LOSS above entry and keeps deterministic SELL LIMIT',()=>{
  const shortRisk={...risk,normalized:{...risk.normalized,referencePrice:50000}};
  const bundle=buildPreparedEntryBundle({
    ...base,
    command:{...base.command,id:'short-entry-12345678',side:'SELL'},
    riskSnapshot:shortRisk,
  });
  assert.equal(bundle.entryPlan.params.side,'SELL');
  assert.equal(bundle.transition.direction,'SHORT');
  assert.ok(bundle.transition.protectionTriggerPrice>50000);
  assert.equal(bundle.protectionPlan.params.side,'BUY');
});
