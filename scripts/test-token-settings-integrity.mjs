import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REAL_RISK_LIMITS, DEFAULT_MAX_ACTIVE_POSITIONS } from '../lib/risk-policy.mjs';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');
const repair=await readFile(new URL('../lib/maxloss-repair.mjs',import.meta.url),'utf8');
const zenithSync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');

function block(startText,endText){
  const start=html.indexOf(startText);
  const end=html.indexOf(endText,start);
  assert.ok(start>=0&&end>start,`missing block ${startText}`);
  return html.slice(start,end);
}

test('active exact-sale validation is present once without a duplicate branch',()=>{
  const needle="if (!exactSaleEnabled && exactSalePrice !== 0) return { ok:false, reason:'ACTIVE_EXACT_SALE_PRICE_MUST_BE_ZERO' };";
  assert.equal(zenithSync.split(needle).length-1,1);
});

test('each token can override Futures margin and leverage independently',()=>{
  const fill=block('function fillFutures()','function fillBot()');
  const save=block('async function saveFutures()','function readBotSettings()');
  const cfg=block('function cfg(symbol)','function exactProfitFor');
  assert.match(fill,/tokenSettings\[s\]/);
  assert.match(fill,/t\.margin,settings\.margin/);
  assert.match(fill,/t\.leverage,settings\.leverage/);
  assert.match(save,/tokenSettings\[s\]=\{\.\.\.\(old\|\|\{\}\),enabled:true,margin,leverage,marginType:'ISOLATED'/);
  assert.match(cfg,/base=\{\.\.\.settings,\.\.\.t\}/);
});



test('per-token Futures save is verified locally and against central controller state',()=>{
  const verify=block('async function persistAndVerifyTokenFuturesSettings','async function saveFutures()');
  assert.match(verify,/localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(verify,/LOCAL_TOKEN_FUTURES_NOT_PERSISTED/);
  assert.match(verify,/await syncControllerCloudStateNow\(\)/);
  assert.match(verify,/action=controller-state/);
  assert.match(verify,/q\.state\?\.data\?\.tokenSettings\?\.\[s\]/);
  assert.match(verify,/CENTRAL_TOKEN_FUTURES_MISMATCH/);

  const save=block('async function saveFutures()','function readBotSettings()');
  assert.match(save,/await persistAndVerifyTokenFuturesSettings\(s,margin,leverage\)/);
  assert.match(save,/Futures enregistré et vérifié/);
  assert.match(save,/Futures NON enregistré/);
  assert.match(save,/L’ancien réglage a été conservé/);
  assert.match(verify,/CONTROLLER_STATE_NOT_READY/);
});

test('Futures draft survives the Futures to token-settings tab transition before final save',()=>{
  const tabs=block("document.querySelectorAll('.tab').forEach(b=>b.onclick=", "$('manualTokenAddBtn').onclick=addManualToken");
  assert.match(tabs,/fromFutures/);
  assert.match(tabs,/futuresMargin=fromFutures&&selectedSymbol\?\$\('fMargin'\)\.value:null/);
  assert.match(tabs,/futuresLeverage=fromFutures&&selectedSymbol\?\$\('fLev'\)\.value:null/);
  assert.match(tabs,/b\.dataset\.pane==='tokenPane'/);
  assert.match(tabs,/\$\('fMargin'\)\.value=futuresMargin/);
  assert.match(tabs,/\$\('fLev'\)\.value=futuresLeverage/);
});

test('saving the token also persists the currently displayed Futures margin and leverage',()=>{
  const save=block('async function saveToken()','function devalidateSelected()');
  assert.match(save,/margin=Math\.max\(1,n\(\$\('fMargin'\)\.value,n\(old\.margin,settings\.margin\)\)\)/);
  assert.match(save,/leverage=Math\.round\(n\(\$\('fLev'\)\.value,n\(old\.leverage,settings\.leverage\)\)\)/);
  assert.match(save,/configuredMargin=margin/);
  assert.match(save,/const futures=futuresDraft\(s,margin,leverage,'LIMIT'\)/);
  assert.match(save,/tokenSettings\[s\]=\{\.\.\.old,enabled:true,margin,leverage,marginType:'ISOLATED',binanceQty:futures\.qty,binanceEffectiveNotional:futures\.effectiveNotional/);
  assert.match(save,/await persistAndVerifyTokenFuturesSettings\(s,margin,leverage\)/);
});

test('controller-state writes are serialized so an older save cannot race a newer token margin',()=>{
  const sync=block('async function syncControllerCloudStateNow()','function scheduleControllerCloudStateSync()');
  assert.match(sync,/while\(controllerStateSyncBusy\)await new Promise/);
  assert.match(sync,/controllerStateSyncBusy=true/);
  assert.match(sync,/finally\{[\s\S]*controllerStateSyncBusy=false/);
});

test('locked operational defaults are +40 target, -40 MAX-LOSS and protection 1 at +30 to +20',()=>{
  assert.match(html,/const DEFAULT_PROTECTIONS=\[\{enabled:true,arm:30,floor:20\}\]/);
  assert.match(html,/const DEFAULTS=\{[^\n]*targetProfit:40,maxLoss:40,protectionStages:DEFAULT_PROTECTIONS/);
  assert.match(html,/function normalizeProtections\(stages,target=40\)/);
  assert.match(html,/function renderProtectionEditor\(stages,target=40,minCount=0\)/);
});

test('load never upgrades the locked +40/-40 defaults back to legacy +3000/-400',()=>{
  const load=block('function load()','async function jf(path)');
  assert.doesNotMatch(load,/targetProfit\)===40\)settings\.targetProfit=3000/);
  assert.doesNotMatch(load,/maxLoss\)===40\)settings\.maxLoss=400/);
  assert.doesNotMatch(load,/t\?\.targetProfit\)===40[\s\S]*t\.targetProfit=3000/);
  assert.doesNotMatch(load,/t\?\.maxLoss\)===40\)t\.maxLoss=400/);
});

