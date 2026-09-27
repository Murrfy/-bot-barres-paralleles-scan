import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const api=fs.readFileSync('api/binance-protective-update-execute.js','utf8');
const intent=fs.readFileSync('lib/order-intent.mjs','utf8');

test('24/7 engine automatically ensures a target only through the real protective writer',()=>{
  assert.match(worker,/import \{ planAutomaticTargetExit \} from '\.\.\/lib\/auto-target-exit\.mjs'/);
  assert.match(worker,/type:'EXEC_UPDATE_EXIT',phase:'PLACE_NEW'/);
  assert.match(worker,/await callProtectiveUpdateExecute\(body\)/);
  assert.match(worker,/ensureAutomaticTargets\(\)/);
  assert.match(worker,/return reconcile\(true\)/);
});

test('automatic target requires a configured unique Zenith MAX-LOSS first',()=>{
  assert.match(worker,/configuredMaxLossForSymbol\(symbol\)/);
  assert.match(worker,/uniqueManagedMaxLoss\(position,orders,configuredMaxLoss\)/);
  assert.match(worker,/maxLossConfirmed/);
  assert.match(worker,/AUTO_TARGET_/);
});

test('automatic target waits for exact LIMIT GTC reduce-only stream identity',()=>{
  assert.match(worker,/String\(order\?\.type\|\|''\)\.toUpperCase\(\)==='LIMIT'/);
  assert.match(worker,/String\(order\?\.timeInForce\|\|''\)\.toUpperCase\(\)==='GTC'/);
  assert.match(worker,/order\?\.reduceOnly===true\|\|order\?\.reduceOnly==='true'/);
  assert.match(worker,/realNumberMatches\(order\?\.price,activePlan\.targetPrice\)/);
  assert.match(worker,/realNumberMatches\(remaining,live\.quantity\)/);
});

test('protective writer creates EXIT as NORMAL_LIMIT and order planner has no MARKET sell fallback',()=>{
  assert.match(api,/exitMode:'NORMAL_LIMIT'/);
  assert.match(intent,/mode === 'NORMAL_LIMIT'/);
  assert.match(intent,/params\.type = 'LIMIT'/);
  assert.doesNotMatch(intent,/EXIT_MARKET|MARKET_LAST_RESORT/);
});

test('external or duplicate exit orders are not overwritten by automatic target',()=>{
  const planner=fs.readFileSync('lib/auto-target-exit.mjs','utf8');
  assert.match(planner,/MULTIPLE_EXIT_LIMITS/);
  assert.match(planner,/EXTERNAL_EXIT_LIMIT_PRESENT/);
  assert.match(planner,/MANAGED_TARGET_ALREADY_OPEN/);
});

test('partial entry fill refresh cancels old managed target, rereads live position, then places the recalculated LIMIT',()=>{
  const start=worker.indexOf("if(activePlan.action==='REPLACE')");
  const end=worker.indexOf("const live=activePlan.live;",start+10);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end+3500);
  const cancel=block.indexOf("phase:'CANCEL_OLD'");
  const wait=block.indexOf("waitForStreamOrder({kind:'STANDARD',clientId:previousClientOrderId,terminal:true}",cancel);
  const publish=block.indexOf("await publishRuntime()",wait);
  const reread=block.indexOf("const latestProjection=streamProjection()",publish);
  const replan=block.indexOf("activePlan=planAutomaticTargetExit({",reread);
  assert.ok(cancel>=0&&wait>cancel&&publish>wait&&reread>publish&&replan>reread);
  assert.match(block,/PREVIOUS_TARGET_CANCEL_NOT_CONFIRMED/);
  assert.match(block,/position:latestPosition,currentOrders:latestOrders/);
});

