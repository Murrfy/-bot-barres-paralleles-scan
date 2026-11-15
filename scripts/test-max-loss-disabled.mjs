import crypto from 'node:crypto';
// Décision Walter 13/11/2026 (incident IDOL) : la MAX-LOSS ne bloque plus jamais
// les paliers, la vente à l'objectif, la fermeture ni les achats.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { maxLossEnforced, neutralizeMaxLossRequirements } from '../lib/max-loss-policy.mjs';
import { evaluateMasterAutoProgressiveProtection } from '../lib/master-auto-protection.mjs';
import { planAutomaticTargetExit } from '../lib/auto-target-exit.mjs';

delete process.env.ZENITH_MAX_LOSS_ENFORCED;

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const reconcile=fs.readFileSync('api/binance-reconcile.js','utf8');
const protectiveUpdate=fs.readFileSync('api/binance-protective-update-execute.js','utf8');
const html=fs.readFileSync('index.html','utf8');

const filter={filterType:'PRICE_FILTER',minPrice:'0.000001',maxPrice:'1000',tickSize:'0.000001'};
// Position IDOL du 13/11/2026 : 50 $ en x8 achetés à 0,013357.
const idol={symbol:'IDOLUSDT',positionSide:'BOTH',positionAmt:'29947',entryPrice:'0.013357',updateTime:1000};
const maxLoss=(id,qty)=>({
  orderClass:'ALGO',symbol:'IDOLUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',
  timeInForce:'IOC',reduceOnly:true,closePosition:false,priceMatch:'OPPONENT',
  origQty:String(qty),triggerPrice:'0.011700',clientAlgoId:id,algoStatus:'NEW',
});
const stages=[
  {enabled:true,arm:20,floor:10},
  {enabled:true,arm:40,floor:30},
  {enabled:true,arm:60,floor:50},
  {enabled:true,arm:80,floor:70},
];

test('MAX-LOSS is disabled by default and only tests can re-enable it',()=>{
  assert.equal(maxLossEnforced(),false);
  process.env.ZENITH_MAX_LOSS_ENFORCED='1';
  try{assert.equal(maxLossEnforced(),true)}
  finally{delete process.env.ZENITH_MAX_LOSS_ENFORCED}
});

for(const [label,orders] of [
  ['no MAX-LOSS on Binance',[]],
  ['two duplicate MAX-LOSS orders (IDOL incident)',[maxLoss('zth-MAX-a',30000),maxLoss('zth-MAX-b',29947)]],
]){
  test('IDOL replay, '+label+' : reconciliation stays clean and the palier is placed',()=>{
    const report=neutralizeMaxLossRequirements({
      status:'MISMATCH',runtimeMode:'REAL',failClosed:true,
      reasons:orders.length?['AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION']:['MISSING_BINANCE_PROTECTION','MISSING_BINANCE_MAX_LOSS_PROTECTION'],
      differences:{
        missingMaxLossProtections:orders.length?[]:['IDOLUSDT:LONG'],
        ambiguousMaxLossProtections:orders.length?['IDOLUSDT:LONG']:[],
        missingProtections:orders.length?[]:['IDOLUSDT:LONG'],
      },
    });
    assert.equal(report.failClosed,false);
    assert.equal(report.status,'CLEAN_REAL');
    assert.deepEqual(report.differences.missingMaxLossProtections,[]);
    assert.deepEqual(report.differences.ambiguousMaxLossProtections,[]);

    // Gain +60 $ environ : le palier 3 (60 → 50) doit être posé, MAX-LOSS ou pas.
    const plan=evaluateMasterAutoProgressiveProtection({
      position:idol,markPrice:0.0154,protectionStages:stages,currentOrders:orders,priceFilter:filter,
    });
    assert.equal(plan.action,'REPLACE',JSON.stringify(plan.reason));
    assert.equal(plan.stage.protectedProfitUsd,50);

    // La vente à l'objectif n'attend plus la MAX-LOSS.
    const target=planAutomaticTargetExit({
      position:idol,currentOrders:orders,tokenSettings:{IDOLUSDT:{targetProfit:20,manualTargetProfit:20}},
      settings:{targetProfit:20},priceFilter:filter,maxLossConfirmed:true,
    });
    assert.notEqual(target.reason,'MAX_LOSS_NOT_CONFIRMED');
  });
}

test('any other reconciliation anomaly still fails closed',()=>{
  const report=neutralizeMaxLossRequirements({
    status:'MISMATCH',runtimeMode:'REAL',failClosed:true,
    reasons:['MISSING_BINANCE_MAX_LOSS_PROTECTION','UNTRACKED_BINANCE_POSITION'],differences:{},
  });
  assert.equal(report.failClosed,true);
  assert.deepEqual(report.reasons,['UNTRACKED_BINANCE_POSITION']);
});

