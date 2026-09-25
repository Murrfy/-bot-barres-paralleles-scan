import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingEntryProtectionLossTargets,
  pendingEntryProtectionLossCancelAllowed,
} from '../lib/protective-command.mjs';

const target={
  commandId:'auto-entry-BTCUSDT-abcdef1234567890',
  symbol:'BTCUSDT',
  direction:'LONG',
  quantity:0.2,
  limitPrice:50000,
  entryClientOrderId:'zth-ENT-abcdef123456789012345678',
  protectionClientAlgoId:'zth-MAX-abcdef123456789012345678',
  expiresAt:Date.now()+60000,
};
function report(overrides={}){
  return {
    version:2,
    status:'MISMATCH',
    failClosed:true,
    reasons:['ENTRY_TRANSITION_PROTECTION_MISSING'],
    differences:{
      missingOrders:[],
      entryTransitions:{missingProtectionPendingEntries:[target]},
    },
    ...overrides,
  };
}

test('exact pending LIMIT that lost its MAX-LOSS is eligible for cancel-only recovery',()=>{
  const r=report();
  assert.deepEqual(pendingEntryProtectionLossTargets(r),[target]);
  assert.equal(pendingEntryProtectionLossCancelAllowed(r,{
    symbol:'BTCUSDT',clientOrderId:target.entryClientOrderId
  }),true);
});

test('different pending entry can never borrow the recovery exception',()=>{
  assert.equal(pendingEntryProtectionLossCancelAllowed(report(),{
    symbol:'BTCUSDT',clientOrderId:'zth-ENT-other-123456789012345678'
  }),false);
  assert.equal(pendingEntryProtectionLossCancelAllowed(report(),{
    symbol:'ETHUSDT',clientOrderId:target.entryClientOrderId
  }),false);
});

test('unrelated reconciliation mismatch disables cancel-only recovery',()=>{
  const r=report({reasons:['ENTRY_TRANSITION_PROTECTION_MISSING','UNTRACKED_BINANCE_POSITION']});
  assert.deepEqual(pendingEntryProtectionLossTargets(r),[]);
});

test('a stale runtime missing-order reason is accepted only for the exact lost MAX-LOSS identity',()=>{
  const exact=report({
    reasons:['ENTRY_TRANSITION_PROTECTION_MISSING','MISSING_BINANCE_ORDER'],
    differences:{
      missingOrders:[{
        orderClass:'ALGO',symbol:'BTCUSDT',clientAlgoId:target.protectionClientAlgoId
      }],
      entryTransitions:{missingProtectionPendingEntries:[target]},
    },
  });
  assert.equal(pendingEntryProtectionLossCancelAllowed(exact,{
    symbol:'BTCUSDT',clientOrderId:target.entryClientOrderId
  }),true);

  const unrelated=structuredClone(exact);
  unrelated.differences.missingOrders.push({
    orderClass:'STANDARD',symbol:'ETHUSDT',clientOrderId:'manual-other'
  });
  assert.deepEqual(pendingEntryProtectionLossTargets(unrelated),[]);
});

test('live-position protection repair is never classified as a pending-entry cancel',()=>{
  const r=report({
    reasons:['MISSING_BINANCE_PROTECTION','MISSING_BINANCE_MAX_LOSS_PROTECTION'],
    differences:{
      missingMaxLossProtections:['BTCUSDT:LONG'],
      entryTransitions:{missingProtectionPendingEntries:[]},
    },
  });
  assert.deepEqual(pendingEntryProtectionLossTargets(r),[]);
});