test('partial target remainder is persisted before old target cancellation and closed only with LIMIT IOC',()=>{
  const start=worker.indexOf('async function closePartialAutomaticTargetRemainder');
  const end=worker.indexOf('async function ensureAutomaticTargetForPosition',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.match(block,/PROTECTIVE_CLOSE_ATTEMPTS/);
  assert.match(block,/exitMode:policy\.exitMode/);
  assert.match(block,/priceMatch:policy\.priceMatch/);
  assert.match(block,/type:'EXEC_CLOSE_POSITION'/);
  assert.match(block,/closeAll:true/);
  assert.match(block,/PARTIAL_REMAINDER_RETRY_PENDING/);
  assert.match(block,/rollPartialTargetRemainderGeneration\(marker\)/);
  assert.doesNotMatch(block,/MARKET/);

  const ensureStart=worker.indexOf('async function ensureAutomaticTargetForPosition');
  const ensureEnd=worker.indexOf('async function ensureAutomaticTargets',ensureStart);
  const ensureBlock=worker.slice(ensureStart,ensureEnd);
  const persist=ensureBlock.indexOf('persistPartialTargetRemainder(plan.live,plan.previousClientOrderId)');
  const close=ensureBlock.indexOf('closePartialAutomaticTargetRemainder(',persist);
  assert.ok(persist>=0&&close>persist,'remainder close intent must persist before execution');
});

test('partial target close intent survives restart state and blocks a new entry on the same symbol',()=>{
  assert.match(worker,/remainderClosures:new Map\(\)/);
  assert.match(worker,/key\.startsWith\('close:'\).*remainderClosures\.set/s);
  assert.match(worker,/entries\['close:'\+key\]=Number\(value\)/);
  assert.match(worker,/autoTarget\.remainderClosures\.keys\(\).*startsWith\(config\.symbol\+':'\)/s);
});

test('replacement target gets a distinct deterministic identity from live quantity and target price',()=>{
  assert.match(worker,/targetIdentity=sha256Hex\(`\$\{live\.quantity\}\|\$\{activePlan\.targetPrice\}`\)\.slice\(0,12\)/);
  assert.match(worker,/auto-target-\$\{live\.symbol\}-\$\{live\.direction\}-\$\{live\.lifecycleAt\|\|0\}-\$\{targetIdentity\}/);
});


test('automatic target keeps no-write symbol failures local but still fail-closes ambiguous writes',()=>{
  const localStart=worker.indexOf('function localAutoTargetFailure');
  const failStart=worker.indexOf('async function failClosedAutoTarget',localStart);
  const configStart=worker.indexOf('function configuredMaxLossForSymbol',failStart);
  assert.ok(localStart>=0&&failStart>localStart&&configStart>failStart);
  const localBlock=worker.slice(localStart,failStart);
  const failBlock=worker.slice(failStart,configStart);
  assert.match(localBlock,/return \{ok:true,changed:changed===true,reason:code,local:true\}/);
  assert.doesNotMatch(localBlock,/invalidateStream/);
  assert.match(failBlock,/invalidateStream\(code\)/);
  assert.match(failBlock,/scheduleReconcile\(250\)/);

  const start=worker.indexOf('async function ensureAutomaticTargetForPosition');
  const end=worker.indexOf('async function ensureAutomaticTargets',start);
  const block=worker.slice(start,end);
  assert.match(block,/localAutoTargetFailure\(symbol,'MAX_LOSS_CONFIG_UNAVAILABLE'\)/);
  assert.match(block,/localAutoTargetFailure\(symbol,'PRICE_FILTER_UNAVAILABLE'\)/);
  assert.match(block,/localAutoTargetFailure\(symbol,plan\.reason\|\|'PLAN_BLOCKED'\)/);
  assert.match(block,/localAutoTargetFailure\(symbol,'PREVIOUS_CLIENT_ORDER_ID_INVALID'\)/);
  assert.match(block,/return failClosedAutoTarget\(reason\+'_AMBIGUOUS'\)/);
  assert.match(block,/return failClosedAutoTarget\('PREVIOUS_TARGET_CANCEL_NOT_CONFIRMED'\)/);
  assert.match(block,/return failClosedAutoTarget\('CLIENT_ORDER_ID_INVALID'\)/);
  assert.match(block,/if\(!valid\)return failClosedAutoTarget\('ORDER_NOT_STREAM_CONFIRMED'\)/);
});

test('post-cancel local replan failure forces an immediate reconciliation pass',()=>{
  const start=worker.indexOf('async function ensureAutomaticTargetForPosition');
  const end=worker.indexOf('async function ensureAutomaticTargets',start);
  const block=worker.slice(start,end);
  assert.match(block,/localAutoTargetFailure\(symbol,activePlan\.reason\|\|'TARGET_REFRESH_REPLAN_BLOCKED',\{changed:true\}\)/);
});
