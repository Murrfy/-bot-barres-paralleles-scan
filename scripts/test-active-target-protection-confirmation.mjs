import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const protectiveApi=fs.readFileSync('api/binance-protective-update-execute.js','utf8');
const controller=fs.readFileSync('lib/controller-real-command.mjs','utf8');
const dispatch=fs.readFileSync('lib/master-command-dispatch.mjs','utf8');

function block(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start+' block missing');
  return source.slice(a,b);
}

test('active target and progressive table never pre-write controller state',()=>{
  const save=block(html,'async function saveRealActiveTokenSettings','async function saveToken()');
  assert.match(save,/activeConfig=\{/);
  assert.match(save,/protectionStages:nextProtections/);
  assert.match(save,/queueRealProtectiveUpdate\(position,'EXIT'/);
  assert.match(save,/queueRealActiveConfigUpdate\(position,activeConfig\)/);
  assert.doesNotMatch(save,/syncControllerCloudStateNow\(/);
  assert.doesNotMatch(save,/tokenSettings\[s\]=/);
});

test('active target and protection commands carry deterministic config identity',()=>{
  assert.match(controller,/buildControllerUpdateExitCommand\(position, targetPrice, previousClientOrderId = '', activeConfig = null, configDigest = ''\)/);
  assert.match(controller,/activeConfig && typeof activeConfig === 'object'/);
  assert.match(controller,/buildControllerActiveConfigCommand/);
  assert.match(controller,/ACTIVE_CONFIG_DIGEST_REQUIRED/);
  assert.match(controller,/type:'EXEC_UPDATE_ACTIVE_CONFIG'/);
  assert.match(dispatch,/EXEC_UPDATE_ACTIVE_CONFIG/);
});

test('iPhone persists active changes before POST and only commits local settings from terminal ACK hash',()=>{
  const queue=block(html,'async function queueRealProtectiveUpdate','async function queueRealActiveConfigUpdate');
  assert.match(queue,/activeConfig:trackedConfig,clientCommandId:String\(command\?\.clientCommandId\|\|''\)/);
  assert.match(queue,/persistRealProtectiveUpdatePending\(\);[\s\S]*fetch\('\/api\/zenith-sync\?action=command'/);
  assert.match(queue,/réponse d’envoi indéterminée/);

  const activeQueue=block(html,'async function queueRealActiveConfigUpdate','function renderRealEntryOrders');
  assert.match(activeQueue,/clientCommandId:String\(command\.clientCommandId\|\|''\)/);
  assert.match(activeQueue,/persistRealProtectiveUpdatePending\(\);[\s\S]*fetch\('\/api\/zenith-sync\?action=command'/);

  const status=block(html,'async function checkRealTrackedCommandStatus','function reconcileRealProtectiveUpdatePending');
  assert.match(status,/q\.activeConfigCommitted===true/);
  assert.match(status,/stableStringify\(returnedConfig\)===stableStringify\(wantedConfig\)/);
  assert.match(status,/localStateHash===serverStateHash/);
  assert.match(status,/tokenSettings=nextTokenSettings/);
  assert.match(status,/saveLocalOnly\(\)/);
  assert.doesNotMatch(status,/syncControllerCloudStateNow\(/);
});

test('server accepts only narrow active fields while protection-only commands cannot change target',()=>{
  const validator=block(sync,'function activeConfigStatus','function execUpdatePayloadStatus');
  assert.match(validator,/targetProfit.*manualTargetProfit.*protectionStages/s);
  assert.match(validator,/exactSaleEnabled.*exactSalePrice.*exactSaleSource/s);
  assert.match(validator,/ACTIVE_CONFIG_FIELD_INVALID/);
  assert.match(validator,/ACTIVE_EXACT_SALE_PRICE_MUST_BE_ZERO/);

  const commit=block(sync,'async function prepareActiveConfigControllerCommit','async function completeProcessingCommandAtomic');
  assert.doesNotMatch(commit,/ACTIVE_EXIT_CANNOT_CHANGE_PROTECTIONS/);
  assert.match(commit,/ACTIVE_PROTECTIONS_CANNOT_CHANGE_TARGET/);
  assert.match(commit,/CONFIGURED_MAX_LOSS_INVALID/);
  assert.match(commit,/CONFIGURED_MARGIN_TYPE_INVALID/);
  assert.match(commit,/nextRevision = revision \+ 1/);
  assert.match(commit,/stateHash:nextStateHash/);
});

test('confirmed active target price is tied to exact sale or requested dollar target before Binance write',()=>{
  assert.match(protectiveApi,/ACTIVE_EXACT_SALE_PRICE_MISMATCH/);
  assert.match(protectiveApi,/ACTIVE_TARGET_PRICE_PROFIT_MISMATCH/);
  assert.match(protectiveApi,/allowedRounding=tick\*live\.liveQuantity\+1e-8/);
  assert.match(protectiveApi,/actualTargetProfit\+1e-8<targetProfit/);
  assert.match(protectiveApi,/buildExitOrderPlan\(\{[\s\S]*exitMode:'NORMAL_LIMIT'/);
});

test('protection-only command preserves high-water and raises any newly due stage before config ACK',()=>{
  const apply=block(worker,'async function applyPendingProtectionTableBeforeConfigCommit','async function safeAckActiveConfigAfterReconcile');
  assert.match(apply,/loadAutoHighWater/);
  assert.match(apply,/observeAutoHighWater/);
  assert.match(apply,/persistAutoHighWaterNow/);
  assert.match(apply,/evaluateMasterAutoProgressiveProtection/);
  assert.match(apply,/if\(plan\.action==='REPLACE'\)/);
  assert.match(apply,/executeAutoProgressive\(plan\)/);

  const run=block(worker,'async function runActiveConfigCommand','async function handleMutationFailure');
  assert.ok(run.indexOf('applyPendingProtectionTableBeforeConfigCommit') < run.indexOf('safeAckActiveConfigAfterReconcile'));
});

test('Render applies only server-ACKed active config and verifies state hash',()=>{
  const ack=block(worker,'async function safeAckActiveConfigAfterReconcile','async function runActiveConfigCommand');
  assert.match(ack,/ack\?\.activeConfigCommitted!==true/);
  assert.match(ack,/validActiveProtectionStages\(activeConfig\.protectionStages\)/);
  assert.match(ack,/sha256Hex\(stableStringify\(runtime\.config\)\)/);
  assert.match(ack,/runtime\.synchronized=localHash===expectedHash/);
  assert.match(ack,/ACTIVE_CONFIG_ACK_HASH_MISMATCH/);

  const refresh=block(worker,'function activeSafeTokenConfigRefreshAllowed','async function syncControllerConfig');
  assert.match(refresh,/safeMutable=new Set/);
  assert.match(refresh,/return changed===1/);
});

test('server command completion atomically couples ACK with controller revision and MASTER applied revision',()=>{
  const complete=block(sync,'async function completeProcessingCommandAtomic','function masterAuthorityMutationCode');
  assert.match(complete,/KEY_CONTROLLER_STATE/);
  assert.match(complete,/KEY_CONTROLLER_REV/);
  assert.match(complete,/KEY_MASTER_CONFIG_ACK/);
  assert.match(complete,/activeConfigCommitted:true/);
  assert.match(complete,/redis\.call\('SET', KEYS\[7\], ARGV\[11\]\)/);
  assert.match(complete,/redis\.call\('SET', KEYS\[9\], ARGV\[13\]\)/);
});
