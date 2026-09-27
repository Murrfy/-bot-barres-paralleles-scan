import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const reconcile=fs.readFileSync('api/binance-reconcile.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const execute=fs.readFileSync('api/binance-protective-execute.js','utf8');

test('reconciliation proves a triggered progressive partial fill from parent algo and child LIMIT',()=>{
  assert.match(reconcile,/function evaluateTriggeredProgressiveRemainder/);
  assert.match(reconcile,/function detectTriggeredProgressiveRemainders/);
  assert.match(reconcile,/\/\^zth-PRO-/);
  assert.match(reconcile,/String\(algo\?\.timeInForce\|\|''\)\.toUpperCase\(\)!=='GTC'/);
  assert.match(reconcile,/String\(actualOrder\?\.type\|\|''\)\.toUpperCase\(\)!=='LIMIT'/);
  assert.match(reconcile,/String\(actualOrder\?\.timeInForce\|\|''\)\.toUpperCase\(\)!=='GTC'/);
  assert.match(reconcile,/executed>=0/);
  assert.match(reconcile,/Math\.abs\(expectedRemaining-currentQty\)/);
  assert.match(reconcile,/const profitSide=/);
  assert.match(reconcile,/\/fapi\/v1\/allOrders/);
  assert.match(reconcile,/String\(order\?\.orderId\|\|''\)===String\(algo\.actualOrderId\)/);
  assert.match(reconcile,/triggeredProgressiveRemainders/);
});

test('engine closes progressive remainder before MAX-LOSS repair',()=>{
  assert.match(worker,/triggeredProgressiveRemainderTargets/);
  assert.match(worker,/async function recoverTriggeredProgressiveRemainder/);
  assert.match(worker,/exitMode:'REMAINDER_MARKET'/);
  assert.match(worker,/recoveryReason:'TRIGGERED_PROGRESSIVE_REMAINDER'/);
  assert.match(worker,/PROGRESSIVE_REMAINDER_MARKET_CLOSED/);
  const start=worker.indexOf('async function reconcile(secondPass=false)');
  const end=worker.indexOf('async function awaitReconciliation',start);
  const block=worker.slice(start,end);
  const progressive=block.indexOf('triggeredProgressiveRemainderTargets(data.report)');
  const repair=block.indexOf('missingMaxLossRepairTarget(data.report)');
  assert.ok(progressive>=0&&repair>progressive,'progressive remainder must close before MAX-LOSS repair');
});

test('protective endpoint accepts MARKET only with exact progressive report proof and engine authority',()=>{
  assert.match(execute,/triggeredProgressiveRemainderRecoveryAllowed/);
  assert.match(execute,/PROGRESSIVE_REMAINDER_RECOVERY_ENGINE_REQUIRED/);
  assert.match(execute,/progressiveRemainderRecovery/);
  assert.match(execute,/if\(!partialTargetRemainder&&!progressiveRemainderRecovery&&!maxLossRemainderRecovery\)/);
  assert.match(execute,/SALE_REMAINDER_PROOF_REQUIRED/);
  assert.match(execute,/maxLossRemainderRecovery\|\|progressiveRemainderRecovery/);
  assert.match(execute,/remainderMarketClosed:true/);
});


test('triggered MAX-LOSS remainder uses the same proof-bound MARKET close, never IOC retries',()=>{
  assert.match(worker,/async function recoverTriggeredMaxLossRemainder/);
  const start=worker.indexOf('async function recoverTriggeredMaxLossRemainder');
  const end=worker.indexOf('async function reconcile(secondPass=false)',start);
  const block=worker.slice(start,end);
  assert.match(block,/exitMode:'REMAINDER_MARKET'/);
  assert.match(block,/recoveryReason:'TRIGGERED_MAX_LOSS_REMAINDER'/);
  assert.match(block,/MAX_LOSS_REMAINDER_MARKET_CLOSED/);
  assert.doesNotMatch(block,/OPPONENT_5|OPPONENT_10|OPPONENT_20|exitMode:'PROTECTIVE_IOC'/);
  assert.match(execute,/maxLossRemainderRecovery/);
  assert.match(execute,/MAX_LOSS_REMAINDER_RECOVERY_ENGINE_REQUIRED/);
  assert.match(execute,/!partialTargetRemainder&&!progressiveRemainderRecovery&&!maxLossRemainderRecovery/);
});


test('triggered protective remainders include zero-fill cases because the close intent is already active',()=>{
  const command=fs.readFileSync('lib/protective-command.mjs','utf8');
  assert.match(reconcile,/executed>=0&&executed<original/);
  assert.match(command,/executedQuantity>=0/);
  assert.match(command,/'NEW','PARTIALLY_FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'/);
});
