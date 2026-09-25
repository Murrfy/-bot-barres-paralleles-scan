import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('Render imports the pure entry-watch state machine',()=>{
  assert.match(worker,/from '..\/lib\/entry-watch\.mjs'/);
  assert.match(worker,/evaluateEntryWatchTick/);
  assert.match(worker,/entryWatchDefinition/);
});

test('entry watch remains fail-closed until its fenced persisted state is loaded',()=>{
  const start=worker.indexOf('function watchedEntrySymbols(){');
  const end=worker.indexOf('function trackedMarkSymbols(){',start);
  const block=worker.slice(start,end);
  assert.match(block,/if\(!entryWatch\.loaded\)return out/);
});

test('market subscriptions combine active protections and validated entry watches',()=>{
  const start=worker.indexOf('function trackedMarkSymbols(){');
  const end=worker.indexOf('function entryWatchMayDispatch(){',start);
  const block=worker.slice(start,end);
  assert.match(block,/activeProtectionSymbols\(\)/);
  assert.match(block,/watchedEntrySymbols\(\)/);
  const sync=worker.slice(worker.indexOf('function syncMarkSubscriptions(){'),worker.indexOf('function scheduleMarkReconnect'));
  assert.match(sync,/const symbols=trackedMarkSymbols\(\)/);
});

test('detection phase explicitly cannot dispatch a real entry order',()=>{
  const start=worker.indexOf('function entryWatchMayDispatch(){');
  const end=worker.indexOf('async function processEntryWatchPrice',start);
  const block=worker.slice(start,end);
  assert.match(block,/return false/);
  assert.doesNotMatch(worker,/binance-entry-execute/);
  assert.doesNotMatch(worker,/EXEC_OPEN_POSITION/);
});

test('entry crossings are suppressed rather than deferred while dispatch is unavailable',()=>{
  const start=worker.indexOf('async function processEntryWatchPrice');
  const end=worker.indexOf('async function pruneAutoHighWater',start);
  const block=worker.slice(start,end);
  assert.match(block,/allowTrigger:entryWatchMayDispatch\(\)/);
  assert.match(block,/ENTRY_WATCH_CROSSING_SUPPRESSED/);
  assert.match(block,/REAL_ENTRY_DISPATCH_NOT_INSTALLED/);
});

test('aggTrade processing preserves protection priority then updates entry watch',()=>{
  const start=worker.indexOf('async function processAggTradeRow');
  const end=worker.indexOf('async function recoverMissedAggTrades',start);
  const block=worker.slice(start,end);
  const protect=block.indexOf('runAutoProtection(wanted,price)');
  const watch=block.indexOf('processEntryWatchPrice(wanted,price');
  assert.ok(protect>=0&&watch>protect);
  assert.match(block,/trackedMarkSymbols\(\)/);
});

test('recovery and REST fallback cover watched entries without inventing an order',()=>{
  const recover=worker.slice(worker.indexOf('async function recoverMissedAggTrades'),worker.indexOf('function sendMarkControl'));
  assert.match(recover,/trackedMarkSymbols\(\)/);
  assert.match(recover,/ENTRY_WATCH_RECOVERY_PARTIAL_/);
  assert.match(recover,/state\.armedAbove=false/);
  const fallback=worker.slice(worker.indexOf('async function fallbackMarkPrices'),worker.indexOf('async function ensureMarkPriceStream'));
  assert.match(fallback,/publicBinanceJson\('\/fapi\/v1\/ticker\/price'\)/);
  assert.match(fallback,/processEntryWatchPrice/);
});

test('entry watch state loads before mark subscriptions become active and persists on shutdown',()=>{
  const cycle=worker.slice(worker.indexOf('async function runtimeCycle(){'),worker.indexOf('async function closeRemoteUserStream'));
  assert.ok(cycle.indexOf('loadEntryWatchState()')>=0);
  assert.ok(cycle.indexOf('loadEntryWatchState()')<cycle.indexOf('ensureMarkPriceStream()'));
  const shutdown=worker.slice(worker.indexOf('async function shutdown'),worker.indexOf('async function main'));
  assert.match(shutdown,/persistEntryWatchStateNow\(\)/);
});
