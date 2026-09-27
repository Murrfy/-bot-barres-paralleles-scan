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
  assert.match(reduced,/writesEnabled:false/);
  assert.match(reduced,/marketResult\.disposition!=='EXISTING'/);
  assert.match(execute,/SALE_REMAINDER_PREVIOUS_ATTEMPT_NOT_FOUND/);
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

test('four MARKET attempts stay bounded and never advance to an untracked fifth identity',()=>{
  assert.match(execute,/Number\(recoveryState\.nextAttempt\)<4/);
  assert.match(execute,/if\(attempt>=3\)/);
  assert.match(execute,/SALE_REMAINDER_MARKET_RECOVERY_EXHAUSTED/);
  assert.match(execute,/nextAttempt<0\|\|nextAttempt>3/);
});
