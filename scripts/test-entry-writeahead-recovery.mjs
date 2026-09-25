import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  pendingEntryWriteAheadRecoveryTargets,
  pendingEntryWriteAheadRecoveryAllowed,
} from '../lib/protective-command.mjs';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const api=fs.readFileSync('api/binance-entry-execute.js','utf8');
const reconcile=fs.readFileSync('api/binance-reconcile.js','utf8');

function report(overrides={}){
  const row={
    commandId:'auto-entry-ABCUSDT-1234567890abcdef1234',
    symbol:'ABCUSDT',
    entrySide:'BUY',
    direction:'LONG',
    quantity:2,
    limitPrice:100,
    maxLossUsd:20,
    entryClientOrderId:'zth-ENT-1234567890abcdef12345678',
    protectionClientAlgoId:'zth-MAX-1234567890abcdef12345678',
    orderClass:'ALGO',
    clientAlgoId:'zth-MAX-1234567890abcdef12345678',
    side:'SELL',
    positionSide:'BOTH',
    type:'STOP_MARKET',
    reduceOnly:false,
    closePosition:true,
    triggerPrice:'90',
    price:'',
    origQty:'',
    timeInForce:'',
    expiresAt:Date.now()+60000,
    ...overrides,
  };
  return {
    version:2,
    status:'MISMATCH',
    failClosed:true,
    reasons:['ENTRY_TRANSITION_ENTRY_MISSING'],
    differences:{entryTransitions:{entryMissingPreparedProtections:[row]}},
  };
}

test('only an exact missing-entry transition with its exact MAX-LOSS is recoverable',()=>{
  const r=report();
  const rows=pendingEntryWriteAheadRecoveryTargets(r);
  assert.equal(rows.length,1);
  assert.equal(rows[0].side,'BUY');
  assert.equal(rows[0].direction,'LONG');
  assert.equal(rows[0].limitPrice,100);
  assert.equal(rows[0].maxLossUsd,20);
  assert.equal(pendingEntryWriteAheadRecoveryAllowed(r,{
    commandId:rows[0].commandId,symbol:'ABCUSDT',side:'BUY',limitPrice:100,maxLoss:20,
  }),true);
});

test('write-ahead recovery refuses any extra reconciliation mismatch or identity drift',()=>{
  const extra=report();
  extra.reasons.push('UNTRACKED_BINANCE_ORDER');
  assert.deepEqual(pendingEntryWriteAheadRecoveryTargets(extra),[]);
  assert.equal(pendingEntryWriteAheadRecoveryAllowed(report(),{
    commandId:'auto-entry-ABCUSDT-1234567890abcdef1234',
    symbol:'ABCUSDT',side:'BUY',limitPrice:101,maxLoss:20,
  }),false);
  assert.deepEqual(pendingEntryWriteAheadRecoveryTargets(report({closePosition:false})),[]);
  assert.deepEqual(pendingEntryWriteAheadRecoveryTargets(report({entrySide:'SELL'})),[]);
});

test('reconciliation proof keeps entry identity separate from protection identity',()=>{
  assert.match(reconcile,/entrySide: transition\.side/);
  assert.match(reconcile,/quantity: transition\.quantity/);
  assert.match(reconcile,/limitPrice: transition\.limitPrice/);
  assert.match(reconcile,/maxLossUsd: transition\.maxLossUsd/);
  assert.match(reconcile,/side: String\(order\.side/);
});

test('entry API opens fail-closed gate only for exact write-ahead recovery proof',()=>{
  assert.match(api,/pendingEntryWriteAheadRecoveryAllowed/);
  assert.match(api,/phase==='SUBMIT_ENTRY'/);
  assert.match(api,/entryReadinessReason\(before,master\.deviceId,pendingEntryRecovery\)/);
  assert.match(api,/entryReadinessReason\(latest,master\.deviceId,latestRecovery\)/);
  assert.match(api,/executionReadiness\(state\.runtimeState,state\.report,masterDeviceId,'',pendingEntryRecovery===true\)/);
});

test('worker replays the same deterministic LIMIT and never substitutes a new price',()=>{
  const start=worker.indexOf('async function recoverPendingEntryWriteAhead');
  const end=worker.indexOf('async function cancelPendingEntriesMissingPreparedProtection',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.match(block,/phase:'SUBMIT_ENTRY'/);
  assert.match(block,/commandId:target\.commandId/);
  assert.match(block,/limitPrice:target\.limitPrice/);
  assert.match(block,/maxLoss:target\.maxLossUsd/);
  assert.match(block,/returnedId!==target\.entryClientOrderId/);
  assert.match(block,/waitForWriteAheadEntryEvidence\(target,5000\)/);
  assert.doesNotMatch(block,/currentBestAsk/);
  assert.doesNotMatch(block,/ticker\/bookTicker/);
});

test('worker accepts recovery only after Binance stream evidence and then reconciles again',()=>{
  assert.match(worker,/\['NEW','PARTIALLY_FILLED','FILLED'\]\.includes\(status\)/);
  assert.match(worker,/\['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'\]\.includes\(status\)/);
  assert.match(worker,/ENTRY_WRITEAHEAD_RECOVERY_RECONCILIATION_FAILED/);
  assert.match(worker,/await sleep\(150\);[\s\S]*return reconcile\(true\)/);
});