test('reconciliation neutralizes MAX-LOSS before any MAX-LOSS quarantine is created',()=>{
  const at=reconcile.indexOf('neutralizeMaxLossRequirements(result);');
  assert.ok(at>reconcile.indexOf('const result = enforceConfiguredMaxLossSafety('));
  assert.ok(at<reconcile.indexOf('localizeMissingMaxLossRepair(result,started);'));
  assert.ok(at<reconcile.indexOf('detectTriggeredMaxLossRemainders({',at-2000));
});

test('engine no longer lets MAX-LOSS block paliers, objective, entries, repairs or market ACK',()=>{
  assert.match(worker,/const maxLossRed=maxLossEnforced\(\)&&\(/);
  assert.match(worker,/const maxLossConfirmed=!maxLossEnforced\(\)\|\|uniqueManagedMaxLoss\(position,orders,configuredMaxLoss\)/);
  assert.match(worker,/const refreshedMaxLoss=!maxLossEnforced\(\)\|\|uniqueManagedMaxLoss/);
  assert.match(worker,/const repairTarget=maxLossEnforced\(\)\?missingMaxLossRepairTarget\(data\.report\):null/);
  assert.equal((worker.match(/if\(maxLossEnforced\(\)&&symbolMaxLossQuarantined\(config\.symbol\)\)return false;/g)||[]).length,2);
  assert.match(worker,/confirmedPosition&&\(!maxLossEnforced\(\)\|\|/);
});

test('iPhone never refuses palier or objective edits because of MAX-LOSS',()=>{
  assert.match(html,/const MAX_LOSS_ENFORCED=false;/);
  assert.doesNotMatch(html,/\n\s*if\(!inv\.managedMaxLoss\|\|inv\.maxLossConflict\)/);
  assert.match(html,/MAX-LOSS désactivée — marge isolée/);
});

test('target exit and paliers are never refused for a missing MAX-LOSS stop (EDGE/ERA incident)',()=>{
  assert.match(protectiveUpdate,/if\(!emergency&&maxLossEnforced\(\)\)return send\(res,423,\{ok:false,code:'EMERGENCY_MAX_LOSS_PROTECTION_REQUIRED'/);
  assert.match(protectiveUpdate,/import \{ maxLossEnforced \} from '\.\.\/lib\/max-loss-policy\.mjs';/);
});

test('a cancelled target id is never replayed as a placed target (EDGE incident)', async () => {
  const mod = await import('../api/binance-protective-update-execute.js');
  assert.equal(mod.terminalExitOrderStatus('CANCELED'), true);
  assert.equal(mod.terminalExitOrderStatus('expired'), true);
  assert.equal(mod.terminalExitOrderStatus('NEW'), false);
  assert.equal(mod.terminalExitOrderStatus('FILLED'), false);
  const start = protectiveUpdate.indexOf('const exitPlanFor=attempt=>');
  const block = protectiveUpdate.slice(start, protectiveUpdate.indexOf('placeStandardOrderIdempotent({', start));
  assert.match(block, /origClientOrderId:plan\.params\.newClientOrderId/);
  assert.match(block, /terminalExitOrderStatus\(previous\?\.status\)/);
  assert.match(block, /plan=exitPlanFor\(exitAttempt\)/);
  assert.match(block, /conflictingProtectiveOrders\(/);
});

test('bought token is no longer watched, and disappears from the list after the sale (MSTU)', () => {
  const ui = fs.readFileSync('index.html','utf8');
  assert.match(worker, /log\('ENTRY_WATCH_CONSUMED_BY_POSITION'/);
  assert.match(worker, /consumed\.triggeredAt=Date\.now\(\)/);
  const start = ui.indexOf('function removeSoldWatchedTokens');
  const block = ui.slice(start, ui.indexOf('async function refreshBinanceAccount', start));
  assert.match(block, /if\(soldFlatReads\[s\]<2\)continue/);
  assert.match(block, /if\(open\.has\(s\)\)/);
  assert.doesNotMatch(block, /delete tokenSettings/);
  assert.match(ui, /try\{removeSoldWatchedTokens\(positions,standardOrders\)\}catch/);
});

test('a token with a real open position shows ACTIF, not SURVEILLÉ, and is not counted as watched', () => {
  const ui = fs.readFileSync('index.html','utf8');
  assert.match(ui, /if\(anyActivePositionBySymbol\(s\)\)return 'ACTIF';/);
  assert.match(ui, /filter\(s=>!anyActivePositionBySymbol\(s\)&&/);
});

test('native Binance trailing stop: plan, params and reconcile acceptance (wick protection)', async () => {
  const mod = await import('../api/binance-protective-update-execute.js');
  const plan = mod.trailingPlanFromBody({symbol:'EDGEUSDT',direction:'LONG',commandId:'trail-EDGEUSDT-LONG-200-140-1',quantity:1427,callbackRate:1.4,activatePrice:0.2931});
  assert.equal(plan.ok, true);
  const params = mod.trailingAlgoParams(plan, 0);
  assert.equal(params.type, 'TRAILING_STOP_MARKET');
  assert.equal(params.side, 'SELL');
  assert.equal(params.reduceOnly, 'true');
  assert.equal(params.callbackRate, '1.4');
  assert.equal(params.activatePrice, '0.2931');
  assert.match(params.clientAlgoId, /^zth-TRL-[0-9a-f]{24}$/);
  assert.notEqual(mod.trailingAlgoParams(plan, 1).clientAlgoId, params.clientAlgoId);
  assert.equal(mod.trailingPlanFromBody({...plan,callbackRate:5.1}).ok, false);
  assert.equal(mod.trailingPlanFromBody({...plan,callbackRate:0.05}).ok, false);
  assert.equal(mod.trailingPlanFromBody({...plan,callbackRate:1.25}).ok, false);
  const reconcile = fs.readFileSync('api/binance-reconcile.js','utf8');
  assert.match(reconcile, /type === 'TRAILING_STOP_MARKET' && \/\^zth-TRL-/);
  assert.match(protectiveUpdate, /String\(master\?\.principal\|\|''\)!=='engine'\)\{\s*return send\(res,423,\{ok:false,code:'TRAILING_ENGINE_REQUIRED'/);
});

test('règle de Walter : 20 $ touché → 14 $ garanti, rien entre 21 et 39 $, 40 $ touché → 34 $', () => {
  const start = worker.indexOf('function trailingCompleteStages');
  const src = worker.slice(start, worker.indexOf('async function ensureTrailingProtection', start));
  const sha = (v)=>crypto.createHash('sha256').update(String(v),'utf8').digest('hex');
  const lib = new Function('n','sha256Hex', src + '; return {trailingPlanForPosition,reachedStageFloorProtected,trailingCommandId,trailingClientAlgoIds};')((v,f=0)=>{const x=Number(v);return Number.isFinite(x)?x:f}, sha);
  const plan = lib.trailingPlanForPosition;
  const stages=[{arm:40,floor:34},{arm:20,floor:14},{arm:500,floor:''}];
  const mstu={symbol:'MSTUUSDT',positionAmt:'25',entryPrice:'16'};
  // Avant 20 $ : le trailing attend au prix des +20 $ (16,8) avec l'écart 20→14.
  const first = plan({position:mstu,mark:16.2,protectionStages:stages,tickSize:'0.01',highWaterProfitUsd:5});
  assert.equal(first.ok, true);
  assert.equal(first.armProfitUsd, 20);
  assert.equal(first.protectedProfitUsd, 14);
  assert.equal(first.activatePrice, 16.8);
  assert.equal(first.callbackRate, 1.4);
  // 20 $ atteint, prix à +22 $ : plus de trailing qui suit le prix, le suivant attend au prix des +40 $ (17,6).
  const second = plan({position:mstu,mark:16.88,protectionStages:stages,tickSize:'0.01',highWaterProfitUsd:22});
  assert.equal(second.ok, true);
  assert.equal(second.armProfitUsd, 40);
  assert.equal(second.protectedProfitUsd, 34);
  assert.equal(second.activatePrice, 17.6);
  assert.ok(second.activatePrice > 16.88);
  // Tous les paliers atteints : aucun trailing, seule la protection fixe reste.
  assert.equal(plan({position:mstu,mark:17.9,protectionStages:stages,tickSize:'0.01',highWaterProfitUsd:45}).ok, false);
  // Jamais de trailing qui démarre tout de suite en suivant le prix.
  assert.equal(plan({position:mstu,mark:16.85,protectionStages:stages,tickSize:'0.01',highWaterProfitUsd:5}).reason, 'TRAILING_STAGE_ALREADY_AT_ARM');
  // Le trailing du palier 20 $ n'est retiré que si la protection fixe à 14 $ (16,56) est posée.
  const protect = (trigger)=>lib.reachedStageFloorProtected({position:mstu,orders:[{symbol:'MSTUUSDT',side:'SELL',orderClass:'ALGO',clientAlgoId:'zth-PRO-abc',triggerPrice:String(trigger)}],protectionStages:stages,highWaterProfitUsd:22,side:'SELL',tickSize:'0.01'});
  assert.equal(protect(16.56), true);
  assert.equal(protect(16.0), false);
  // Même identifiant que celui déjà posé sur Binance : les trailings en place avant la mise à jour sont reconnus.
  const id = lib.trailingCommandId('MSTUUSDT', first);
  assert.equal(id, 'trail-MSTUUSDT-LONG-200-140-16');
  assert.ok(lib.trailingClientAlgoIds(id).has('zth-TRL-'+sha(id+':0').slice(0,24)));
  assert.match(worker, /ensureTrailingProtection\(\{position,mark,protectionStages,orders,priceFilter,highWaterProfitUsd:highWater\}\)/);
  assert.match(protectiveUpdate, /const trailingCancel=type==='EXEC_CANCEL_TRAILING'&&phase==='CANCEL_OLD';/);
});

test('sold token with leftover reduce-only stop is not active: removing it never freezes the MASTER', () => {
  const start = worker.indexOf('function activeRuntimeSymbols(){');
  const src = worker.slice(start, worker.indexOf('// Jetons actifs dont un réglage verrouillé', start));
  const projection = {
    binancePositions:[{symbol:'MSTUUSDT',positionAmt:'25'}],
    binanceOrders:[
      {symbol:'ERAUSDT',type:'STOP',reduceOnly:true},
      {symbol:'ERAUSDT',type:'TRAILING_STOP_MARKET',reduceOnly:'true'},
      {symbol:'XUSDT',type:'STOP_MARKET',closePosition:true},
      {symbol:'ETHFIUSDT',type:'LIMIT',reduceOnly:false},
    ],
  };
  const active = new Function('streamProjection', src + '; return activeRuntimeSymbols;')(()=>projection)();
  assert.deepEqual([...active].sort(), ['ETHFIUSDT','MSTUUSDT']);
  assert.match(worker, /log\('ACTIVE_LOCKED_SETTING_BLOCKED',\{revision:blockedRevision,symbols\}\)/);
  assert.match(worker, /ACTIVE_LOCKED_SETTING_BLOCKED:d=>/);
});

test('Telegram: outage alert after 3 minutes, recovery after 1 minute, failure alerts deduplicated', () => {
  const start = worker.indexOf('const ENGINE_OUT_AFTER_MS');
  const src = worker.slice(start, worker.indexOf('// Alertes de panne', start));
  const logs = [];
  const watch = new Function('log', src + '; return engineServiceWatch;')((k,d)=>logs.push([k,d]));
  const bad = {leaseActive:true,mode:'RUNNING',synchronized:false,userStreamReady:true,runtimeError:'ACTIVE_LOCKED_SETTING_CHANGED'};
  const good = {leaseActive:true,mode:'RUNNING',synchronized:true,userStreamReady:true};
  watch(bad, 0); watch(bad, 170000);
  assert.equal(logs.length, 0);
  watch(bad, 181000); watch(bad, 400000);
  assert.deepEqual(logs.map(x=>x[0]), ['ENGINE_OUT_OF_SERVICE']);
  assert.equal(logs[0][1].label, 'DESYNC');
  watch(good, 500000); watch(good, 550000);
  assert.equal(logs.length, 1);
  watch(good, 561000);
  assert.deepEqual(logs.map(x=>x[0]), ['ENGINE_OUT_OF_SERVICE','ENGINE_BACK_IN_SERVICE']);
  for (const kind of ['ENGINE_OUT_OF_SERVICE','ENGINE_BACK_IN_SERVICE','TRAILING_PROTECTION_FAILED','AUTO_TARGET_LOCAL_FAILURE','AUTO_MAX_LOSS_REPAIR_REFUSED']) {
    assert.match(worker, new RegExp(kind + ':'));
  }
  const dStart = worker.indexOf('const TELEGRAM_ALERT_DEDUPE_KINDS');
  const dSrc = worker.slice(dStart, worker.indexOf('function notifyTelegram', dStart));
  const allowed = new Function('n', dSrc + '; return telegramAlertAllowed;')((v,f=0)=>{const x=Number(v);return Number.isFinite(x)?x:f});
  const d = {symbol:'CLOUSDT',reason:'X'};
  assert.equal(allowed('TRAILING_PROTECTION_FAILED', d, 1000), true);
  assert.equal(allowed('TRAILING_PROTECTION_FAILED', d, 60000), false);
  assert.equal(allowed('TRAILING_PROTECTION_FAILED', d, 1000 + 30*60*1000), true);
  assert.equal(allowed('RUNNING', {}, 1000), true);
});
