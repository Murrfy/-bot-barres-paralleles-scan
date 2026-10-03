import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const execute=fs.readFileSync('api/binance-protective-execute.js','utf8');
const reconcile=fs.readFileSync('api/binance-reconcile.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const command=fs.readFileSync('lib/protective-command.mjs','utf8');

test('sale remainder state is persisted before any MARKET recovery write',()=>{
  assert.match(execute,/KEY_SALE_REMAINDER_RECOVERIES/);
  assert.match(execute,/async function beginSaleRemainderRecovery/);
  assert.match(execute,/async function advanceSaleRemainderRecovery/);
  assert.match(execute,/async function clearSaleRemainderRecovery/);
  const branch=execute.slice(
    execute.indexOf("if(exitMode==='REMAINDER_MARKET'){",execute.indexOf("if(exitMode==='REMAINDER_MARKET'){")+1)
  );
  const begin=branch.indexOf('beginSaleRemainderRecovery(source)');
  const writer=branch.indexOf('placeStandardOrderIdempotent({',begin);
  assert.ok(begin>=0&&writer>begin,'recovery state must exist before first MARKET writer call');
});

test('restart with a smaller live quantity re-queries the same deterministic attempt without posting it again',()=>{
  assert.match(execute,/priorAttemptAlreadyReduced/);
  assert.match(execute,/liveRemaining<attemptQuantity/);
  const reduced=execute.slice(execute.indexOf('if(priorAttemptAlreadyReduced)'),execute.indexOf('}else{',execute.indexOf('if(priorAttemptAlreadyReduced)')));
  assert.match(reduced,/queryOrderByClientId/);
  assert.match(reduced,/marketAttemptIdentityMatches/);
  assert.doesNotMatch(reduced,/placeStandardOrderIdempotent/);
  assert.match(execute,/SALE_REMAINDER_PREVIOUS_ATTEMPT_NOT_FOUND/);
  assert.match(execute,/SALE_REMAINDER_PREVIOUS_ATTEMPT_IDENTITY_MISMATCH/);
  assert.match(execute,/waitMarketAttemptTerminal/);
  assert.match(execute,/SALE_REMAINDER_MARKET_ATTEMPT_PENDING/);
});

test('reconciliation certifies persisted recovery against the real Binance position and cleans closed or expired state',()=>{
  assert.match(reconcile,/KEY_SALE_REMAINDER_RECOVERIES/);
  assert.match(reconcile,/redis\(\['HGETALL', KEY_SALE_REMAINDER_RECOVERIES\]\)/);
  assert.match(reconcile,/function certifiedSaleRemainderRecoveries/);
  assert.match(reconcile,/currentQuantity>attemptQuantity/);
  assert.match(reconcile,/activeSaleRemainderRecoveries/);
  assert.match(reconcile,/SALE_REMAINDER_RECOVERY_STATE_INVALID/);
  assert.match(reconcile,/POSITION_CLOSED/);
  assert.match(reconcile,/EXPIRED/);
  assert.match(reconcile,/pruneSaleRemainderRecoveryAtomic/);
});

test('24/7 engine resumes persisted recovery before discovering a new partial-sale recovery',()=>{
  assert.match(command,/export function persistedSaleRemainderRecoveryTargets/);
  assert.match(command,/export function persistedSaleRemainderRecoveryAllowed/);
  assert.match(worker,/async function recoverPersistedSaleRemainder/);
  assert.match(worker,/recoveryReason:'PERSISTED_SALE_REMAINDER'/);
  const start=worker.indexOf('async function reconcile(secondPass=false)');
  const end=worker.indexOf('async function awaitReconciliation',start);
  const block=worker.slice(start,end);
  const persisted=block.indexOf('recoverPersistedSaleRemainder(data.report)');
  const freshTarget=block.indexOf('recoverImmediatePartialTargetRemainder()');
  const freshProgressive=block.indexOf('triggeredProgressiveRemainderTargets(data.report)');
  assert.ok(persisted>=0&&freshTarget>persisted&&freshProgressive>persisted);
});

test('MAX-LOSS and manual-close remainders use the same persisted MARKET recovery channel',()=>{
  for(const source of [
    'TRIGGERED_MAX_LOSS_REMAINDER',
    'INCOMPLETE_PROTECTIVE_CLOSE_REMAINDER',
  ]){
    assert.match(execute,new RegExp(source));
    assert.match(reconcile,new RegExp(source));
    assert.match(command,new RegExp(source));
  }

  const maxStart=worker.indexOf('async function recoverTriggeredMaxLossRemainder');
  const maxEnd=worker.indexOf('async function reconcile(secondPass=false)',maxStart);
  assert.ok(maxStart>=0&&maxEnd>maxStart);
  const maxBlock=worker.slice(maxStart,maxEnd);
  assert.match(maxBlock,/exitMode:'REMAINDER_MARKET'/);
  assert.match(maxBlock,/recoveryReason:'TRIGGERED_MAX_LOSS_REMAINDER'/);
  assert.match(maxBlock,/MAX_LOSS_REMAINDER_MARKET_CLOSED/);
  assert.doesNotMatch(maxBlock,/exitMode:'PROTECTIVE_IOC'/);

  const closeStart=worker.indexOf('async function runFullClose');
  const closeEnd=worker.indexOf('async function commandCycle',closeStart);
  assert.ok(closeStart>=0&&closeEnd>closeStart);
  const closeBlock=worker.slice(closeStart,closeEnd);
  const initial=closeBlock.indexOf('exitMode:policy.exitMode');
  const market=closeBlock.indexOf("exitMode:'REMAINDER_MARKET'");
  assert.ok(initial>=0&&market>initial,'manual close must try LIMIT IOC before MARKET remainder');
  assert.match(closeBlock,/recoveryReason:'INCOMPLETE_PROTECTIVE_CLOSE_REMAINDER'/);
  assert.match(closeBlock,/previousClientOrderId:firstClientOrderId/);
  assert.doesNotMatch(closeBlock,/for\(const policy of policies\)/);
});

test('manual-close MARKET proof is direct, deterministic and engine-only',()=>{
  assert.match(execute,/async function incompleteProtectiveCloseRemainderProof/);
  assert.match(execute,/queryOrderByClientId/);
  assert.match(execute,/exitMode:'PROTECTIVE_IOC',attempt:0,priceMatch:'OPPONENT'/);
  assert.match(execute,/INCOMPLETE_PROTECTIVE_REMAINDER_PROOF_REQUIRED/);
  assert.match(execute,/INCOMPLETE_PROTECTIVE_REMAINDER_ENGINE_REQUIRED/);
  assert.match(execute,/sameQuantity\(live,requestedQty\)/);
});

test('four MARKET attempts stay bounded and never advance to an untracked fifth identity',()=>{
  assert.match(execute,/Number\(recoveryState\.nextAttempt\)<4/);
  assert.match(execute,/if\(attempt>=3\)/);
  assert.match(execute,/SALE_REMAINDER_MARKET_RECOVERY_EXHAUSTED/);
  assert.match(execute,/nextAttempt<0\|\|nextAttempt>3/);
});


test('an exhausted persisted sale remainder stays local and does not abort unrelated reconciliation',()=>{
  const recoverStart=worker.indexOf('async function recoverPersistedSaleRemainder');
  const recoverEnd=worker.indexOf('async function recoverTriggeredProgressiveRemainder',recoverStart);
  assert.ok(recoverStart>=0&&recoverEnd>recoverStart);
  const recoverBlock=worker.slice(recoverStart,recoverEnd);
  assert.match(recoverBlock,/localOnly/);
  assert.match(recoverBlock,/SALE_REMAINDER_MARKET_RECOVERY_EXHAUSTED/);

  const reconcileStart=worker.indexOf('async function reconcile(secondPass=false)');
  const reconcileEnd=worker.indexOf('async function awaitReconciliation',reconcileStart);
  assert.ok(reconcileStart>=0&&reconcileEnd>reconcileStart);
  const reconcileBlock=worker.slice(reconcileStart,reconcileEnd);
  assert.match(reconcileBlock,/persistedSaleRemainder\.localOnly/);
  assert.match(reconcileBlock,/PERSISTED_SALE_REMAINDER_LOCAL_QUARANTINE/);
  assert.match(reconcileBlock,/ensureAutomaticTargets/);
});
