import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('MASTER tracks real Binance positions independently of controller network',()=>{
  assert.match(html,/masterStreamProjection\(\)\.binancePositions/);
  assert.match(html,/if\(controllerIdentity\.role==='master'\)\{/);
  assert.match(html,/trackedSymbols\(\)\.has\(q\.s\)/);
  assert.match(html,/scheduleMasterAutoProtection\(s,mark\)/);
});

test('MASTER auto protection persists high-water and selects shared highest-crossed planner',()=>{
  assert.match(html,/MASTER_AUTO_HIGHWATER_KEY/);
  assert.match(html,/saveMasterAutoProtectionHighWater\(\)/);
  assert.match(html,/evaluateMasterAutoProgressiveProtection\(\{/);
  assert.match(html,/previousHighWaterProfitUsd:highWater/);
});

test('automatic progressive replacement uses exact trigger and LIMIT price with Binance confirmation',()=>{
  assert.match(html,/triggerPrice:level\.triggerPrice/);
  assert.match(html,/limitPrice:level\.limitPrice/);
  assert.match(html,/phase:'CANCEL_OLD'/);
  assert.match(html,/phase:'PLACE_NEW'/);
  assert.match(html,/waitForStreamOrder\(\{kind:'ALGO',clientId,terminal:false\}/);
  assert.match(html,/realNumberMatches\(order\?\.price,level\.limitPrice\)/);
});


test('automatic progressive replacement places and confirms new protection before canceling old',()=>{
  const start=html.indexOf('async function executeMasterAutoProgressive(plan)');
  const end=html.indexOf('async function runMasterAutoProtection',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);
  const place=block.indexOf("phase:'PLACE_NEW'");
  const confirm=block.indexOf("waitForStreamOrder({kind:'ALGO',clientId,terminal:false}");
  const cancel=block.indexOf("phase:'CANCEL_OLD'");
  assert.ok(place>=0&&confirm>place&&cancel>confirm);
  assert.match(block,/newClientAlgoId:clientId/);
});

test('manual/controller progressive replacement also uses place-new-before-cancel-old',()=>{
  const start=html.indexOf('async function runMasterProtectiveUpdate(command,raw,dispatch)');
  const end=html.indexOf('async function waitForFullCloseState',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);
  assert.match(block,/if\(maxLoss\|\|progressive\)/);
  assert.match(block,/newClientId=await placeNew\(\)[\s\S]*cancelOld\(newClientId\)/);
});


test('auto-protection high-water is scoped to the exact Binance position lifecycle',()=>{
  assert.match(html,/position\?\.lifecycleAt\?\?position\?\.positionLifecycleAt\?\?position\?\.updateTime/);
  assert.match(html,/return \`\$\{symbol\}:\$\{direction\}:\$\{qty\}:\$\{entry\}:\$\{lifecycle\}\`/);
  assert.match(html,/pruneMasterAutoProtectionHighWater\(\)/);
  assert.match(html,/projection\.userStream\?\.ready!==true/);
  assert.match(html,/live\.lifecycleAt\|\|live\.updateTime/);
});
