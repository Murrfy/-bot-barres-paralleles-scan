import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  pendingEntryProtectionLossTargets,
  pendingEntryWriteAheadRecoveryTargets,
  maxLossSymbolIsQuarantined,
  maxLossLocalQuarantineReport,
} from '../lib/protective-command.mjs';

const protectionRow={
  commandId:'auto-entry-BTCUSDT-abcdef1234567890',
  symbol:'BTCUSDT',direction:'LONG',quantity:0.2,limitPrice:50000,
  entryClientOrderId:'zth-ENT-abcdef123456789012345678',
  protectionClientAlgoId:'zth-MAX-abcdef123456789012345678',
  expiresAt:Date.now()+60000,
};
const writeAheadRow={
  commandId:'auto-entry-BTCUSDT-abcdef1234567890',
  symbol:'BTCUSDT',entrySide:'BUY',direction:'LONG',quantity:0.2,limitPrice:50000,maxLossUsd:40,
  entryClientOrderId:'zth-ENT-abcdef123456789012345678',
  protectionClientAlgoId:'zth-MAX-abcdef123456789012345678',
  orderClass:'ALGO',clientAlgoId:'zth-MAX-abcdef123456789012345678',
  side:'SELL',positionSide:'BOTH',type:'STOP',reduceOnly:true,closePosition:false,
  triggerPrice:'49800',priceMatch:'OPPONENT',origQty:'0.2',timeInForce:'IOC',
  expiresAt:Date.now()+60000,
};

function local(reason,differences){
  return {
    version:2,status:'CLEAN_REAL_WITH_QUARANTINES',failClosed:false,reasons:[],
    symbolQuarantines:[{
      symbol:'BTCUSDT',direction:'LONG',reason,remainingQuantity:null,since:Date.now()
    }],
    differences,
  };
}

test('pending entry protection-loss recovery remains available inside exact BTC quarantine',()=>{
  const report=local('ENTRY_PROTECTION_RECOVERY_PENDING',{
    missingOrders:[],
    entryTransitions:{missingProtectionPendingEntries:[protectionRow]},
  });
  assert.equal(maxLossLocalQuarantineReport(report),true);
  assert.equal(maxLossSymbolIsQuarantined(report,'BTCUSDT','LONG'),true);
  assert.equal(maxLossSymbolIsQuarantined(report,'ETHUSDT','LONG'),false);
  assert.deepEqual(pendingEntryProtectionLossTargets(report),[protectionRow]);
});

test('write-ahead recovery remains available inside exact BTC quarantine',()=>{
  const report=local('ENTRY_WRITEAHEAD_RECOVERY_PENDING',{
    entryTransitions:{entryMissingPreparedProtections:[writeAheadRow]},
  });
  const rows=pendingEntryWriteAheadRecoveryTargets(report);
  assert.equal(rows.length,1);
  assert.equal(rows[0].symbol,'BTCUSDT');
  assert.equal(rows[0].direction,'LONG');
  assert.equal(maxLossSymbolIsQuarantined(report,'ETHUSDT','LONG'),false);
});

test('wrong-symbol quarantine cannot authorize an entry recovery',()=>{
  const report=local('ENTRY_PROTECTION_RECOVERY_PENDING',{
    missingOrders:[],
    entryTransitions:{missingProtectionPendingEntries:[{...protectionRow,symbol:'ETHUSDT'}]},
  });
  assert.deepEqual(pendingEntryProtectionLossTargets(report),[]);
});

test('reconciliation localizes only exact entry-transition recovery evidence',()=>{
  const source=fs.readFileSync('api/binance-reconcile.js','utf8');
  const start=source.indexOf('function localizeEntryTransitionRecoveryAnomalies');
  const end=source.indexOf('function expectedPositions',start);
  assert.ok(start>=0&&end>start);
  const block=source.slice(start,end);
  assert.match(block,/ENTRY_PROTECTION_RECOVERY_PENDING/);
  assert.match(block,/ENTRY_WRITEAHEAD_RECOVERY_PENDING/);
  assert.match(block,/ENTRY_TRANSITION_PROTECTION_MISSING/);
  assert.match(block,/ENTRY_TRANSITION_ENTRY_MISSING/);
  assert.match(block,/reasons\.some\(reason=>!allowed\.has\(reason\)\)/);
  assert.match(source,/localizeEntryTransitionRecoveryAnomalies\(result,started\)/);
});

test('worker keeps exact entry recovery failures local and preserves global fallback',()=>{
  const source=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  const start=source.indexOf('async function markEntryTransitionRecoveryFailure');
  const end=source.indexOf('async function waitForWriteAheadEntryEvidence',start);
  assert.ok(start>=0&&end>start);
  const block=source.slice(start,end);
  assert.match(block,/symbolEntryTransitionQuarantined/);
  assert.match(block,/await publishRuntime\(\)\.catch/);
  assert.match(block,/await invalidateStream\(code\)\.catch/);
  assert.match(block,/scheduleReconcile\(1500\)/);

  const recoverStart=source.indexOf('async function recoverPendingEntryWriteAhead');
  const recoverEnd=source.indexOf('async function cancelPendingEntriesMissingPreparedProtection',recoverStart);
  const recover=source.slice(recoverStart,recoverEnd);
  assert.doesNotMatch(recover,/await invalidateStream\(/);
  assert.match(recover,/ENTRY_WRITEAHEAD_RECOVERY_PENDING/);

  const reconcileStart=source.indexOf('const pendingProtectionLoss=pendingEntryProtectionLossTargets');
  const reconcileEnd=source.indexOf('const maxLossOverlap=',reconcileStart);
  const reconcile=source.slice(reconcileStart,reconcileEnd);
  assert.match(reconcile,/ENTRY_PROTECTION_RECOVERY_PENDING/);
  assert.match(reconcile,/ENTRY_WRITEAHEAD_RECOVERY_PENDING/);
});
