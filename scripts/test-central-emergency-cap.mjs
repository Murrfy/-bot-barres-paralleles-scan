import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');

test('central ACK emergency validation requires live quantity and shared hard cap',()=>{
  assert.match(sync,/function runtimeEmergencyProtection\(runtimeState, symbol, direction, entryPrice, quantity, excludeClientAlgoId = ''\)/);
  assert.match(sync,/const qty = Math\.abs\(Number\(quantity\)\)/);
  assert.match(sync,/impliedLossUsd <= REAL_RISK_LIMITS\.maxLossUsd \+ 1e-8/);
  assert.match(sync,/Math\.abs\(Number\(position\?\.positionAmt\|\|position\?\.quantity\|\|0\)\)/);
});

test('central ACK emergency validation requires Zenith-managed MAX-LOSS',()=>{
  assert.match(sync,/\^zth-MAX-\[A-Za-z0-9\._:-\]\+\$/);
  assert.match(sync,/import \{ REAL_RISK_LIMITS \} from '\.\.\/lib\/risk-policy\.mjs'/);
});
