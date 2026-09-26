import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEntryTransition,
  transitionProtectionMatches,
  transitionEntryMatches,
  evaluateEntryTransitionReconciliation,
} from '../lib/entry-transition.mjs';

const now=2000000;
const base={
  version:1,state:'PROTECTION_PREPARED',commandId:'entry-BTCUSDT-12345678',
  symbol:'BTCUSDT',side:'BUY',direction:'LONG',quantity:0.2,limitPrice:50000,maxLossUsd:400,
  protectionTriggerPrice:48000,protectionClientAlgoId:'zth-MAX-abcdef123456789012345678',
  entryClientOrderId:'',createdAt:now-1000,expiresAt:now+59000,validatedAt:now-10000,
  controllerRevision:14,masterDeviceId:'zenith-server-engine-v1',masterRoleEpoch:'123',
  engineInstanceId:'engine-instance-test',
};
const protection={
  orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',
  timeInForce:'IOC',closePosition:false,reduceOnly:true,origQty:'0.2',priceMatch:'OPPONENT',triggerPrice:'48000',
  clientAlgoId:'zth-MAX-abcdef123456789012345678'
};
const entry={
  orderClass:'STANDARD',symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',type:'LIMIT',
  timeInForce:'GTC',reduceOnly:false,origQty:'0.2',price:'50000',
  clientOrderId:'zth-ENT-abcdef123456789012345678'
};

test('valid transition is short-lived, authority-bound and inside hard loss cap',()=>{
  const r=normalizeEntryTransition(base,{now});
  assert.equal(r.ok,true);
  assert.equal(r.transition.impliedLossUsd,400);
  assert.equal(r.transition.controllerRevision,14);
});

test('expired, over-cap or authority-less transitions never grant an exception',()=>{
  assert.equal(normalizeEntryTransition({...base,expiresAt:now},{now}).ok,false);
  assert.equal(normalizeEntryTransition({...base,protectionTriggerPrice:47999},{now}).ok,false);
  assert.equal(normalizeEntryTransition({...base,engineInstanceId:''},{now}).ok,false);
});

test('only exact MAX-LOSS identity is accepted for the prepared transition',()=>{
  const tr=normalizeEntryTransition(base,{now}).transition;
  assert.equal(transitionProtectionMatches(protection,tr),true);
  assert.equal(transitionProtectionMatches({...protection,clientAlgoId:'zth-MAX-other'},tr),false);
  assert.equal(transitionProtectionMatches({...protection,triggerPrice:'47999'},tr),false);
  assert.equal(transitionProtectionMatches({...protection,timeInForce:'GTC'},tr),false);
});

test('ENTRY_SUBMITTED accepts only exact deterministic LIMIT leg',()=>{
  const record={...base,state:'ENTRY_SUBMITTED',entryClientOrderId:entry.clientOrderId};
  const tr=normalizeEntryTransition(record,{now}).transition;
  assert.equal(transitionEntryMatches(entry,tr),true);
  assert.equal(transitionEntryMatches({...entry,price:'50001'},tr),false);
  assert.equal(transitionEntryMatches({...entry,reduceOnly:true},tr),false);
});

test('prepared transition requires its protection and exempts only that exact orphan',()=>{
  const a=evaluateEntryTransitionReconciliation({
    transitions:[base],actualOrders:[protection],actualPositions:[],now
  });
  assert.deepEqual(a.missingProtections,[]);
  assert.deepEqual(a.missingEntries,[]);
  assert.equal(a.allowedOrderIdentities.has('BTCUSDT:algo-client:'+protection.clientAlgoId),true);

  const b=evaluateEntryTransitionReconciliation({
    transitions:[base],actualOrders:[],actualPositions:[],now
  });
  assert.deepEqual(b.missingProtections,['BTCUSDT:LONG']);
});

test('submitted transition requires entry order until a matching position exists',()=>{
  const record={...base,state:'ENTRY_SUBMITTED',entryClientOrderId:entry.clientOrderId};
  const pending=evaluateEntryTransitionReconciliation({
    transitions:[record],actualOrders:[protection,entry],actualPositions:[],now
  });
  assert.deepEqual(pending.missingEntries,[]);
  assert.equal(pending.allowedOrderIdentities.has('BTCUSDT:client:'+entry.clientOrderId),true);

  const filled=evaluateEntryTransitionReconciliation({
    transitions:[record],actualOrders:[protection],
    actualPositions:[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.2'}],now
  });
  assert.deepEqual(filled.missingEntries,[]);
});
