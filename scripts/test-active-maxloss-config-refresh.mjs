import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const sync=fs.readFileSync('api/zenith-sync.js','utf8');

function block(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start+' block missing');
  return source.slice(a,b);
}

test('engine accepts config drift only for non-active tokens with safe token settings',()=>{
  const fn=block(worker,'function activeSafeTokenConfigRefreshAllowed','async function syncControllerConfig');
  assert.match(fn,/activeRuntimeSymbols\(\)/);
  assert.match(fn,/\['manualTokens','validated','tokenSettings'\]/);
  assert.match(fn,/stableStringify\(currentConfig\.settings\|\|\{\}\)!==stableStringify\(nextConfig\.settings\|\|\{\}\)/);
  assert.match(fn,/active\.has\(String\(rawSymbol\|\|''\)\.toUpperCase\(\)\)/);
  assert.match(fn,/if\(!nextToken\)continue/);
  assert.match(fn,/maxLoss>=2/);
  assert.doesNotMatch(fn,/REAL_RISK_LIMITS\.maxLossUsd/);
  assert.match(fn,/maxLoss>margin\+1e-8/);
  assert.match(fn,/ISOLATED/);
  assert.match(fn,/target>0/);
  assert.match(fn,/manual>0/);
  assert.match(fn,/exactEnabled&&!\(exactPrice>0\)/);
  assert.match(fn,/validActiveProtectionStages\(nextToken\.protectionStages\)/);
  assert.doesNotMatch(fn,/safeMutable/);
  assert.doesNotMatch(fn,/return changed===1/);
});

test('engine only applies that restricted drift after server already reports synchronized state',()=>{
  const fn=block(worker,'async function syncControllerConfig','async function loadAutoHighWater');
  assert.match(fn,/if\(data\.synchronized===true&&!localMatches\)/);
  assert.match(fn,/activeSafeTokenConfigRefreshAllowed\(runtime\.config,controllerState\.data\)/);
  assert.match(fn,/ENGINE_LOCAL_CONFIG_DRIFT_ACTIVE/);
  assert.match(fn,/const applied=await applyControllerState\(controllerState\)/);
  assert.match(fn,/runtime\.appliedRevision=applied\.revision/);
});

test('active MAX-LOSS ACK commits controller state and MASTER applied revision atomically',()=>{
  const fn=block(sync,'async function completeProcessingCommandAtomic','function masterAuthorityMutationCode');
  assert.match(fn,/KEY_CONTROLLER_STATE/);
  assert.match(fn,/KEY_CONTROLLER_REV/);
  assert.match(fn,/KEY_MASTER_CONFIG_ACK/);
  assert.match(fn,/expectedStateHash/);
  assert.match(fn,/redis\.call\('SET', KEYS\[7\], ARGV\[11\]\)/);
  assert.match(fn,/redis\.call\('SET', KEYS\[9\], ARGV\[13\]\)/);
  const ack=block(sync,"if (action === 'command-ack' && req.method === 'POST')","if (action === 'command-fail' && req.method === 'POST')");
  assert.match(ack,/await completeProcessingCommandAtomic\(raw, commandId, device\)/);
  assert.match(ack,/await completeProcessingCommandAtomic\(raw, commandId, device, controllerCompletion\)/);
});


test('MAX-LOSS overlap is reconciled before old stop cancellation and only for the authorized pair',()=>{
  const overlap=block(worker,'function authorizedMaxLossOverlapReport','async function reconcile');
  assert.match(overlap,/AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION/);
  assert.match(overlap,/authorizedPendingMaxLossEdits/);
  assert.match(overlap,/ambiguousMaxLossProtections/);
  assert.match(overlap,/missingMaxLossProtections/);
  assert.match(overlap,/unsafeMaxLossProtections/);
  assert.match(overlap,/previousClientAlgoId/);
  assert.match(overlap,/newClientAlgoId/);

  const reconcile=block(worker,'async function reconcile(secondPass=false)','async function awaitReconciliation');
  assert.match(reconcile,/maxLossOverlap=authorizedMaxLossOverlapReport\(data\.report\)/);
  assert.match(reconcile,/MAX_LOSS_REPLACEMENT_IN_PROGRESS/);
  assert.match(reconcile,/markUserStreamReconciled/);

  const update=block(worker,'async function runProtectiveUpdate','async function waitForFullCloseState');
  const place=update.indexOf('newClientId=await placeNew({deferReconcile:maxLoss})');
  const overlapCheck=update.indexOf('const overlapReady=await awaitReconciliation()');
  const cancel=update.indexOf('await cancelOld(newClientId)');
  assert.ok(place>=0&&overlapCheck>place&&cancel>overlapCheck,'safe overlap must reconcile before old MAX-LOSS cancellation');
});
