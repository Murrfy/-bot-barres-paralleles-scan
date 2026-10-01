import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');

test('central ACK emergency validation requires live quantity without a fixed global hard cap',()=>{
  assert.match(sync,/function runtimeEmergencyProtection\(runtimeState, symbol, direction, entryPrice, quantity, excludeClientAlgoId = ''\)/);
  assert.match(sync,/const qty = Math\.abs\(Number\(quantity\)\)/);
  assert.match(sync,/return impliedLossUsd >= 0/);
  assert.doesNotMatch(sync,/impliedLossUsd <= REAL_RISK_LIMITS\.maxLossUsd \+ 1e-8/);
  assert.match(sync,/Math\.abs\(Number\(position\?\.positionAmt\|\|position\?\.quantity\|\|0\)\)/);
});

test('central ACK emergency validation accepts a safe Binance MAX-LOSS regardless of client-id owner',()=>{
  const start=sync.indexOf('function runtimeEmergencyProtection');
  const end=sync.indexOf('function commandExpired',start);
  const block=sync.slice(start,end);
  assert.match(block,/const clientAlgoId = String\(order\?\.clientAlgoId \|\| ''\)/);
  assert.match(block,/if \(!clientAlgoId \|\| clientAlgoId\.length > 36\) return false/);
  assert.doesNotMatch(block,/\^zth-MAX-/);
  assert.match(sync,/import \{ REAL_RISK_LIMITS \} from '\.\.\/lib\/risk-policy\.mjs'/);
});
