import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('24/7 engine repairs one exact missing MAX-LOSS before accepting reconciliation',()=>{
  assert.match(worker,/buildMaxLossRepairPlan/);
  assert.match(worker,/repairMissingMaxLoss\(data\.report\)/);
  assert.match(worker,/AUTO_MAX_LOSS_REPAIR_/);
  assert.doesNotMatch(worker,/syncApi\('emergency-stop'/);
  assert.match(worker,/protectionKind:'MAX_LOSS'/);
  assert.match(worker,/phase:'PLACE_NEW'/);
  assert.match(worker,/String\(order\?\.type\|\|''\)\.toUpperCase\(\)==='STOP'/);
  assert.match(worker,/String\(order\?\.timeInForce\|\|''\)\.toUpperCase\(\)==='IOC'/);
  assert.match(worker,/order\?\.reduceOnly===true/);
  assert.match(worker,/!\(order\?\.closePosition===true\|\|order\?\.closePosition==='true'\)/);
  assert.match(worker,/String\(order\?\.priceMatch\|\|''\)\.toUpperCase\(\)==='OPPONENT'/);
  assert.match(worker,/return reconcile\(true\)/);
});

test('ambiguous or failed repair remains fail-closed without closing the position',()=>{
  assert.match(worker,/if\(plan\.action!=='REPAIR'\)/);
  assert.match(worker,/markMaxLossRepairFailure/);
  assert.match(worker,/AUTO_MAX_LOSS_REPAIR_RECONCILIATION_FAILED/);
  const start=worker.indexOf('async function repairMissingMaxLoss');
  const end=worker.indexOf('function authorizedMaxLossOverlapReport',start);
  const repairBlock=worker.slice(start,end);
  assert.doesNotMatch(repairBlock,/runFullClose|EXEC_CLOSE_POSITION|MARKET_LAST_RESORT|emergency-stop/);
});


test('triggered MAX-LOSS remainder is routed through deterministic LIMIT IOC escalation before generic repair',()=>{
  assert.match(worker,/triggeredMaxLossRemainderTargets/);
  assert.match(worker,/recoverTriggeredMaxLossRemainder/);
  const start=worker.indexOf('async function recoverTriggeredMaxLossRemainder');
  const end=worker.indexOf('async function reconcile',start);
  const block=worker.slice(start,end);
  assert.match(block,/recoveryReason:'TRIGGERED_MAX_LOSS_REMAINDER'/);
  assert.match(block,/exitMode:'PROTECTIVE_IOC'/);
  assert.match(block,/attempt:target\.nextAttempt/);
  assert.match(block,/priceMatch:target\.priceMatch/);
  assert.doesNotMatch(block,/MARKET/);
  const reconcileStart=worker.indexOf('async function reconcile');
  const remainderAt=worker.indexOf('const triggeredRemainders=',reconcileStart);
  const genericRepairAt=worker.indexOf('const repairTarget=missingMaxLossRepairTarget',reconcileStart);
  assert.ok(remainderAt>reconcileStart&&genericRepairAt>remainderAt,'remainder recovery must run before generic MAX-LOSS repair');
});


test('ambiguous MAX-LOSS remainder write triggers immediate read-only reconciliation',()=>{
  const start=worker.indexOf('async function recoverTriggeredMaxLossRemainder');
  const end=worker.indexOf('async function reconcile',start);
  const block=worker.slice(start,end);
  assert.match(block,/const ambiguous=result\.data\?\.ambiguous===true\|\|result\.data\?\.result\?\.ambiguous===true/);
  assert.match(block,/const wrote=result\.data\?\.writeAttempted===true/);
  assert.match(block,/scheduleReconcile\(ambiguous\|\|wrote\?100:500\)/);
  assert.match(block,/scheduleReconcile\(100\)/);
});


test('unresolved MAX-LOSS remainder states explicitly invalidate stream readiness',()=>{
  const reconcileStart=worker.indexOf('async function reconcile');
  const block=worker.slice(reconcileStart,worker.indexOf('async function awaitReconciliation',reconcileStart));
  assert.match(block,/await invalidateStream\('TRIGGERED_MAX_LOSS_RECOVERY_PENDING'\)/);
  assert.match(block,/AMBIGUOUS_TRIGGERED_MAX_LOSS_REMAINDER/);
  assert.match(block,/INCONSISTENT_TRIGGERED_MAX_LOSS_RESULT/);
  assert.match(block,/TRIGGERED_MAX_LOSS_RECOVERY_EXHAUSTED/);
  assert.match(block,/await invalidateStream\(reason\)/);
});
