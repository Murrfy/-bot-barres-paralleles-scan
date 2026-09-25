import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const controllerCommand=fs.readFileSync('lib/controller-real-command.mjs','utf8');
const protectiveCommand=fs.readFileSync('lib/protective-command.mjs','utf8');
const protectiveApi=fs.readFileSync('api/binance-protective-update-execute.js','utf8');
const reconcile=fs.readFileSync('api/binance-reconcile.js','utf8');
const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

function block(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start+' block missing');
  return source.slice(a,b);
}

test('active real MAX-LOSS is editable only when no edit is pending',()=>{
  const locks=block(html,'function setTokenFieldsEnabled()','function updateTokenPreview()');
  assert.match(locks,/const maxLossPending=Boolean\(realActive&&realProtectiveUpdatePending\.get/);
  assert.match(locks,/\$\('tMaxLoss'\)\.disabled=!realActive\|\|maxLossPending/);
  assert.match(locks,/confirmation Binance\/serveur/);
});

test('active MAX-LOSS dollars are calculated from live position and queued separately',()=>{
  const save=block(html,'async function saveRealActiveTokenSettings','async function saveToken()');
  assert.match(save,/requestedMaxLoss>=2&&requestedMaxLoss<=400/);
  assert.match(save,/requestedMaxLoss>configuredMargin/);
  assert.match(save,/maxLossUsd:requestedMaxLoss/);
  assert.match(save,/wantedMaxLoss=n\(levels\.maxLossTriggerPrice,0\)/);
  assert.match(save,/if\(targetChanged\|\|protectionsChanged\)/);
  assert.match(save,/queueRealProtectiveUpdate\(position,'MAX_LOSS',[\s\S]*maxLossUsd:requestedMaxLoss/);
  assert.doesNotMatch(save,/tokenSettings\[s\]=\{[^\n]*maxLoss:requestedMaxLoss/);
});

test('controller command carries bounded requested MAX-LOSS and keeps it in dedupe identity',()=>{
  assert.match(controllerCommand,/maxLossUsd = NaN/);
  assert.match(controllerCommand,/MAX_LOSS_USD_INVALID/);
  assert.match(controllerCommand,/\{ maxLossUsd: requestedMaxLoss \}/);
  assert.match(controllerCommand,/baseCommandId \+ ':' \+ safeIdPart\(compactNumber\(requestedMaxLoss\)/);
  assert.match(protectiveCommand,/payload\.maxLossUsd/);
  assert.match(protectiveCommand,/maxLossUsd>=2&&maxLossUsd<=400/);
});

test('iPhone commits active MAX-LOSS locally only from terminal server ACK metadata',()=>{
  const status=block(html,'async function checkRealMaxLossCommandStatus','function reconcileRealProtectiveUpdatePending()');
  assert.match(status,/status==='ACK'/);
  assert.match(status,/q\.activeMaxLossCommitted===true/);
  assert.match(status,/controllerStateHash/);
  assert.match(status,/nextTokenSettings=\{\.\.\.tokenSettings,\[symbol\]:\{\.\.\.old,maxLoss:confirmedLoss,marginType:'ISOLATED'\}\}/);
  assert.match(status,/localStateHash=Number\.isFinite\(confirmedLoss\)/);
  assert.match(status,/localStateHash===serverStateHash/);
  assert.match(status,/tokenSettings=nextTokenSettings/);
  assert.match(status,/localStorage\.setItem\(ZENITH_CONTROLLER_REV_KEY,String\(revision\)\)/);
  assert.match(status,/saveLocalOnly\(\)/);
  assert.doesNotMatch(status,/syncControllerCloudStateNow\(\)/);
  const reconcileBlock=block(html,'function reconcileRealProtectiveUpdatePending()','async function queueRealProtectiveUpdate');
  assert.match(reconcileBlock,/void checkRealMaxLossCommandStatus\(key,pending\)/);
  assert.match(reconcileBlock,/continue;/);
});

test('active MAX-LOSS submission identity survives iPhone reload without resending the command',()=>{
  assert.match(html,/ZENITH_REAL_PROTECTIVE_PENDING_KEY='zenith_real_protective_pending_v1'/);
  const persist=block(html,'function persistRealProtectiveUpdatePending','async function checkRealMaxLossCommandStatus');
  assert.match(persist,/commandId/);
  assert.match(persist,/clientCommandId/);
  assert.match(persist,/maxLossUsd/);
  assert.match(persist,/localStorage\.setItem\(ZENITH_REAL_PROTECTIVE_PENDING_KEY/);
  assert.match(persist,/restoreRealProtectiveUpdatePending/);
  const status=block(html,'async function checkRealMaxLossCommandStatus','function reconcileRealProtectiveUpdatePending()');
  assert.match(status,/clientCommandId=/);
  assert.match(status,/clientCommandId='\+encodeURIComponent/);
  assert.match(status,/status==='NOT_FOUND'/);
  assert.match(status,/pending\.commandId=resolvedCommandId/);
  const queue=block(html,'async function queueRealProtectiveUpdate','function renderRealEntryOrders');
  assert.match(queue,/clientCommandId:String\(command\?\.clientCommandId\|\|''\)/);
  assert.match(queue,/persistRealProtectiveUpdatePending\(\);[\s\S]*fetch\('\/api\/zenith-sync\?action=command'/);
  assert.match(queue,/réponse d’envoi MAX-LOSS indéterminée/);
  assert.doesNotMatch(queue,/ENVOI_INDETERMINE[\s\S]*fetch\('\/api\/zenith-sync\?action=command'/);
  assert.match(html,/load\(\);restoreRealProtectiveUpdatePending\(\)/);
});

test('Binance protective endpoint validates requested MAX-LOSS against margin and actual trigger loss',()=>{
  assert.match(protectiveApi,/const requestedMaxLoss=n\(update\.maxLossUsd,NaN\)/);
  assert.match(protectiveApi,/const allowedMaxLoss=activeEdit\?requestedMaxLoss:configuredMaxLoss/);
  assert.match(protectiveApi,/MAX_LOSS_EXCEEDS_CONFIGURED_MARGIN/);
  assert.match(protectiveApi,/hardMaxLossUsd:Math\.min\(allowedMaxLoss,REAL_RISK_LIMITS\.maxLossUsd\)/);
});

test('reconciliation authorizes only the exact processing MAX-LOSS command and exact managed Binance stop',()=>{
  assert.match(reconcile,/const KEY_PROCESSING =/);
  const pending=block(reconcile,'function authorizedPendingMaxLossEdit','function enforceConfiguredMaxLossSafety');
  assert.match(pending,/EXEC_UPDATE_PROTECTION/);
  assert.match(pending,/claimedBy/);
  assert.match(pending,/controllerDeviceId/);
  assert.match(pending,/protectionKind \|\| ''\)\.toUpperCase\(\) !== 'MAX_LOSS'/);
  assert.match(pending,/String\(order\?\.type \|\| ''\)\.toUpperCase\(\) === 'STOP_MARKET'/);
  assert.match(pending,/Boolean\(zenithManagedOrderId\(order\)\)/);
  assert.match(pending,/triggerPrice/);
});

test('MAX-LOSS ACK atomically commits command completion and central revision',()=>{
  const complete=block(sync,'async function completeProcessingCommandAtomic','function masterAuthorityMutationCode');
  assert.match(complete,/KEY_CONTROLLER_STATE/);
  assert.match(complete,/KEY_CONTROLLER_REV/);
  assert.match(complete,/KEY_MASTER_CONFIG_ACK/);
  assert.match(complete,/currentController ~= ARGV\[8\]/);
  assert.match(complete,/current\['revision'\]/);
  assert.match(complete,/current\['stateHash'\]/);
  assert.ok(complete.indexOf("redis.call('LREM', KEYS[1]") < complete.indexOf("redis.call('SET', KEYS[7], ARGV[11])"));
  assert.match(sync,/ACTIVE_MAX_LOSS_CONFIG_COMMITTED/);
});

test('Render applies ACKed MAX-LOSS locally and verifies central state hash before staying synchronized',()=>{
  const ack=block(worker,'async function safeAckActiveMaxLossAfterReconcile','async function handleMutationFailure');
  assert.match(ack,/ack\?\.activeMaxLossCommitted!==true/);
  assert.match(ack,/maxLoss:maxLossUsd,marginType:'ISOLATED'/);
  assert.match(ack,/sha256Hex\(stableStringify\(runtime\.config\)\)/);
  assert.match(ack,/runtime\.synchronized=localHash===expectedHash/);
  assert.match(ack,/ACTIVE_MAX_LOSS_ACK_HASH_MISMATCH/);
});
