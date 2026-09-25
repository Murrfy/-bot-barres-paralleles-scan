import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

function between(startMarker,endMarker){
  const start=worker.indexOf(startMarker);
  const end=worker.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing worker block '+startMarker);
  return worker.slice(start,end);
}

test('worker reuses shared progressive planner and server risk cap',()=>{
  assert.ok(worker.includes("from '../lib/master-auto-protection.mjs'"));
  assert.ok(worker.includes('evaluateMasterAutoProgressiveProtection'));
  assert.ok(worker.includes("from '../lib/risk-policy.mjs'"));
  assert.ok(worker.includes('REAL_RISK_LIMITS.maxLossUsd'));
});

test('worker consumes configured protectionStages instead of embedding trading thresholds',()=>{
  const block=between('async function runAutoProtection','function scheduleMarkReconnect');
  assert.ok(block.includes('tokenCfg.protectionStages'));
  assert.ok(block.includes('globalSettings.protectionStages'));
  assert.ok(block.includes('protectionStages,'));
  assert.equal(block.includes('arm:30'),false);
  assert.equal(block.includes('floor:20'),false);
  assert.equal(block.includes('arm:40'),false);
  assert.equal(block.includes('floor:39.8'),false);
});

test('worker uses routed aggregate-trade market subscriptions for active real positions',()=>{
  assert.ok(worker.includes("new WebSocket('wss://fstream.binance.com/market/ws')"));
  assert.ok(worker.includes("return String(symbol||'').toLowerCase()+'@aggTrade'"));
  assert.ok(worker.includes("sendMarkControl('SUBSCRIBE',add)"));
  assert.ok(worker.includes("sendMarkControl('UNSUBSCRIBE',remove)"));
  assert.ok(worker.includes("String(row?.e||'')!=='aggTrade'"));
  assert.ok(worker.includes('SCHEDULED_23H_MARK_RECONNECT'));
  assert.equal(worker.includes('market/ws/!markPrice@arr@1s'),false);
});

test('market gaps are replayed from public aggTrades and ambiguity fails closed',()=>{
  assert.ok(worker.includes("const BINANCE_PUBLIC_BASE='https://fapi.binance.com';"));
  assert.ok(worker.includes('/fapi/v1/aggTrades?symbol='));
  assert.ok(worker.includes('recoverMissedAggTrades'));
  assert.ok(worker.includes('markStream.pendingAggTrades'));
  assert.ok(worker.includes('pages<25'));
  assert.ok(worker.includes("failClosedAutoProtection('MARK_RECOVERY_PARTIAL_'"));
  assert.ok(worker.includes("'MARK_RECOVERY_FAILED_'+cleanReason"));
  assert.ok(worker.includes("'MARK_RECOVERY_BUFFER_OVERFLOW_'+symbol"));
});

test('market websocket outage has a fenced read-only markPrice fallback',()=>{
  assert.ok(worker.includes("binanceApi('/api/binance-read')"));
  assert.ok(worker.includes('const MARK_FALLBACK_MS=6000;'));
  assert.ok(worker.includes('position?.markPrice'));
  assert.ok(worker.includes('markStream.fallbackTimer=setInterval'));
});

test('high-water is persisted before autonomous protective mutation',()=>{
  assert.ok(worker.includes("syncApi('engine-protection-high-water')"));
  assert.ok(worker.includes("syncApi('engine-protection-high-water',{"));
  assert.ok(worker.includes('authorizationAt:autoProtection.authorizationAt'));
  const execute=between('async function executeAutoProgressive','async function runAutoProtection');
  assert.ok(execute.includes('if(!(await persistAutoHighWaterNow()))'));
  assert.ok(execute.indexOf('persistAutoHighWaterNow') < execute.indexOf("phase:'PLACE_NEW'"));
});

test('auto-protection requires synchronized armed current MASTER, ready stream and unique MAX-LOSS',()=>{
  const block=between('async function runAutoProtection','function scheduleMarkReconnect');
  assert.ok(block.includes('runtime.synchronized'));
  assert.ok(block.includes('runtime.heartbeatFresh'));
  assert.ok(block.includes('masterExecutionEligible({'));
  assert.ok(block.includes('realExecutionArmed:runtime.realExecutionArmed'));
  assert.ok(block.includes('userStreamReady:userStreamReady(stream.state)'));
  assert.ok(block.includes('uniqueManagedMaxLoss(position,orders)'));
  assert.ok(worker.includes("String(order?.type||'').toUpperCase()!=='STOP_MARKET'"));
  assert.ok(worker.includes('zenithManagedRealId(order?.clientAlgoId)'));
});

test('replacement confirms new exact LIMIT protection before canceling old',()=>{
  const block=between('async function executeAutoProgressive','async function runAutoProtection');
  const place=block.indexOf("phase:'PLACE_NEW'");
  const confirm=block.indexOf("waitForStreamOrder({kind:'ALGO',clientId,terminal:false}");
  const identity=block.indexOf('AUTO_NEW_PROTECTION_IDENTITY_MISMATCH');
  const reconcile=block.indexOf('await awaitReconciliation()');
  const cancel=block.indexOf("phase:'CANCEL_OLD'");
  assert.ok(place>=0&&confirm>place&&identity>confirm&&reconcile>identity&&cancel>reconcile);
  assert.ok(block.includes('newClientAlgoId:clientId'));
  assert.ok(block.includes("String(order?.timeInForce||'').toUpperCase()!=='GTC'"));
  assert.ok(block.includes('realNumberMatches(order?.triggerPrice,level.triggerPrice)'));
  assert.ok(block.includes('realNumberMatches(order?.price,level.limitPrice)'));
});

test('ambiguous autonomous writes fail closed without automatic PANIC',()=>{
  const block=between('async function executeAutoProgressive','async function runAutoProtection');
  assert.ok(block.includes('placed.data?.writeAttempted===true'));
  assert.ok(block.includes('placed.data?.ambiguous===true'));
  assert.ok(block.includes('failClosedAutoProtection'));
  assert.equal(worker.includes("syncApi('emergency-stop'"),false);
  assert.equal(block.includes('EXEC_CLOSE_POSITION'),false);
});

test('worker gets active-symbol PRICE_FILTER metadata from fenced runtime snapshot',()=>{
  assert.ok(worker.includes('rememberPriceFilters(snapshot)'));
  assert.ok(worker.includes("binanceApi('/api/binance-runtime-snapshot')"));
  assert.ok(worker.includes('autoProtection.priceFilters'));
});

test('server auto-protection is declared migrated only after implementation is present',()=>{
  assert.ok(worker.includes('autoProtectionMoved:true'));
});
