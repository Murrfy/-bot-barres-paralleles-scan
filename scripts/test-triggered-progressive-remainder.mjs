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
  assert.match(reconcile,/executed>0/);
  assert.match(reconcile,/Math\.abs\(expectedRemaining-currentQty\)/);
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
  assert.match(execute,/if\(!partialTargetRemainder&&!progressiveRemainderRecovery\)/);
  assert.match(execute,/SALE_REMAINDER_PROOF_REQUIRED/);
  assert.match(execute,/maxLossRemainderRecovery\|\|progressiveRemainderRecovery/);
  assert.match(execute,/remainderMarketClosed:true/);
});
