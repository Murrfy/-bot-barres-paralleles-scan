import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planAutomaticTargetExit } from '../lib/auto-target-exit.mjs';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';

const html=fs.readFileSync('index.html','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const preflight=fs.readFileSync('api/binance-entry-preflight.js','utf8');
const entry=fs.readFileSync('api/binance-entry-execute.js','utf8');
const sync=fs.readFileSync('api/zenith-sync.js','utf8');

function block(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start+' block missing');
  return source.slice(a,b);
}

test('effective token config overlays token overrides on global defaults without changing ISOLATED',()=>{
  const cfg=block(html,'function cfg(symbol)','function exactProfitFor');
  assert.match(cfg,/const t=tokenSettings\[symbol\]\|\|\{},base=\{\.\.\.settings,\.\.\.t\}/);
  assert.match(cfg,/base\.marginType='ISOLATED'/);
  assert.match(cfg,/t\.protectionStages\|\|settings\.protectionStages/);
  assert.match(cfg,/t\.manualTargetProfit,n\(t\.targetProfit,settings\.targetProfit\)/);
});

test('saving global defaults cannot overwrite existing token overrides',()=>{
  const saveDefaults=block(html,'async function saveSelectedAsDefaults()','async function saveRealActiveTokenSettings');
  assert.match(saveDefaults,/settings=\{\.\.\.settings,margin,leverage,marginType:'ISOLATED',targetProfit:target,maxLoss,protectionStages:clone\(protections\)\}/);
  assert.doesNotMatch(saveDefaults,/tokenSettings\s*=/);
  assert.doesNotMatch(saveDefaults,/tokenSettings\[/);
  assert.match(saveDefaults,/openPositions\.length\|\|n\(binanceAccount\.realPositions\)>0\|\|Object\.keys\(validated\)\.length/);
});

test('per-token Futures save changes only that token and preserves its other overrides',()=>{
  const save=block(html,'async function saveFutures()','function readBotSettings()');
  assert.match(save,/const old=tokenSettings\[s\]\|\|\{\}/);
  assert.match(save,/tokenSettings\[s\]=\{\.\.\.old,enabled:true,margin,leverage,marginType:'ISOLATED'/);
  assert.match(save,/anyActivePositionBySymbol\(s\)/);
  assert.match(save,/validated\[s\]/);
});

test('explicit token reset is the only path here that removes the per-token override',()=>{
  const reset=block(html,'function tokenDefaults()','function positionCfg');
  assert.match(reset,/delete tokenSettings\[selectedSymbol\]/);
  assert.match(reset,/anyActivePositionBySymbol\(selectedSymbol\)/);
  assert.match(reset,/validated\[selectedSymbol\]/);
});

test('automatic LIMIT entry resolves margin leverage and MAX-LOSS per token before global defaults',()=>{
  const watched=block(worker,'function watchedEntryConfig(symbol)','function occupiedRealEntrySlots');
  assert.match(watched,/const margin=n\(token\.margin,n\(globalSettings\.margin,0\)\)/);
  assert.match(watched,/const leverage=n\(token\.leverage,n\(globalSettings\.leverage,0\)\)/);
  assert.match(watched,/const maxLoss=n\(token\.maxLoss,n\(globalSettings\.maxLoss,0\)\)/);

  const execute=block(worker,'async function executeWatchedEntry(config)','async function cancelPreparedEntryProtection');
  assert.match(execute,/margin:config\.margin/);
  assert.match(execute,/leverage:config\.leverage/);
  assert.match(execute,/maxLoss:config\.maxLoss/);
  assert.match(execute,/orderType:'LIMIT'/);
});

test('explicit MARKET buy uses the same effective per-token risk settings',()=>{
  const instant=block(html,'async function instantBuySelected()','async function manualClose');
  assert.match(instant,/const c=cfg\(s\)/);
  assert.match(instant,/margin:n\(c\.margin\)/);
  assert.match(instant,/leverage:n\(c\.leverage\)/);
  assert.match(instant,/maxLoss:n\(c\.maxLoss\)/);
  assert.match(instant,/buildControllerMarketEntryCommand/);

  const validation=block(sync,'function execMarketOpenPayloadStatus','function runtimeClosePositionQuantity');
  assert.match(validation,/margin > REAL_RISK_LIMITS\.maxMarginUsdt/);
  assert.match(validation,/leverage > REAL_RISK_LIMITS\.maxLeverage/);
  assert.match(validation,/maxLoss > REAL_RISK_LIMITS\.maxLossUsd/);
  assert.match(entry,/runLiveEntryPreflight\(\{[\s\S]*margin,leverage,maxLoss/);
});

test('server maxActive comes only from global central settings and hard-fails outside 1..3',()=>{
  const fn=block(preflight,'export async function readConfiguredMaxActivePositions','export async function runLiveEntryPreflight');
  assert.match(fn,/state\?\.data\?\.settings\?\.maxActive/);
  assert.doesNotMatch(fn,/tokenSettings/);
  assert.match(fn,/value < 1 \|\| value > REAL_RISK_LIMITS\.maxActivePositions/);
  assert.match(fn,/MAX_ACTIVE_CONFIG_INVALID/);
  assert.equal(REAL_RISK_LIMITS.maxActivePositions,3);
});

test('risk preflight receives the exact resolved entry values and configured global maxActive',()=>{
  const api=block(entry,'const writesEnabled=Boolean','let plan;');
  assert.match(api,/const maxActivePositions=await readConfiguredMaxActivePositions\(\)/);
  assert.match(api,/runLiveEntryPreflight\(\{[\s\S]*margin,leverage,maxLoss,[\s\S]*maxActivePositions/);
  assert.match(api,/ensureBinanceEntrySymbolConfig\(\{[\s\S]*leverage/);
});

test('automatic target prefers token target and falls back to global target',()=>{
  const position={symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'2',entryPrice:'100',updateTime:1};
  const priceFilter={filterType:'PRICE_FILTER',minPrice:'0.1',maxPrice:'1000000',tickSize:'0.1'};

  const perToken=planAutomaticTargetExit({
    position,currentOrders:[],tokenSettings:{BTCUSDT:{targetProfit:40}},settings:{targetProfit:300},
    priceFilter,maxLossConfirmed:true
  });
  assert.equal(perToken.action,'PLACE');
  assert.equal(perToken.requestedTargetProfitUsd,40);

  const fallback=planAutomaticTargetExit({
    position,currentOrders:[],tokenSettings:{},settings:{targetProfit:300},
    priceFilter,maxLossConfirmed:true
  });
  assert.equal(fallback.action,'PLACE');
  assert.equal(fallback.requestedTargetProfitUsd,300);
});

test('server progressive protection prefers the token table and only falls back to global table',()=>{
  const fn=block(worker,'async function runAutoProtection(symbol,mark)','function activeProtectionSymbols');
  assert.match(fn,/const tokenCfg=tokenSettings\[wanted\]/);
  assert.match(fn,/Array\.isArray\(tokenCfg\.protectionStages\)[\s\S]*tokenCfg\.protectionStages[\s\S]*globalSettings\.protectionStages/);
  assert.match(fn,/evaluateMasterAutoProgressiveProtection\(\{[\s\S]*protectionStages/);
});

test('MAX-LOSS lookup and repair use token override before global default',()=>{
  const configured=block(worker,'function configuredMaxLossForSymbol','async function ensureAutomaticTargetForPosition');
  assert.match(configured,/token\.maxLoss,n\(globalSettings\.maxLoss,NaN\)/);
  const repair=block(worker,'async function repairMissingMaxLoss','async function reconcile');
  assert.match(repair,/tokenSettings:runtime\.config\?\.tokenSettings\|\|\{\}/);
  assert.match(repair,/settings:runtime\.config\?\.settings\|\|\{\}/);
});

test('active exact-sale validation is single and non-duplicated',()=>{
  const fn=block(sync,'function activeConfigStatus','function execUpdatePayloadStatus');
  const needle="if (!exactSaleEnabled && exactSalePrice !== 0) return { ok:false, reason:'ACTIVE_EXACT_SALE_PRICE_MUST_BE_ZERO' };";
  assert.equal(fn.split(needle).length-1,1);
});
