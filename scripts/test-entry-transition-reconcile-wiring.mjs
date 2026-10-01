import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const reconcile=await readFile(new URL('../api/binance-reconcile.js',import.meta.url),'utf8');

test('reconciliation loads server-owned entry transition records and passes them to pure reconciliation',()=>{
  assert.match(reconcile,/KEY_ENTRY_TRANSITIONS/);
  assert.match(reconcile,/redis\(\['HGETALL', KEY_ENTRY_TRANSITIONS\]\)/);
  assert.match(reconcile,/parseEntryTransitionStore\(entryTransitionRaw\)/);
  assert.match(reconcile,/const scopedRuntimeState=runtimeStateWithinScope\(runtimeState,scopeSymbols\)/);
  assert.match(reconcile,/reconcile\(scopedRuntimeState, actualPositions, actualOrders, entryTransitions, controllerState\)/);
});

test('only exact transition order identities are exempted from untracked/orphan classification',()=>{
  assert.match(reconcile,/transitionAllowedOrders\.has\(key\)/);
  assert.match(reconcile,/transitionAllowedOrders\.has\(entryTransitionOrderIdentity\(order\)\)/);
  assert.match(reconcile,/ENTRY_TRANSITION_PROTECTION_MISSING/);
  assert.match(reconcile,/ENTRY_TRANSITION_ENTRY_MISSING/);
  assert.match(reconcile,/ENTRY_TRANSITION_STATE_INVALID/);
  assert.match(reconcile,/ENTRY_TRANSITION_RUNTIME_NOT_REAL/);
});


test('partial entry full-size MAX-LOSS exception is wired through both reconciliation safety passes',()=>{
  assert.match(reconcile,/partialEntryTransitionProtectionCoversPosition/);
  const calls=(reconcile.match(/partialEntryTransitionProtectionCoversPosition\(\{/g)||[]).length;
  assert.equal(calls,2);
  assert.match(reconcile,/activeTransitions:transitionState\.active/);
  assert.match(reconcile,/device\.deviceId,\s*entryTransitions\s*\)/);
});


test('flat partial-entry state is reported and localized before write-ahead recovery can recreate it',()=>{
  assert.match(reconcile,/ENTRY_TRANSITION_PARTIAL_FILL_FLAT/);
  assert.match(reconcile,/partialFillFlatEntries: transitionPartialFillFlatEntries/);
  assert.match(reconcile,/ENTRY_PARTIAL_FILL_FLAT_RECOVERY_PENDING/);
  const localizer=reconcile.indexOf("reasons.length===1&&reasons[0]==='ENTRY_TRANSITION_PARTIAL_FILL_FLAT'");
  const writeAhead=reconcile.indexOf("reasons.length===1&&reasons[0]==='ENTRY_TRANSITION_ENTRY_MISSING'");
  assert.ok(localizer>=0&&writeAhead>localizer);
});


test('sale-started partial entry is reported and localized before write-ahead recovery',()=>{
  assert.match(reconcile,/ENTRY_TRANSITION_PARTIAL_FILL_EXIT_STARTED/);
  assert.match(reconcile,/partialFillExitStartedEntries: transitionPartialFillExitStartedEntries/);
  assert.match(reconcile,/ENTRY_PARTIAL_FILL_EXIT_STARTED_RECOVERY_PENDING/);
  assert.match(reconcile,/liveQuantity<executed-tolerance/);
  const saleStarted=reconcile.indexOf("reasons.includes('ENTRY_TRANSITION_PARTIAL_FILL_EXIT_STARTED')");
  const flat=reconcile.indexOf("reasons.length===1&&reasons[0]==='ENTRY_TRANSITION_PARTIAL_FILL_FLAT'");
  const writeAhead=reconcile.indexOf("reasons.length===1&&reasons[0]==='ENTRY_TRANSITION_ENTRY_MISSING'");
  assert.ok(saleStarted>=0&&flat>saleStarted&&writeAhead>flat);
});
