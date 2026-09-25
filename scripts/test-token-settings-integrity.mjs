import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');
const repair=await readFile(new URL('../lib/maxloss-repair.mjs',import.meta.url),'utf8');

function block(startText,endText){
  const start=html.indexOf(startText);
  const end=html.indexOf(endText,start);
  assert.ok(start>=0&&end>start,`missing block ${startText}`);
  return html.slice(start,end);
}

test('each token can override Futures margin and leverage independently',()=>{
  const fill=block('function fillFutures()','function fillBot()');
  const save=block('async function saveFutures()','function readBotSettings()');
  const cfg=block('function cfg(symbol)','function exactProfitFor');
  assert.match(fill,/tokenSettings\[s\]/);
  assert.match(fill,/t\.margin,settings\.margin/);
  assert.match(fill,/t\.leverage,settings\.leverage/);
  assert.match(save,/tokenSettings\[s\]=\{\.\.\.old,enabled:true,margin,leverage,marginType:'ISOLATED'/);
  assert.match(cfg,/base=\{\.\.\.settings,\.\.\.t\}/);
});

test('token gain, max-loss and progressive protections persist as token overrides',()=>{
  const save=block('async function saveToken()','function devalidateSelected()');
  assert.match(save,/targetProfit:shown/);
  assert.match(save,/manualTargetProfit:manual/);
  assert.match(save,/maxLoss:requestedMaxLoss/);
  assert.match(save,/protectionStages:protections/);
  const pos=block('function positionCfg(s)','function createPosition');
  assert.match(pos,/const c=cfg\(s\)/);
  assert.match(pos,/targetProfit:n\(c\.targetProfit\)/);
  assert.match(pos,/maxLoss:n\(c\.maxLoss\)/);
});

test('real progressive protection prefers per-token stages before defaults',()=>{
  assert.match(worker,/const tokenCfg=tokenSettings\[wanted\]/);
  assert.match(worker,/Array\.isArray\(tokenCfg\.protectionStages\)[\s\S]*tokenCfg\.protectionStages[\s\S]*globalSettings\.protectionStages/);
});

test('MAX-LOSS repair prefers per-token maxLoss before global maxLoss',()=>{
  assert.match(repair,/tokenCfg\.maxLoss/);
  assert.match(repair,/globalCfg\.maxLoss/);
});

test('client controls do not advertise values above server real-risk caps',()=>{
  assert.equal(REAL_RISK_LIMITS.maxLeverage,10);
  assert.equal(REAL_RISK_LIMITS.maxMarginUsdt,1000);
  assert.equal(REAL_RISK_LIMITS.maxActivePositions,3);
  assert.match(html,/id="fLev"[^>]*max="10"/);
  assert.match(html,/id="fMargin"[^>]*max="1000"/);
  assert.match(html,/id="bMaxActive"[^>]*max="3"/);
  assert.doesNotMatch(html,/lev=clamp\(n\(t\.leverage,settings\.leverage\),1,125\)/);
  assert.doesNotMatch(html,/settings\.maxActive\|\|3\)\),1,20/);
});

test('watched tokens freeze settings while active positions keep only safe controls editable',()=>{
  const locks=block('function setTokenFieldsEnabled()','function updateTokenPreview()');
  assert.match(locks,/Achat surveillé : paramètres verrouillés/);
  assert.match(locks,/\['tExactBuy','tExactBuyPrice','tExactSale','tExactSalePrice','tTarget','tMaxLoss'\]/);
  assert.match(locks,/Position active : objectif de gain, prix déterminé de VENTE et protections modifiables/);
  assert.match(locks,/\['tExactBuy','tExactBuyPrice','tMaxLoss'\]/);
  assert.match(locks,/\['tExactSale','tExactSalePrice','tTarget'\]/);
  assert.match(locks,/\$\('fMargin'\)\.disabled=true;\$\('fLev'\)\.disabled=true/);
});

