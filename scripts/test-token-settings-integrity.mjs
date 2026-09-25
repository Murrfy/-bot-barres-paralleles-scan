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
  assert.match(sync,/const active=openBySymbol\(selectedSymbol\)/);
  assert.match(sync,/minCount=active\?reachedProtectionCount\(merged,active\.maxProfit\):0/);
  assert.match(sync,/renderProtectionEditor\(merged,target,minCount\)/);
  const protections=block('function protectionsForTarget(stages,target,minCount=0)','function applyProtectionVisibility()');
  assert.match(protections,/Math\.max\(protectionCountForTarget\(target\),Math\.max\(0,Math\.floor\(n\(minCount,0\)\)\)\)/);
  assert.match(protections,/reachedProtectionCount\(stages,maxProfit\)/);
});