test('legacy +3000/-400 migration is restricted to the exact old default protection profile',()=>{
  const defaults=block('const DEFAULT_PROTECTIONS=','const DEFAULTS=');
  assert.match(defaults,/function legacyDefaultProtectionProfile\(stages\)/);
  assert.match(defaults,/rows\.length===29/);
  assert.match(defaults,/105\+i\*100/);
  assert.match(defaults,/100\+i\*100/);
  const load=block('function load()','async function jf(path)');
  assert.match(load,/legacyGlobalDefaults=n\(x\.settings\?\.targetProfit\)===3000&&n\(x\.settings\?\.maxLoss\)===400&&legacyDefaultProtectionProfile\(x\.settings\?\.protectionStages\)/);
  assert.match(load,/if\(legacyGlobalDefaults\)\{settings\.targetProfit=40;settings\.maxLoss=40;settings\.protectionStages=clone\(DEFAULT_PROTECTIONS\)\}/);
  assert.match(load,/legacyTokenDefaults=n\(t\?\.targetProfit\)===3000&&n\(t\?\.manualTargetProfit,3000\)===3000&&n\(t\?\.maxLoss\)===400&&legacyDefaultProtectionProfile\(t\?\.protectionStages\)/);
});

test('configured protection arrays remain untruncated after the default reset',()=>{
  const normalize=block('function normalizeProtections(stages,target=40)','function cfg(symbol)');
  assert.match(normalize,/Math\.max\(protectionCountForTarget\(target\),src\.length\)/);
  const editor=block('function protectionsForTarget(stages,target,minCount=0)','function applyProtectionVisibility()');
  assert.match(editor,/Math\.max\(protectionCountForTarget\(target\),src\.length,Math\.max\(0,Math\.floor\(n\(minCount,0\)\)\)\)/);
});

