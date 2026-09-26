import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path,'utf8');

const intent = read('lib/protective-update-intent.mjs');
const updateApi = read('api/binance-protective-update-execute.js');
const sync = read('api/zenith-sync.js');
const engine = read('server/zenith-engine-worker.mjs');
const entryTransition = read('lib/entry-transition.mjs');
const entryGate = read('lib/entry-protection-gate.mjs');
const protectiveCommand = read('lib/protective-command.mjs');
const reconcile = read('api/binance-reconcile.js');

function block(source,start,end){
  const a=source.indexOf(start);
  const b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start+' block missing');
  return source.slice(a,b);
}

test('MAX-LOSS builder is conditional LIMIT IOC only, never MARKET',()=>{
  const maxLoss=block(intent,"}else if(kind==='MAX_LOSS')","}else{");
  assert.match(maxLoss,/params\.type='STOP'/);
  assert.match(maxLoss,/params\.timeInForce='IOC'/);
  assert.match(maxLoss,/params\.quantity=String\(qty\)/);
  assert.match(maxLoss,/params\.reduceOnly='true'/);
  assert.match(maxLoss,/params\.priceMatch='OPPONENT'/);
  assert.doesNotMatch(maxLoss,/STOP_MARKET|TAKE_PROFIT_MARKET|TRAILING_STOP_MARKET/);
  assert.doesNotMatch(maxLoss,/closePosition/);
});

test('operational MAX-LOSS identity paths contain no STOP_MARKET writer contract',()=>{
  for(const [name,source] of [
    ['protective update API',updateApi],
    ['central sync',sync],
    ['engine worker',engine],
    ['entry transition',entryTransition],
    ['entry protection gate',entryGate],
    ['protective command',protectiveCommand],
  ]){
    assert.doesNotMatch(source,/STOP_MARKET/,name+' still contains STOP_MARKET');
  }
});

test('reconciliation rejects legacy or external MARKET protective orders fail-closed',()=>{
  assert.match(reconcile,/FORBIDDEN_MARKET_PROTECTIVE_ORDER/);
  assert.match(reconcile,/\['MARKET','STOP_MARKET','TAKE_PROFIT_MARKET','TRAILING_STOP_MARKET'\]/);
  const maxLossScan=block(reconcile,'const maxLossProtectionCounts','const transitionMissingProtectionPendingEntries');
  assert.doesNotMatch(maxLossScan,/STOP_MARKET|TAKE_PROFIT_MARKET|TRAILING_STOP_MARKET/);
  assert.match(maxLossScan,/String\(order\?\.type \|\| ''\)\.toUpperCase\(\) !== 'STOP'/);
  assert.match(maxLossScan,/String\(order\?\.timeInForce \|\| ''\)\.toUpperCase\(\) !== 'IOC'/);
  assert.match(maxLossScan,/String\(order\?\.priceMatch \|\| ''\)\.toUpperCase\(\) !== 'OPPONENT'/);
});

test('real execution remains locked until the full protective audit is complete',()=>{
  assert.match(sync,/const LIMIT_ONLY_PROTECTIVE_SELLS_AUDIT_COMPLETE = true;/);
  assert.match(sync,/LIMIT_ONLY_PROTECTIVE_SELLS_AUDIT_REQUIRED/);
});
