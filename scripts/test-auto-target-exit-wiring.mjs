import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { seedUserStreamStateFromRuntimeSnapshot } from '../lib/user-stream-seed.mjs';
import { runtimeInventoryFromUserStream } from '../lib/master-runtime-inventory.mjs';
import { planAutomaticTargetExit } from '../lib/auto-target-exit.mjs';

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

test('normal target stays LIMIT while partial-target remainder alone may use MARKET',()=>{
  assert.match(api,/exitMode:'NORMAL_LIMIT'/);
  assert.match(intent,/mode === 'NORMAL_LIMIT'/);
  assert.match(intent,/mode === 'REMAINDER_MARKET'/);
  assert.match(intent,/leg:'EXIT_REMAINDER_MARKET'/);
  assert.match(intent,/params\.type = 'MARKET'/);
  assert.doesNotMatch(intent,/MARKET_LAST_RESORT/);
});

test('partial-target MARKET recovery is engine-only, proof-bound, reduce-only and verifies zero live quantity',()=>{
  const protective=fs.readFileSync('api/binance-protective-execute.js','utf8');
  assert.match(protective,/function partialTargetRemainderProof/);
  assert.match(protective,/PARTIAL_TARGET_REMAINDER/);
  assert.match(protective,/REMAINDER_MARKET/);
  assert.match(protective,/PARTIAL_TARGET_REMAINDER_ENGINE_REQUIRED/);
  assert.match(protective,/SALE_REMAINDER_PROOF_REQUIRED/);
  assert.match(protective,/executed>0/);
  assert.match(protective,/sameQuantity\(remaining,requestedQty\)/);
  assert.match(protective,/while\(Number\(recoveryState\.nextAttempt\)<4&&liveRemaining>1e-12\)/);
  assert.match(protective,/liveBinancePositionQuantity/);
  assert.match(protective,/remainderMarketClosed:true/);

  assert.match(worker,/plan\.action==='CLOSE_REMAINDER_MARKET'/);
  assert.match(worker,/exitMode:'REMAINDER_MARKET'/);
  assert.match(worker,/recoveryReason:'PARTIAL_TARGET_REMAINDER'/);
  assert.match(worker,/previousClientOrderId/);
  assert.match(worker,/PARTIAL_TARGET_REMAINDER_MARKET_CLOSED/);
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
  const block=worker.slice(start,end+5000);
  const cancel=block.indexOf("phase:'CANCEL_OLD'");
  const wait=block.indexOf("waitForStreamOrder({kind:'STANDARD',clientId:previousClientOrderId,terminal:true}",cancel);
  const publish=block.indexOf("await publishRuntime()",wait);
  const reread=block.indexOf("const latestProjection=streamProjection()",publish);
  const replan=block.indexOf("activePlan=planAutomaticTargetExit({",reread);
  assert.ok(cancel>=0&&wait>cancel&&publish>wait&&reread>publish&&replan>reread);
  assert.match(block,/PREVIOUS_TARGET_CANCEL_NOT_CONFIRMED/);
  assert.match(block,/position:latestPosition,currentOrders:latestOrders/);
});