test('token gain, max-loss and progressive protections persist as token overrides',()=>{
  const save=block('async function saveToken()','function devalidateSelected()');
  assert.match(save,/targetProfit:shown/);
  assert.match(save,/manualTargetProfit:manual/);
  assert.match(save,/maxLoss:requestedMaxLoss/);
  assert.match(save,/protectionStages:protections/);
  const pos=block('function positionCfg(s)','async function currentMarketPrice');
  assert.match(pos,/const c=cfg\(s\)/);
  assert.match(pos,/targetProfit:n\(c\.targetProfit\)/);
  assert.match(pos,/maxLoss:n\(c\.maxLoss\)/);
});

test('per-token MAX-LOSS cannot be saved above that token configured margin',()=>{
  const save=block('async function saveToken()','function devalidateSelected()');
  assert.match(save,/configuredMargin=margin/);
  assert.match(save,/requestedMaxLoss>configuredMargin/);
  assert.match(save,/elle ne peut pas dépasser la marge configurée du jeton/);
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
  assert.equal(DEFAULT_MAX_ACTIVE_POSITIONS,3);
  assert.equal('maxActivePositions' in REAL_RISK_LIMITS,false);
  assert.match(html,/id="fLev"[^>]*max="10"/);
  assert.match(html,/id="fMargin"[^>]*max="1000"/);
  assert.match(html,/id="bMaxActive"[^>]*min="1"[^>]*step="1"/);
  assert.doesNotMatch(html,/id="bMaxActive"[^>]*max=/);
  assert.doesNotMatch(html,/lev=clamp\(n\(t\.leverage,settings\.leverage\),1,125\)/);
  assert.doesNotMatch(html,/readBotSettings\(\)[\s\S]{0,220}Math\.min/);
});

test('watched tokens freeze settings while active positions keep only safe controls editable',()=>{
  const locks=block('function setTokenFieldsEnabled()','function updateTokenPreview()');
  assert.match(locks,/Achat surveillé : paramètres verrouillés/);
  assert.match(locks,/\['tExactBuy','tExactBuyPrice','tExactSale','tExactSalePrice','tTarget','tMaxLoss'\]/);
  assert.match(locks,/Position réelle ACTIVE : objectif de gain, prix déterminé de VENTE, protections et perte MAX modifiables/);
  assert.match(locks,/\['tExactBuy','tExactBuyPrice'\]/);
  assert.match(locks,/activeSettingPending/);
  assert.match(locks,/\$\('tMaxLoss'\)\.disabled=!realActive\|\|activeSettingPending/);
  assert.match(locks,/\['tExactSale','tExactSalePrice','tTarget'\]\.forEach\(id=>\$\(id\)\.disabled=activeSettingPending\)/);
  assert.match(locks,/\$\('fMargin'\)\.disabled=true;\$\('fLev'\)\.disabled=true/);
  assert.match(locks,/\$\('devalidateBtn'\)\.disabled=!validated\[selectedSymbol\]/);
});

