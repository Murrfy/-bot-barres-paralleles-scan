import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateMasterAutoProgressiveProtection } from '../lib/master-auto-protection.mjs';

const html=fs.readFileSync('index.html','utf8');
const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const controller=fs.readFileSync('lib/controller-real-command.mjs','utf8');
const dispatch=fs.readFileSync('lib/master-command-dispatch.mjs','utf8');

function block(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start+' block missing');
  return source.slice(a,b);
}

test('active target and protection settings remain unchanged locally and centrally until ACK',()=>{
  const save=block(html,'async function saveRealActiveTokenSettings','async function saveToken()');
  assert.match(save,/if\(targetChanged&&protectionsChanged\)/);
  assert.match(save,/modifie l’objectif de vente et le tableau des protections séparément/);
  assert.match(save,/const activeConfig=\{/);
  assert.match(save,/queueRealProtectiveUpdate\(position,'EXIT',[\s\S]*activeConfig/);
  assert.match(save,/queueRealActiveConfigUpdate\(position,activeConfig\)/);
  assert.doesNotMatch(save,/tokenSettings\[s\]\s*=/);
  assert.doesNotMatch(save,/syncControllerCloudStateNow\(/);

  const status=block(html,'async function checkRealTrackedCommandStatus','function reconcileRealProtectiveUpdatePending()');
  assert.match(status,/q\.activeConfigCommitted===true/);
  assert.match(status,/stableStringify\(returnedConfig\)===stableStringify\(wantedConfig\)/);
  assert.match(status,/localStateHash===serverStateHash/);
  assert.ok(status.indexOf('tokenSettings=nextTokenSettings')>status.indexOf('const ackValid='));
});

test('tracked active edit survives reload and ambiguous network response without command resend',()=>{
  const pending=block(html,'function persistRealProtectiveUpdatePending','function reconcileRealProtectiveUpdatePending()');
  assert.match(pending,/clientCommandId/);
  assert.match(pending,/activeConfig/);
  assert.match(pending,/30\*24\*60\*60\*1000/);
  assert.match(pending,/clientCommandId='\+encodeURIComponent/);
  assert.match(pending,/status==='NOT_FOUND'/);

  const queue=block(html,'async function queueRealProtectiveUpdate','async function queueRealActiveConfigUpdate');
  assert.match(queue,/clientCommandId:String\(command\?\.clientCommandId\|\|''\)/);
  assert.match(queue,/persistRealProtectiveUpdatePending\(\)/);
  assert.match(queue,/réponse d’envoi indéterminée/);
  assert.match(queue,/checkRealTrackedCommandStatus/);
});

test('active config payload cannot smuggle margin leverage buy or MAX-LOSS changes',()=>{
  const validator=block(sync,'function activeConfigStatus','function execUpdatePayloadStatus');
  assert.match(validator,/targetProfit/);
  assert.match(validator,/manualTargetProfit/);
  assert.match(validator,/protectionStages/);
  assert.match(validator,/exactSaleEnabled/);
  assert.match(validator,/exactSalePrice/);
  assert.match(validator,/exactSaleSource/);
  assert.doesNotMatch(validator,/'margin'/);
  assert.doesNotMatch(validator,/'leverage'/);
  assert.doesNotMatch(validator,/'maxLoss'/);
  assert.doesNotMatch(validator,/'exactBuy/);

  const stages=block(sync,'function activeProtectionStagesStatus','function activeConfigStatus');
  assert.match(stages,/value\.length > 200/);
  assert.match(stages,/ACTIVE_PROTECTION_STAGE_FLOOR_DECREASE/);
  assert.match(stages,/ACTIVE_PROTECTION_STAGE_ORDER_INVALID/);
});

test('ordinary controller-state writes are atomically fenced while a real command is in flight',()=>{
  const post=block(sync,"if (action === 'controller-state' && req.method === 'POST')","if (action === 'state' && req.method === 'GET')");
  assert.match(post,/redis\.call\('LLEN', KEYS\[6\]\) > 0/);
  assert.match(post,/redis\.call\('LLEN', KEYS\[7\]\) > 0/);
  assert.match(post,/CONTROLLER_STATE_COMMAND_IN_FLIGHT/);
  assert.match(post,/'EVAL', script, '7'/);
  assert.match(post,/KEY_PENDING, KEY_PROCESSING/);
});

test('target config is committed only after exact Binance LIMIT confirmation',()=>{
  const ack=block(sync,"if (action === 'command-ack' && req.method === 'POST')","if (action === 'command-fail' && req.method === 'POST')");
  const exact=ack.indexOf("String(order?.type || '').toUpperCase() === 'LIMIT'");
  const price=ack.indexOf('numberMatches(order?.price, payloadStatus.targetPrice)');
  const prepare=ack.indexOf("prepareActiveConfigControllerCommit(\n              command,payloadStatus,device,'ACTIVE_TARGET_CONFIG'");
  assert.ok(exact>=0&&price>exact&&prepare>price,'active target config must commit after exact LIMIT proof');
  assert.match(ack,/EXECUTION_ACK_EMERGENCY_PROTECTION_MISSING/);
  assert.match(ack,/EXECUTION_ACK_PREVIOUS_ORDER_STILL_OPEN/);
});

test('protection-only config ACK requires live position emergency MAX-LOSS and no progressive conflict',()=>{
  const ack=block(sync,"if (action === 'command-ack' && req.method === 'POST')","if (action === 'command-fail' && req.method === 'POST')");
  const start=ack.indexOf("if (commandType === 'EXEC_UPDATE_ACTIVE_CONFIG')");
  assert.ok(start>=0,'active config ACK branch missing');
  const part=ack.slice(start);
  assert.match(part,/freshConsistentReconciliation/);
  assert.match(part,/EXECUTION_ACK_POSITION_CHANGED/);
  assert.match(part,/runtimeEmergencyProtection/);
  assert.match(part,/EXECUTION_ACK_EMERGENCY_PROTECTION_MISSING/);
  assert.match(part,/runtimeProgressiveProtectionConflict/);
  assert.match(part,/EXECUTION_ACK_PROGRESSIVE_PROTECTION_CONFLICT/);
  assert.match(part,/ACTIVE_PROTECTIONS_CONFIG/);
});

test('server revalidates preserved risk settings before active config revision commit',()=>{
  const prepare=block(sync,'async function prepareActiveConfigControllerCommit','async function completeProcessingCommandAtomic');
  assert.match(prepare,/CONFIGURED_MARGIN_INVALID/);
  assert.match(prepare,/CONFIGURED_MAX_LOSS_INVALID/);
  assert.match(prepare,/CONFIGURED_LEVERAGE_INVALID/);
  assert.match(prepare,/CONFIGURED_MARGIN_TYPE_INVALID/);
  assert.match(prepare,/REAL_RISK_LIMITS\.maxLossUsd/);
  assert.match(prepare,/maxLoss > margin \+ 1e-8/);
  assert.match(prepare,/marginType:'ISOLATED'/);
});

test('MASTER applies due new protection before committing the new table',()=>{
  const apply=block(worker,'async function applyPendingProtectionTableBeforeConfigCommit','async function safeAckActiveConfigAfterReconcile');
  assert.match(apply,/loadAutoHighWater/);
  assert.match(apply,/binanceApi\('\/api\/binance-read'\)/);
  assert.match(apply,/observeAutoHighWater\(position,mark\)/);
  assert.match(apply,/persistAutoHighWaterNow\(\)/);
  assert.match(apply,/evaluateMasterAutoProgressiveProtection/);
  assert.match(apply,/executeAutoProgressive\(plan\)/);

  const configRun=block(worker,'async function runActiveConfigCommand','async function handleMutationFailure');
  assert.ok(configRun.indexOf('applyPendingProtectionTableBeforeConfigCommit')<configRun.indexOf('safeAckActiveConfigAfterReconcile'));

  const protective=block(worker,'async function runProtectiveUpdate','async function waitForFullCloseState');
  const targetApply=protective.indexOf('applyPendingProtectionTableBeforeConfigCommit(raw,body)');
  const targetAck=protective.indexOf('safeAckActiveConfigAfterReconcile');
  assert.ok(targetApply>=0&&targetAck>targetApply,'target+config path must apply due protection before ACK');
});

test('an already stronger progressive protection is never downgraded by an edited table',()=>{
  const filter={filterType:'PRICE_FILTER',minPrice:'0.1',maxPrice:'1000000',tickSize:'0.1'};
  const position={symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'1',entryPrice:'100',updateTime:1000};
  const stages=[{enabled:true,arm:40,floor:20},{enabled:false,arm:105,floor:100}];
  const existing=[{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'GTC',reduceOnly:true,
    triggerPrice:'150',price:'150',priceMatch:'NONE',clientAlgoId:'zth-PRO-existing'
  }];
  const result=evaluateMasterAutoProgressiveProtection({
    position,markPrice:145,protectionStages:stages,currentOrders:existing,
    priceFilter:filter,previousHighWaterProfitUsd:120
  });
  assert.equal(result.action,'NONE');
  assert.equal(result.reason,'PROTECTION_ALREADY_AT_OR_ABOVE_STAGE');
});

test('engine accepts only one ACKed active token safe-field drift and verifies final hash',()=>{
  const drift=block(worker,'function activeSafeTokenConfigRefreshAllowed','async function syncControllerConfig');
  assert.match(drift,/changed===1/);
  assert.match(drift,/safeMutable/);
  assert.match(drift,/targetProfit/);
  assert.match(drift,/protectionStages/);
  assert.match(drift,/maxLoss>margin\+1e-8/);
  assert.doesNotMatch(drift,/safeMutable=new Set\(\[[\s\S]*margin,/);
  assert.doesNotMatch(drift,/safeMutable=new Set\(\[[\s\S]*leverage,/);

  const ack=block(worker,'async function safeAckActiveConfigAfterReconcile','async function runActiveConfigCommand');
  assert.match(ack,/activeConfigCommitted!==true/);
  assert.match(ack,/validActiveProtectionStages/);
  assert.match(ack,/localHash===expectedHash/);
  assert.match(ack,/ACTIVE_CONFIG_ACK_HASH_MISMATCH/);
});

test('controller command identity includes active config digest and MASTER supports config-only command',()=>{
  assert.match(controller,/buildControllerUpdateExitCommand\(position, targetPrice, previousClientOrderId = '', activeConfig = null, configDigest = ''\)/);
  assert.match(controller,/buildControllerActiveConfigCommand/);
  assert.match(controller,/ACTIVE_CONFIG_DIGEST_REQUIRED/);
  assert.match(controller,/type:'EXEC_UPDATE_ACTIVE_CONFIG'/);
  assert.match(dispatch,/EXEC_UPDATE_ACTIVE_CONFIG/);
});