test('partial-target remainder recovery runs before MAX-LOSS repair in reconciliation',()=>{
  const start=worker.indexOf('async function reconcile(secondPass=false)');
  const end=worker.indexOf('async function awaitReconciliation',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  const remainder=block.indexOf('recoverImmediatePartialTargetRemainder()');
  const repair=block.indexOf('missingMaxLossRepairTarget(data.report)');
  assert.ok(remainder>=0&&repair>remainder,'partial sale remainder must close before MAX-LOSS repair');
});

test('partial-target recovery can use the certified reconciliation even while stream inventory is being reconciled',()=>{
  const protective=fs.readFileSync('api/binance-protective-execute.js','utf8');
  assert.match(protective,/partialTargetRemainderRecovery!==true/);
  assert.match(protective,/partialTargetRemainderRecovery===true/);
  assert.match(protective,/Boolean\(partialTargetRemainder\)/);
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


test('C8 target replacement must refresh authoritative inventory if terminal stream event is missed',()=>{
  const start=worker.indexOf("if(activePlan.action==='REPLACE')");
  const end=worker.indexOf("const live=activePlan.live;",start+10);
  assert.ok(start>=0&&end>start,'automatic target replacement block missing');
  const block=worker.slice(start,end+5000);
  const wait=block.indexOf("waitForStreamOrder({kind:'STANDARD',clientId:previousClientOrderId,terminal:true}");
  const fallback=block.indexOf("canceled.data?.result?.order?.status",wait);
  const replan=block.indexOf("activePlan=planAutomaticTargetExit({",fallback);
  assert.ok(wait>=0&&fallback>wait&&replan>fallback,'target cancel fallback/replan sequence missing');
  const between=block.slice(fallback,replan);
  assert.match(
    between,
    /binance-runtime-snapshot|seedStream\(|refresh[A-Za-z0-9_]*Snapshot/,
    'if Binance confirms the old target canceled but its terminal User Stream event is missed, C8 must refresh authoritative inventory before replanning'
  );
});


test('C8 authoritative reseed removes a canceled stale target before replacement replanning',()=>{
  const oldTarget={
    orderClass:'STANDARD',symbol:'BTCUSDT',orderId:'991',
    clientOrderId:'zth-EXI-oldtarget123456',side:'SELL',positionSide:'BOTH',
    type:'LIMIT',status:'NEW',origQty:'1',executedQty:'0',price:'125',
    stopPrice:'',reduceOnly:true,closePosition:false,timeInForce:'GTC',
    workingType:'CONTRACT_PRICE',updateTime:4000,
  };
  const position={
    symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'2',entryPrice:'100',
    breakEvenPrice:'100',unrealizedProfit:'0',marginType:'isolated',
    isAutoAddMargin:false,isolatedMargin:'100',updateTime:4000,
  };
  const base={
    positions:[position],algoOrders:[],observedAt:5000,serverTime:5000,
  };
  const stale=seedUserStreamStateFromRuntimeSnapshot(
    {...base,standardOrders:[oldTarget]},
    {connectionId:'c8-test',connectedAt:4500}
  );
  const staleProjection=runtimeInventoryFromUserStream(stale);
  const priceFilter={filterType:'PRICE_FILTER',tickSize:'0.1',minPrice:'0.1',maxPrice:'1000000'};
  const stalePlan=planAutomaticTargetExit({
    position:staleProjection.binancePositions[0],
    currentOrders:staleProjection.binanceOrders,
    tokenSettings:{BTCUSDT:{targetProfit:25}},settings:{targetProfit:100},
    priceFilter,maxLossConfirmed:true,
  });
  assert.equal(stalePlan.action,'REPLACE');

  // Binance REST is authoritative after the cancellation and no longer lists the old target.
  const refreshed=seedUserStreamStateFromRuntimeSnapshot(
    {...base,standardOrders:[]},
    {connectionId:'c8-test',connectedAt:4500}
  );
  const freshProjection=runtimeInventoryFromUserStream(refreshed);
  assert.deepEqual(freshProjection.binanceOrders,[]);
  const freshPlan=planAutomaticTargetExit({
    position:freshProjection.binancePositions[0],
    currentOrders:freshProjection.binanceOrders,
    tokenSettings:{BTCUSDT:{targetProfit:25}},settings:{targetProfit:100},
    priceFilter,maxLossConfirmed:true,
  });
  assert.equal(freshPlan.action,'PLACE');
  assert.equal(freshPlan.reason,'CALCULATED_TARGET_REQUIRED');
});


test('C8 protective replacement must refresh authoritative inventory before post-cancel reconciliation when stream terminal is missed',()=>{
  const start=worker.indexOf('async function runProtectiveUpdate(command,raw,dispatch)');
  const end=worker.indexOf('async function waitForFullCloseState',start);
  assert.ok(start>=0&&end>start,'protective update worker block missing');
  const block=worker.slice(start,end);
  const cancel=block.indexOf("const result=await callProtectiveUpdateExecute({...body,phase:'CANCEL_OLD'");
  const wait=block.indexOf("waitForStreamOrder({kind,clientId:previousId,terminal:true}",cancel);
  const restFallback=block.indexOf("result.data?.result?.order?.status",wait);
  const reconcile=block.indexOf("const reconciled=await awaitReconciliation()",restFallback);
  assert.ok(cancel>=0&&wait>cancel&&restFallback>wait&&reconcile>restFallback,'protective cancel/reconcile sequence missing');
  const between=block.slice(restFallback,reconcile);
  assert.match(
    between,
    /binance-runtime-snapshot|seedStream\(|refresh[A-Za-z0-9_]*Snapshot/,
    'when Binance confirms the old C8 protective order terminal but User Stream misses it, the worker must refresh authoritative inventory before reconciliation'
  );
});


test('C8 new target placement must refresh authoritative inventory if the open-order stream event is missed',()=>{
  const start=worker.indexOf("const placed=await callProtectiveUpdateExecute(body)");
  const end=worker.indexOf("await publishRuntime();",start);
  assert.ok(start>=0&&end>start,'automatic target placement block missing');
  const block=worker.slice(start,end+500);
  const wait=block.indexOf("waitForStreamOrder({kind:'STANDARD',clientId,terminal:false}");
  const fail=block.indexOf("ORDER_NOT_STREAM_CONFIRMED",wait);
  assert.ok(wait>=0&&fail>wait,'target placement stream confirmation branch missing');
  const missed=block.slice(wait,fail);
  assert.match(
    missed,
    /binance-runtime-snapshot|seedStream\(|refresh[A-Za-z0-9_]*Snapshot/,
    'if Binance has placed the target but its open-order User Stream event is missed, C8 must refresh authoritative inventory before generic reconciliation'
  );
});