test('active-position gain target persists and recalculates the active target price',()=>{
  const save=block('async function saveToken()','function devalidateSelected()');
  assert.match(save,/manualTarget=Math\.max\(0,n\(\$\('tTarget'\)\.dataset\.manualTarget/);
  assert.match(save,/targetProfit:manualTarget,manualTargetProfit:manualTarget/);
  assert.match(save,/active\.baseTargetProfit=manualTarget/);
  assert.match(save,/active\.targetProfit=exact\?exactProfitFor[\s\S]*:active\.baseTargetProfit/);
  assert.match(save,/active\.targetPrice=exact\|\|priceForPnl\(active\.entryPrice,active\.notional,active\.targetProfit\)/);
});

test('active target changes resize protections without discarding already reached stages',()=>{
  const sync=block('function syncProtectionsToTarget(target)','function fillToken()');
  assert.match(sync,/localActive=openBySymbol\(selectedSymbol\),realActive=controllerRealPositionBySymbol\(selectedSymbol\)/);
  assert.match(sync,/minCount=localActive\?reachedProtectionCount\(merged,localActive\.maxProfit\):realActive\?\(Array\.isArray\(saved\)\?saved\.length:0\):0/);
  assert.match(sync,/renderProtectionEditor\(merged,target,minCount\)/);
  const protections=block('function protectionsForTarget(stages,target,minCount=0)','function applyProtectionVisibility()');
  assert.match(protections,/Math\.max\(protectionCountForTarget\(target\),Math\.max\(0,Math\.floor\(n\(minCount,0\)\)\)\)/);
  assert.match(protections,/reachedProtectionCount\(stages,maxProfit\)/);
});


test('global risk defaults can be updated without overwriting per-token overrides',()=>{
  const saveDefaults=block('async function saveSelectedAsDefaults()','async function saveToken()');
  assert.match(saveDefaults,/openPositions\.length\|\|n\(binanceAccount\.realPositions\)>0\|\|Object\.keys\(validated\)\.length/);
  assert.match(saveDefaults,/settings=\{\.\.\.settings,margin,leverage,marginType:'ISOLATED',targetProfit:target,maxLoss,protectionStages:clone\(protections\)\}/);
  assert.doesNotMatch(saveDefaults,/tokenSettings\s*=/);
  assert.match(saveDefaults,/maxLoss>margin/);
  const cloud=block('function controllerCloudStatePayload()','async function syncControllerCloudStateNow()');
  assert.match(cloud,/settings:clone\(settings\)/);
  assert.match(cloud,/tokenSettings:clone\(normalizeRecordBlock\(tokenSettings\)\)/);
});

test('global defaults stay visible and are copied only by explicit action',()=>{
  assert.match(html,/id="defaultRiskSummary"/);
  assert.match(html,/id="saveBotDefaultsBtn"/);
  const fill=block('function fillBot()','function setTokenFieldsEnabled()');
  assert.match(fill,/Défauts risque : marge ISOLÉE/);
  assert.match(html,/\$\('saveBotDefaultsBtn'\)\.onclick=saveSelectedAsDefaults/);
});


test('live Binance positions lock unsafe token controls on the iPhone',()=>{
  const helpers=block('function controllerRealPositionBySymbol(symbol)','function masterRealPositionBySymbol(symbol)');
  assert.match(helpers,/binanceAccount\.positions/);
  assert.match(helpers,/anyActivePositionBySymbol\(symbol\)/);
  const locks=block('function setTokenFieldsEnabled()','function updateTokenPreview()');
  assert.match(locks,/realActive=controllerRealPositionBySymbol\(selectedSymbol\)/);
  assert.match(locks,/\['tExactBuy','tExactBuyPrice','tMaxLoss'\]/);
  assert.match(locks,/\['tExactSale','tExactSalePrice','tTarget'\]/);
  assert.match(locks,/Position réelle ACTIVE/);
  const futures=block('async function saveFutures()','function readBotSettings()');
  assert.match(futures,/anyActivePositionBySymbol\(s\)/);
  assert.match(html,/async function instantBuySelected\(\)[\s\S]*anyActivePositionBySymbol\(s\)/);
  assert.match(html,/function tokenDefaults\(\)[\s\S]*anyActivePositionBySymbol\(selectedSymbol\)/);
});

test('live Binance target preview uses actual entry quantity and direction',()=>{
  const helpers=block('function controllerRealPositionBySymbol(symbol)','function masterRealPositionBySymbol(symbol)');
  assert.match(helpers,/realPositionPnlAtPrice\(position,mark\)/);
  assert.match(helpers,/realPositionPriceForPnl\(position,pnl\)/);
  assert.match(helpers,/amount>0\?1:-1/);
  const preview=block('function updateTokenPreview()','function protectionDraft()');
  assert.match(preview,/realActive=controllerRealPositionBySymbol\(selectedSymbol\)/);
  assert.match(preview,/realPositionPnlAtPrice\(realActive,sale\)/);
  assert.match(preview,/realPositionPriceForPnl\(realActive,target\)/);
});

test('live Binance target edits synchronize central state before protected exit replacement',()=>{
  const realSave=block('async function saveRealActiveTokenSettings','async function saveToken()');
  assert.match(realSave,/!inv\.managedMaxLoss\|\|inv\.maxLossConflict/);
  assert.match(realSave,/inv\.progressiveConflict/);
  assert.match(realSave,/buildRealProtectionLevels\(\{position,targetProfitUsd:manualTarget,maxLossUsd:currentMaxLoss,priceFilter\}\)/);
  assert.match(realSave,/tokenSettings\[s\]=\{\.\.\.old,targetProfit:manualTarget,manualTargetProfit:manualTarget,protectionStages:nextProtections/);
  assert.match(realSave,/const centralOk=await syncControllerCloudStateNow\(\)/);
  assert.match(realSave,/queueRealProtectiveUpdate\(position,'EXIT',\{wantedPrice:wantedExit,fromSettings:true\}\)/);
  assert.match(realSave,/if\(!queued\)[\s\S]*previousOwn[\s\S]*syncControllerCloudStateNow/);
  const queue=block('async function queueRealProtectiveUpdate(position,kind,options={})','function renderRealEntryOrders()');
  assert.match(queue,/wanted=parsePrice\(options\?\.wantedPrice,0\)/);
  assert.match(queue,/realProtectiveUpdatePending\.set/);
  assert.match(queue,/setTimeout\(\(\)=>refreshBinanceAccount\(\),1000\);[\s\S]*return true/);
});

test('live protection editor never shrinks below the currently stored stage count',()=>{
  const sync=block('function syncProtectionsToTarget(target)','function fillToken()');
  assert.match(sync,/realActive\?\(Array\.isArray\(saved\)\?saved\.length:0\):0/);
  const fill=block('function fillToken()','async function saveFutures()');
  assert.match(fill,/realActive\?\(Array\.isArray\(shownProtections\)\?shownProtections\.length:0\):0/);
});


test('special TradFi and future perpetual symbols remain discoverable in Futures exchangeInfo',()=>{
  const exchange=block('function isUsdMPerpetualContract(s)','function ruleNum');
  assert.match(exchange,/type==='PERPETUAL'\|\|type\.endsWith\('_PERPETUAL'\)/);
  assert.match(exchange,/s\?\.quoteAsset==='USDT'/);
  assert.match(exchange,/s\?\.status==='TRADING'/);
  assert.match(exchange,/if\(!isUsdMPerpetualContract\(s\)\)continue/);
  assert.match(html,/function addManualToken\(\)[\s\S]*exchangeMap\.has\(symbol\)/);
});


test('real-only UI exposes no simulation controls or local fake position path',()=>{
  assert.doesNotMatch(html,/<button[^>]+id="resetSimBtn"/);
  assert.doesNotMatch(html,/Positions actives — simulation/);
  assert.doesNotMatch(html,/simulation uniquement/);
  assert.match(html,/argent réel uniquement|réel uniquement/);
  const create=block('function createPosition(s,entry,source)','function closePosition');
  assert.match(create,/Simulation supprimée/);
  assert.match(create,/return null/);
  const close=block('function closePosition','async function currentMarketPrice');
  assert.match(close,/Simulation supprimée/);
  assert.match(close,/return false/);
});


test('configured protection lists are never truncated by a lower calculated target count',()=>{
  const normalize=block('function normalizeProtections(stages,target=3000)','function cfg(symbol)');
  assert.match(normalize,/Math\.max\(protectionCountForTarget\(target\),src\.length\)/);
  assert.doesNotMatch(normalize,/target==null/);
});
