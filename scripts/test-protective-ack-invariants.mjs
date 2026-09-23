import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');

test('protective ACK confirms exact progressive STOP+LIMIT identity',()=>{
  assert.match(sync,/String\(order\?\.type \|\| ''\)\.toUpperCase\(\) === 'STOP'/);
  assert.match(sync,/String\(order\?\.timeInForce \|\| ''\)\.toUpperCase\(\) === 'GTC'/);
  assert.match(sync,/numberMatches\(order\?\.origQty, payloadStatus\.quantity\)/);
  assert.match(sync,/numberMatches\(order\?\.price, payloadStatus\.limitPrice\)/);
  assert.match(sync,/!order\?\.priceMatch \|\| String\(order\?\.priceMatch \|\| ''\)\.toUpperCase\(\) === 'NONE'/);
});

test('protective ACK requires Zenith-managed emergency MAX-LOSS within hard loss cap',()=>{
  assert.match(sync,/\/\^zth-\[A-Za-z0-9\._:-\]\+\$\/\.test\(clientAlgoId\)/);
  assert.match(sync,/const impliedLossUsd = dir === 'LONG'/);
  assert.match(sync,/REAL_RISK_LIMITS\.maxLossUsd\+1e-8/);
  assert.match(sync,/runtimePositionRecord\(runtimeState, sym, dir\)/);
});

test('protective ACK excludes the progressive order itself from emergency MAX-LOSS proof',()=>{
  assert.match(sync,/runtimeEmergencyProtection\(readiness\.runtimeState,payloadStatus\.symbol,payloadStatus\.direction,entryPrice,newClientId\)/);
  assert.match(sync,/excludeClientAlgoId && clientAlgoId === String\(excludeClientAlgoId\)/);
});
