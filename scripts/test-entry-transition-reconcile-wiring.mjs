import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const reconcile=await readFile(new URL('../api/binance-reconcile.js',import.meta.url),'utf8');

test('reconciliation loads server-owned entry transition records and passes them to pure reconciliation',()=>{
  assert.match(reconcile,/KEY_ENTRY_TRANSITIONS/);
  assert.match(reconcile,/redis\(\['HGETALL', KEY_ENTRY_TRANSITIONS\]\)/);
  assert.match(reconcile,/parseEntryTransitionStore\(entryTransitionRaw\)/);
  assert.match(reconcile,/reconcile\(runtimeState, actualPositions, actualOrders, entryTransitions\)/);
});

test('only exact transition order identities are exempted from untracked/orphan classification',()=>{
  assert.match(reconcile,/transitionAllowedOrders\.has\(key\)/);
  assert.match(reconcile,/transitionAllowedOrders\.has\(entryTransitionOrderIdentity\(order\)\)/);
  assert.match(reconcile,/ENTRY_TRANSITION_PROTECTION_MISSING/);
  assert.match(reconcile,/ENTRY_TRANSITION_ENTRY_MISSING/);
  assert.match(reconcile,/ENTRY_TRANSITION_STATE_INVALID/);
  assert.match(reconcile,/ENTRY_TRANSITION_RUNTIME_NOT_REAL/);
});
