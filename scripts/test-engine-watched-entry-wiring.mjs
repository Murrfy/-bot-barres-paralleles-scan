import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');
const entryApi=await readFile(new URL('../api/binance-entry-execute.js',import.meta.url),'utf8');

test('24/7 engine reads watched entries and per-token risk settings',()=>{
  assert.match(worker,/runtime\.config\?\.validated/);
  assert.match(worker,/token\.margin/);
  assert.match(worker,/token\.leverage/);
  assert.match(worker,/token\.maxLoss/);
  assert.match(worker,/globalSettings\.maxActive/);
});

test('real watched entry prepares MAX-LOSS before submitting LIMIT',()=>{
  const prepare=worker.indexOf("phase:'PREPARE_PROTECTION'");
  const wait=worker.indexOf("waitForStreamOrder({kind:'ALGO'",prepare);
  const publish=worker.indexOf('await publishRuntime()',wait);
  const submit=worker.indexOf("phase:'SUBMIT_ENTRY'",publish);
  assert.ok(prepare>=0&&wait>prepare&&publish>wait&&submit>publish);
  assert.match(worker,/orderType:'LIMIT'/);
});

test('crossing trigger is persisted before any Binance entry write',()=>{
  const start=worker.indexOf('async function processEntryWatchPrice');
  const end=worker.indexOf('async function pruneAutoHighWater',start);
  const block=worker.slice(start,end);
  const persist=block.indexOf('await persistEntryWatchStateNow()');
  const execute=block.indexOf('await executeWatchedEntry(config,{');
  assert.ok(persist>=0&&execute>persist);
  assert.match(block,/ENTRY_TRIGGER_NOT_PERSISTED/);
});

test('50-second window is persistent, uses current LIMIT price when a slot opens, and expires fail-closed',()=>{
  assert.match(worker,/ENTRY_WAITING_FOR_POSITION_SLOT/);
  assert.match(worker,/pendingUntil/);
  assert.match(worker,/ENTRY_TRIGGER_EXPIRED/);
  assert.match(worker,/limitPrice:n\(result\.signal\?\.limitPrice,config\.buy\)/);
  assert.match(worker,/delayedCurrentPrice:result\.signal\?\.delayedCurrentPrice===true/);
  assert.match(worker,/limitPrice:effectiveLimitPrice/);
  assert.match(worker,/requestedBuyPrice:config\.buy/);
});

test('phased real entry can only be driven by engine principal',()=>{
  assert.match(entryApi,/ENTRY_PHASE_REQUIRED/);
  assert.match(entryApi,/ENTRY_ENGINE_REQUIRED/);
  assert.match(entryApi,/PREPARE_PROTECTION/);
  assert.match(entryApi,/SUBMIT_ENTRY/);
  assert.doesNotMatch(entryApi,/findCoveringEntryProtection/);
});

test('SUBMIT requires exact stream-confirmed prepared MAX-LOSS',()=>{
  assert.match(entryApi,/transitionProtectionMatches\(order,storedTransition\)/);
  assert.match(entryApi,/ENTRY_PROTECTION_NOT_STREAM_CONFIRMED/);
  const protect=entryApi.indexOf('placeAlgoOrderIdempotent');
  const entry=entryApi.indexOf('placeStandardOrderIdempotent',protect);
  assert.ok(protect>=0&&entry>protect);
});

test('lost prepared MAX-LOSS cancels pending LIMIT before generic reconciliation handling',()=>{
  const target=worker.indexOf('pendingEntryProtectionLossTargets(data.report)');
  const cancel=worker.indexOf('cancelPendingEntriesMissingPreparedProtection(data.report)',target);
  const orphan=worker.indexOf('orphanZenithCleanupOrders(data.report)',target);
  assert.ok(target>=0&&cancel>target&&orphan>cancel);
  assert.match(worker,/type:'EXEC_CANCEL_ENTRY'[\s\S]*clientOrderId:target\.entryClientOrderId/);
  assert.match(worker,/ENTRY_PROTECTION_LOSS_FILL_RACE/);
});