test('devalidation removes only watch state and never mutates active buy margin or Binance position',()=>{
  const devalidate=block('function devalidateSelected()','function tokenDefaults()');
  assert.match(devalidate,/delete validated\[s\]/);
  assert.match(devalidate,/delete missedSignals\[s\]/);
  assert.match(devalidate,/delete revalidateBlock\[s\]/);
  assert.doesNotMatch(devalidate,/tokenSettings\[s\]\s*=/);
  assert.doesNotMatch(devalidate,/openPositions/);
  assert.doesNotMatch(devalidate,/margin\s*=/);
  assert.doesNotMatch(devalidate,/EXEC_CANCEL_ENTRY|cancelEntry|binance|fetch\(/i);
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
  assert.match(protections,/Math\.max\(protectionCountForTarget\(target\),src\.length,Math\.max\(0,Math\.floor\(n\(minCount,0\)\)\)\)/);
  assert.match(protections,/reachedProtectionCount\(stages,maxProfit\)/);
});


test('global risk defaults can be updated without overwriting per-token overrides',()=>{
  const saveDefaults=block('async function saveSelectedAsDefaults()','async function saveToken()');
  assert.match(saveDefaults,/openPositions\.length\|\|n\(binanceAccount\.realPositions\)>0\|\|Object\.keys\(validated\)\.length/);
  assert.match(saveDefaults,/settings=\{\.\.\.settings,margin,leverage,marginType:'ISOLATED',targetProfit:target,maxLoss,protectionStages:clone\(protections\)\}/);
  assert.doesNotMatch(saveDefaults,/tokenSettings\s*=/);
  assert.match(saveDefaults,/maxLoss>margin/);
  const cloud=block('function controllerCloudStatePayload(','async function syncControllerCloudStateNow()');
  assert.match(cloud,/const controlSettings=clone\(settings\)/);
  assert.match(cloud,/settings:controlSettings/);
  assert.match(cloud,/for\(const key of \['theme','sound','vibrate','showProtections'\]\)delete controlSettings\[key\]/);
  assert.match(cloud,/function controllerCloudStatePayload\(tokenSettingsSource=tokenSettings\)/);
  assert.match(cloud,/tokenSettings:clone\(normalizeRecordBlock\(tokenSettingsSource\)\)/);
});

test('BOT save persists editable global margin and leverage without touching per-token overrides',()=>{
  assert.match(html,/id="bDefaultMargin"[^>]*min="1"[^>]*max="1000"/);
  assert.match(html,/id="bDefaultLeverage"[^>]*min="1"[^>]*max="10"/);
  const fill=block('function fillBot()','function setTokenFieldsEnabled()');
  assert.match(fill,/\$\('bDefaultMargin'\)\.value=n\(settings\.margin,1000\)/);
  assert.match(fill,/\$\('bDefaultLeverage'\)\.value=Math\.round\(n\(settings\.leverage,10\)\)/);
  const saveBot=block('function readBotSettings()','async function saveSelectedAsDefaults()');
  assert.match(saveBot,/margin=n\(\$\('bDefaultMargin'\)\.value,NaN\)/);
  assert.match(saveBot,/leverage=Math\.round\(n\(\$\('bDefaultLeverage'\)\.value,NaN\)\)/);
  assert.match(saveBot,/return\{margin,leverage,marginType:'ISOLATED'/);
  assert.doesNotMatch(saveBot,/tokenSettings\s*=/);
});

test('BOT exposes and persists the important MAX-LOSS red notification setting',()=>{
  assert.match(html,/id="bMaxLossAlert"[^>]*type="checkbox"/);
  assert.match(html,/Notification importante si le MAX-LOSS d’un jeton actif devient rouge/);
  assert.match(html,/const DEFAULTS=\{[^\n]*maxLossAlert:true/);
  const fill=block('function fillBot()','function setTokenFieldsEnabled()');
  assert.match(fill,/\$\('bMaxLossAlert'\)\.checked=settings\.maxLossAlert!==false/);
  const saveBot=block('function readBotSettings()','async function saveSelectedAsDefaults()');
  assert.match(saveBot,/maxLossAlert:\$\('bMaxLossAlert'\)\.checked/);
  const cloud=block('function controllerCloudStatePayload(','async function syncControllerCloudStateNow()');
  assert.doesNotMatch(cloud,/\['theme','sound','vibrate','showProtections','maxLossAlert'\]/);
});

test('BOT trading defaults cannot change while a position or watched entry is active',()=>{
  const saveBot=block('function readBotSettings()','async function saveSelectedAsDefaults()');
  assert.match(saveBot,/tradingChanged=/);
  assert.match(saveBot,/next\.margin/);
  assert.match(saveBot,/next\.leverage/);
  assert.match(saveBot,/next\.maxActive/);
  assert.match(saveBot,/openPositions\.length\|\|n\(binanceAccount\.realPositions\)>0\|\|Object\.keys\(validated\)\.length/);
  assert.match(saveBot,/Réglages BOT de trading verrouillés/);
});

test('load preserves explicitly saved global margin values',()=>{
  const load=block('function load()','async function jf(path)');
  assert.doesNotMatch(load,/x\.settings\?\.margin\)===100[^\n]*settings\.margin=1000/);
});

test('global defaults stay visible and are copied only by explicit action',()=>{
  assert.match(html,/id="defaultRiskSummary"/);
  assert.match(html,/id="saveBotDefaultsBtn"/);
  const fill=block('function fillBot()','function setTokenFieldsEnabled()');
  assert.match(fill,/Défauts risque : marge ISOLÉE/);
  assert.match(html,/\$\('saveBotDefaultsBtn'\)\.onclick=saveSelectedAsDefaults/);
});


test('live Binance positions lock unsafe token controls on the iPhone',()=>{
  const helpers=block('function controllerRealPositionBySymbol(symbol)','function trackedSymbols()');
  assert.match(helpers,/binanceAccount\.positions/);
  assert.match(helpers,/anyActivePositionBySymbol\(symbol\)/);
  const locks=block('function setTokenFieldsEnabled()','function updateTokenPreview()');
  assert.match(locks,/realActive=controllerRealPositionBySymbol\(selectedSymbol\)/);
  assert.match(locks,/\['tExactBuy','tExactBuyPrice'\]/);
  assert.match(locks,/activeSettingPending/);
  assert.match(locks,/\$\('tMaxLoss'\)\.disabled=!realActive\|\|activeSettingPending/);
  assert.match(locks,/\['tExactSale','tExactSalePrice','tTarget'\]\.forEach\(id=>\$\(id\)\.disabled=activeSettingPending\)/);
  assert.match(locks,/Position réelle ACTIVE/);
  assert.match(locks,/binanceAccount\.realPositions/);
  assert.match(locks,/settings\.maxActive/);
  assert.doesNotMatch(locks,/openPositions\.length>=settings\.maxActive/);
  const futures=block('async function saveFutures()','function readBotSettings()');
  assert.match(futures,/anyActivePositionBySymbol\(s\)/);
  const fillTokenBlock=block('function fillToken()','async function saveFutures()');
  assert.match(fillTokenBlock,/binanceAccount\.realPositions/);
  assert.doesNotMatch(fillTokenBlock,/openPositions\.length>=settings\.maxActive/);
  const instant=block('async function instantBuySelected()','async function manualClose');
  assert.doesNotMatch(instant,/createPosition\(/);
  assert.match(instant,/buildControllerMarketEntryCommand/);
  assert.match(instant,/\/api\/zenith-sync\?action=command/);
  assert.match(instant,/ARGENT RÉEL — ACHAT IMMÉDIAT MARKET/);
  assert.match(html,/function tokenDefaults\(\)[\s\S]*anyActivePositionBySymbol\(selectedSymbol\)/);
});

test('live Binance target preview uses actual entry quantity and direction',()=>{
  const helpers=block('function controllerRealPositionBySymbol(symbol)','function trackedSymbols()');
  assert.match(helpers,/realPositionPnlAtPrice\(position,mark\)/);
  assert.match(helpers,/realPositionPriceForPnl\(position,pnl\)/);
  assert.match(helpers,/amount>0\?1:-1/);
  const preview=block('function updateTokenPreview()','function protectionDraft()');
  assert.match(preview,/realActive=controllerRealPositionBySymbol\(selectedSymbol\)/);
  assert.match(preview,/realPositionPnlAtPrice\(realActive,sale\)/);
  assert.match(preview,/realPositionPriceForPnl\(realActive,target\)/);
});

test('live Binance target and protection edits keep old config until server ACK',()=>{
  const realSave=block('async function saveRealActiveTokenSettings','async function saveToken()');
  assert.match(realSave,/!inv\.managedMaxLoss\|\|inv\.maxLossConflict/);
  assert.match(realSave,/inv\.progressiveConflict/);
  assert.match(realSave,/buildRealProtectionLevels\(\{[\s\S]*position,[\s\S]*targetProfitUsd:manualTarget,[\s\S]*maxLossUsd:requestedMaxLoss,[\s\S]*priceFilter[\s\S]*\}\)/);
  assert.match(realSave,/const activeConfig=\{/);
  assert.match(realSave,/protectionStages:nextProtections/);
  assert.match(realSave,/queueRealProtectiveUpdate\(position,'EXIT',[\s\S]*activeConfig/);
  assert.match(realSave,/queueRealActiveConfigUpdate\(position,activeConfig\)/);
  assert.doesNotMatch(realSave,/tokenSettings\[s\]\s*=/);
  assert.doesNotMatch(realSave,/syncControllerCloudStateNow\(\)/);
  const queue=block('async function queueRealProtectiveUpdate(position,kind,options={})','function renderRealEntryOrders()');
  assert.match(queue,/clientCommandId:String\(command\?\.clientCommandId\|\|''\)/);
  assert.match(queue,/persistRealProtectiveUpdatePending\(\)/);
  assert.match(queue,/checkRealTrackedCommandStatus/);
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


test('real-only UI contains no simulation controls or local fake position path',()=>{
  assert.doesNotMatch(html,/<button[^>]+id="resetSimBtn"/);
  assert.doesNotMatch(html,/Positions actives — simulation/);
  assert.doesNotMatch(html,/simulation uniquement/);
  assert.match(html,/argent réel uniquement|réel uniquement/);
  assert.doesNotMatch(html,/function createPosition\(/);
  assert.doesNotMatch(html,/function closePosition\(/);
  assert.doesNotMatch(html,/Simulation supprimée/);
});


test('configured protection lists are never truncated by a lower calculated target count',()=>{
  const normalize=block('function normalizeProtections(stages,target=40)','function cfg(symbol)');
  assert.match(normalize,/Math\.max\(protectionCountForTarget\(target\),src\.length\)/);
  assert.doesNotMatch(normalize,/target==null/);
});


test('full token save refuses to commit Futures overrides before central controller state is ready',()=>{
  const save=block('async function saveToken()','function devalidateSelected()');
  assert.match(save,/controllerIdentity\.paired&&controllerIdentity\.role==='controller'&&controllerStateHydrated/);
  assert.match(save,/await refreshControllerIdentity\(\)/);
  assert.match(save,/réglages du jeton NON enregistrés — contrôleur\/synchronisation centrale non prêt/);
  assert.match(save,/await persistAndVerifyTokenFuturesSettings\(s,margin,leverage\)/);
});


test('triggered watched entry leaves the watch KPI and real Binance position is active in the token list',()=>{
  assert.match(html,/function realEntryTriggered\(s\)[\s\S]*state\.status==='TRIGGERED'/);
  const status=block('function rowStatus(s)','function tableRows()');
  assert.match(status,/controllerRealPositionBySymbol\(s\)[\s\S]*return 'ACTIF'/);
  assert.match(status,/realEntryTriggered\(s\)[\s\S]*return 'DÉCLENCHÉ'/);
  const rows=block('function tableRows()','function distanceBuy');
  assert.match(rows,/binanceAccount\.positions/);
  assert.match(rows,/controllerRealPositionBySymbol\(s\)\|\|openBySymbol\(s\)\?0/);
  const kpis=block('function renderKpis()','function pnlAt');
  assert.match(kpis,/!controllerRealPositionBySymbol\(s\)/);
  assert.match(kpis,/!realEntryTriggered\(s\)/);
  const render=block('function renderTable()','function totals()');
  assert.match(render,/controllerRealPositionBySymbol\(s\)\|\|openBySymbol\(s\)/);
});
