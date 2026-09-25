import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');
const entryApi=await readFile(new URL('../api/binance-entry-execute.js',import.meta.url),'utf8');

test('24/7 engine reads watched entries and per-token amount/leverage/max-loss',()=>{
  assert.match(worker,/runtime\.config\?\.validated/);
  assert.match(worker,/token\.margin/);
  assert.match(worker,/token\.leverage/);
  assert.match(worker,/token\.maxLoss/);
  assert.match(worker,/globalSettings\.margin/);
  assert.match(worker,/globalSettings\.leverage/);
  assert.match(worker,/globalSettings\.maxLoss/);
});

test('real watched entry prepares MAX-LOSS before submitting LIMIT entry',()=>{
  const prepare=worker.indexOf("phase:'PREPARE_PROTECTION'");
  const wait=worker.indexOf("waitForStreamOrder({kind:'ALGO'",prepare);
  const publish=worker.indexOf('await publishRuntime()',wait);
  const submit=worker.indexOf("phase:'SUBMIT_ENTRY'",publish);
  assert.ok(prepare>=0&&wait>prepare&&publish>wait&&submit>publish);
});

test('stale recovered price crossings cannot restart the 50 second entry window',()=>{
  assert.match(worker,/state\.expiresAt=eventAt\+50000/);
  assert.match(worker,/if\(now>=state\.expiresAt\)[\s\S]*ENTRY_TRIGGER_EXPIRED/);
  assert.match(worker,/runWatchedEntry\(wanted,price,eventTime\)/);
});

test('REST fallback follows watched entries when market websocket is down',()=>{
  assert.match(worker,/const watchedSymbols=watchedEntrySymbols\(\)/);
  assert.match(worker,/publicBinanceJson\('\/fapi\/v1\/ticker\/price'\)/);
  assert.match(worker,/watchedSymbols\.has\(symbol\)&&mark>0\)tasks\.push\(runWatchedEntry/);
});

test('entry API validates amount/leverage bracket before Binance symbol mutation',()=>{
  const bracketRead=entryApi.indexOf("path:'/fapi/v1/leverageBracket'");
  const plan=entryApi.indexOf('planEntrySymbolConfiguration({',bracketRead);
  const marginTypeWrite=entryApi.indexOf("path:'/fapi/v1/marginType'",plan);
  const leverageWrite=entryApi.indexOf("path:'/fapi/v1/leverage'",plan);
  assert.ok(bracketRead>=0&&plan>bracketRead&&marginTypeWrite>plan&&leverageWrite>plan);
  assert.match(entryApi,/desiredMargin:margin/);
  assert.match(entryApi,/desiredLeverage:leverage/);
});

test('phased real entry can only be driven by the 24/7 engine principal',()=>{
  assert.match(entryApi,/phaseProvided&&String\(master\?\.principal\|\|''\)!=='engine'/);
  assert.match(entryApi,/code:'ENTRY_ENGINE_REQUIRED'/);
});
