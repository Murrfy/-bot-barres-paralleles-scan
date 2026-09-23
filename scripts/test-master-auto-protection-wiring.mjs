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
