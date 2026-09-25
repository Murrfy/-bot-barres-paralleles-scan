import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  assert.match(worker,/realNumberMatches\(order\?\.price,plan\.targetPrice\)/);
  assert.match(worker,/realNumberMatches\(remaining,live\.quantity\)/);
});

test('protective writer creates EXIT as NORMAL_LIMIT and order planner has no MARKET sell fallback',()=>{
  assert.match(api,/exitMode:'NORMAL_LIMIT'/);
  assert.match(intent,/mode === 'NORMAL_LIMIT'/);
  assert.match(intent,/params\.type = 'LIMIT'/);
  assert.doesNotMatch(intent,/EXIT_MARKET|MARKET_LAST_RESORT/);
});

test('external or duplicate exit orders are not overwritten by automatic target',()=>{
  const planner=fs.readFileSync('lib/auto-target-exit.mjs','utf8');
  assert.match(planner,/MULTIPLE_EXIT_LIMITS/);
  assert.match(planner,/EXTERNAL_EXIT_LIMIT_PRESENT/);
  assert.match(planner,/MANAGED_TARGET_ALREADY_OPEN/);
});
