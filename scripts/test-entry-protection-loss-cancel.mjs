import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingEntryProtectionLossTargets,
  pendingEntryProtectionLossCancelAllowed,
  pendingEntryPartialFillFlatTargets,
  pendingEntryPartialFillExitStartedTargets,
  pendingEntryCancelRecoveryTargets,
  pendingEntryCancelRecoveryAllowed,
} from '../lib/protective-command.mjs';

const target={
  commandId:'auto-entry-BTCUSDT-abcdef1234567890',
  symbol:'BTCUSDT',direction:'LONG',quantity:0.2,limitPrice:50000,
  entryClientOrderId:'zth-ENT-abcdef123456789012345678',
  protectionClientAlgoId:'zth-MAX-abcdef123456789012345678',
  expiresAt:Date.now()+60000,
};
function report(overrides={}){
  return {
    version:2,status:'MISMATCH',failClosed:true,
    reasons:['ENTRY_TRANSITION_PROTECTION_MISSING'],
    differences:{missingOrders:[],entryTransitions:{missingProtectionPendingEntries:[target]}},
    ...overrides,
  };
}

test('exact pending LIMIT that lost MAX-LOSS is eligible for cancel-only recovery',()=>{
  const r=report();
  assert.deepEqual(pendingEntryProtectionLossTargets(r),[target]);
  assert.equal(pendingEntryProtectionLossCancelAllowed(r,{
    symbol:'BTCUSDT',clientOrderId:target.entryClientOrderId
  }),true);
});

test('another entry cannot borrow the recovery exception',()=>{
  assert.equal(pendingEntryProtectionLossCancelAllowed(report(),{
    symbol:'BTCUSDT',clientOrderId:'zth-ENT-other-123456789012345678'
  }),false);
  assert.equal(pendingEntryProtectionLossCancelAllowed(report(),{
    symbol:'ETHUSDT',clientOrderId:target.entryClientOrderId
  }),false);
});

test('unrelated reconciliation mismatch disables recovery',()=>{
  const r=report({reasons:['ENTRY_TRANSITION_PROTECTION_MISSING','UNTRACKED_BINANCE_POSITION']});
  assert.deepEqual(pendingEntryProtectionLossTargets(r),[]);
});

test('missing-order reason is accepted only for exact lost MAX-LOSS identity',()=>{
  const exact=report({
    reasons:['ENTRY_TRANSITION_PROTECTION_MISSING','MISSING_BINANCE_ORDER'],
    differences:{
      missingOrders:[{orderClass:'ALGO',symbol:'BTCUSDT',clientAlgoId:target.protectionClientAlgoId}],
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


test('flat partial-entry quarantine yields one exact cancel target',()=>{
  const partialTarget={
    ...target,
    maxLossUsd:40,
    protectionTriggerPrice:49800,
    executedQuantity:0.08,
    remainingQuantity:0.12,
    protectionPresent:true,
  };
  const r={
    version:2,status:'CLEAN_REAL_WITH_QUARANTINES',failClosed:false,reasons:[],
    symbolQuarantines:[{
      symbol:'BTCUSDT',direction:'LONG',
      reason:'ENTRY_PARTIAL_FILL_FLAT_RECOVERY_PENDING',
      remainingQuantity:null,since:Date.now(),
    }],
    differences:{entryTransitions:{partialFillFlatEntries:[partialTarget]}},
  };
  const targets=pendingEntryPartialFillFlatTargets(r);
  assert.equal(targets.length,1);
  assert.equal(targets[0].remainingQuantity,0.12);
  assert.equal(targets[0].recoveryKind,undefined);
  const combined=pendingEntryCancelRecoveryTargets(r);
  assert.equal(combined.length,1);
  assert.equal(combined[0].recoveryKind,'PARTIAL_FILL_FLAT');
  assert.equal(pendingEntryCancelRecoveryAllowed(r,{
    symbol:'BTCUSDT',clientOrderId:target.entryClientOrderId
  }),true);
});

test('flat partial-entry recovery rejects inconsistent quantities, wrong quarantine or other entry id',()=>{
  const basePartial={
    ...target,maxLossUsd:40,protectionTriggerPrice:49800,
    executedQuantity:0.08,remainingQuantity:0.12,protectionPresent:true,
  };
  const make=rows=>({
    version:2,status:'CLEAN_REAL_WITH_QUARANTINES',failClosed:false,reasons:[],
    symbolQuarantines:[{
      symbol:'BTCUSDT',direction:'LONG',
      reason:'ENTRY_PARTIAL_FILL_FLAT_RECOVERY_PENDING',since:Date.now()
    }],
    differences:{entryTransitions:{partialFillFlatEntries:rows}},
  });
  assert.deepEqual(pendingEntryPartialFillFlatTargets(make([
    {...basePartial,remainingQuantity:0.11}
  ])),[]);
  const wrong=make([basePartial]);
  wrong.symbolQuarantines[0].reason='ENTRY_WRITEAHEAD_RECOVERY_PENDING';
  assert.deepEqual(pendingEntryPartialFillFlatTargets(wrong),[]);
  assert.equal(pendingEntryCancelRecoveryAllowed(make([basePartial]),{
    symbol:'BTCUSDT',clientOrderId:'zth-ENT-000000000000000000000000'
  }),false);
});


test('sale-started partial entry quarantine yields one exact cancel target',()=>{
  const saleStarted={
    ...target,
    maxLossUsd:40,
    protectionTriggerPrice:49800,
    executedQuantity:0.08,
    remainingQuantity:0.12,
    liveQuantity:0.04,
    protectionPresent:true,
  };
  const r={
    version:2,status:'CLEAN_REAL_WITH_QUARANTINES',failClosed:false,reasons:[],
    symbolQuarantines:[{
      symbol:'BTCUSDT',direction:'LONG',
      reason:'ENTRY_PARTIAL_FILL_EXIT_STARTED_RECOVERY_PENDING',
      remainingQuantity:null,since:Date.now(),
    }],
    differences:{entryTransitions:{partialFillExitStartedEntries:[saleStarted]}},
  };
  const targets=pendingEntryPartialFillExitStartedTargets(r);
  assert.equal(targets.length,1);
  assert.equal(targets[0].executedQuantity,0.08);
  assert.equal(targets[0].liveQuantity,0.04);
  assert.equal(targets[0].remainingQuantity,0.12);
  const combined=pendingEntryCancelRecoveryTargets(r);
  assert.equal(combined.length,1);
  assert.equal(combined[0].recoveryKind,'PARTIAL_FILL_EXIT_STARTED');
  assert.equal(pendingEntryCancelRecoveryAllowed(r,{
    symbol:'BTCUSDT',clientOrderId:target.entryClientOrderId
  }),true);
});

test('sale-started partial entry recovery rejects a live quantity that has not been reduced',()=>{
  const row={
    ...target,maxLossUsd:40,protectionTriggerPrice:49800,
    executedQuantity:0.08,remainingQuantity:0.12,liveQuantity:0.08,
    protectionPresent:true,
  };
  const r={
    version:2,status:'CLEAN_REAL_WITH_QUARANTINES',failClosed:false,reasons:[],
    symbolQuarantines:[{
      symbol:'BTCUSDT',direction:'LONG',
      reason:'ENTRY_PARTIAL_FILL_EXIT_STARTED_RECOVERY_PENDING',since:Date.now(),
    }],
    differences:{entryTransitions:{partialFillExitStartedEntries:[row]}},
  };
  assert.deepEqual(pendingEntryPartialFillExitStartedTargets(r),[]);
  assert.deepEqual(pendingEntryCancelRecoveryTargets(r),[]);
});
