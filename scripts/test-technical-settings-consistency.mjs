import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const risk=await readFile(new URL('../lib/risk-policy.mjs',import.meta.url),'utf8');
const preflight=await readFile(new URL('../api/binance-entry-preflight.js',import.meta.url),'utf8');
const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('real UI caps match server caps',()=>{
  assert.match(html,/id="fLev"[^>]*max="10"/);
  assert.match(html,/id="bMaxActive"[^>]*max="3"/);
  assert.match(risk,/maxActivePositions:\s*3/);
  assert.match(risk,/maxLeverage:\s*10/);
  assert.match(risk,/maxMarginUsdt:\s*1000/);
  assert.match(risk,/maxNotionalUsdt:\s*10000/);
  assert.match(risk,/maxLossUsd:\s*400/);
});

test('Futures margin and leverage are stored per token, not globally overwritten',()=>{
  assert.match(html,/tokenSettings\[s\]=\{\.\.\.old,enabled:true,margin,leverage,marginType:'ISOLATED'/);
  assert.match(html,/function cfg\(symbol\)\{const t=tokenSettings\[symbol\]\|\|\{\},base=\{\.\.\.settings,\.\.\.t\}/);
  assert.match(html,/function fillFutures\(\).*t=tokenSettings\[s\]\|\|\{\},margin=Math\.max\(1,n\(t\.margin,settings\.margin\)\)/s);
});

test('per-token profit target and max loss persist independently',()=>{
  assert.match(html,/tokenSettings\[s\]=\{\.\.\.old,enabled:true,targetProfit:shown,manualTargetProfit:manual,protectionStages:protections,maxLoss:requestedMaxLoss/);
  assert.match(html,/const requestedMaxLoss=n\(\$\('tMaxLoss'\)\.value,settings\.maxLoss\)/);
  assert.match(html,/\$\('tTarget'\)\.addEventListener\('input'.*syncProtectionsToTarget/s);
});

test('controller cloud state carries per-token settings to Render',()=>{
  assert.match(html,/function controllerCloudStatePayload\(\)[\s\S]*tokenSettings:clone\(normalizeRecordBlock\(tokenSettings\)\)/);
  assert.match(worker,/runtime\.config=clone\(controllerState\.data\)/);
  assert.match(worker,/runtime\.config\?\.tokenSettings/);
});

test('real preflight verifies actual Binance per-symbol Futures configuration',()=>{
  assert.match(preflight,/\/fapi\/v1\/symbolConfig/);
  assert.match(preflight,/\/fapi\/v1\/leverageBracket/);
  assert.match(risk,/MARGIN_TYPE_NOT_ISOLATED/);
  assert.match(risk,/ACCOUNT_LEVERAGE_MISMATCH/);
  assert.match(risk,/LEVERAGE_BRACKET_EXCEEDED/);
});

test('changed profit targets drive the protection ladder and invalid exact loss targets are rejected',()=>{
  assert.match(html,/syncProtectionsToTarget\(Math\.max\(0,target\)\)/);
  assert.match(html,/salePrice<=buyPrice/);
  assert.match(html,/Le prix de vente déterminé doit être supérieur au prix d’achat déterminé/);
  assert.match(html,/function protectionCountForTarget\(target\)/);
  assert.match(html,/arm:105\+i\*100,floor:100\+i\*100/);
});

test('real exposure locks token and Futures settings',()=>{
  assert.match(html,/function accountRealPositionBySymbol\(symbol\)/);
  assert.match(html,/function accountRealEntryOrderBySymbol\(symbol\)/);
  assert.match(html,/realActive\|\|realEntry/);
  assert.match(html,/Position RÉELLE active/);
  assert.match(html,/Entrée RÉELLE en attente/);
  assert.match(html,/Futures verrouillé pendant une position ou une entrée RÉELLE/);
});

test('stored legacy risk settings are clamped to current real caps',()=>{
  assert.match(html,/settings\.margin=Math\.min\(1000/);
  assert.match(html,/settings\.leverage=clamp\(n\(settings\.leverage,10\),1,10\)/);
  assert.match(html,/settings\.maxActive=clamp\(Math\.round\(n\(settings\.maxActive,3\)\),1,3\)/);
  assert.match(html,/t\.margin=Math\.min\(1000/);
  assert.match(html,/t\.leverage=clamp\(n\(t\?\.leverage,settings\.leverage\),1,10\)/);
});
