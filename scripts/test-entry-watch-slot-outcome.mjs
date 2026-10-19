import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const watch=fs.readFileSync('lib/entry-watch.mjs','utf8');

test('delayed current-price entry no longer exists: full slots never buy later',()=>{
  assert.doesNotMatch(watch,/delayedCurrentPrice:true/);
  assert.doesNotMatch(watch,/50000/);
  assert.doesNotMatch(watch,/entryWatchSlotRaceOutcome/);
  assert.doesNotMatch(worker,/currentBestAsk/);
  assert.doesNotMatch(worker,/delayedCurrentPrice/);
  assert.doesNotMatch(worker,/entryWatchSlotRaceOutcome/);
  assert.match(worker,/limitPrice:effectiveLimitPrice/);
  assert.match(worker,/requestedBuyPrice:config\.buy/);
});
test('normal crossing still uses original requested LIMIT price',()=>{
  assert.match(watch,/if\(next\.armedAbove===true\)[\s\S]*limitPrice:definition\.buy[\s\S]*delayedCurrentPrice:false/);
});

test('controller can read only sanitized server entry-watch outcome',()=>{
  const start=sync.indexOf("if (action === 'entry-watch-status'");
  const end=sync.indexOf("if (action === 'engine-entry-watch-state'",start);
  assert.ok(start>=0&&end>start);
  const block=sync.slice(start,end);
  assert.match(block,/requireDevice\(req, res, \['controller','master'\]\)/);
  assert.match(block,/KEY_ENGINE_ENTRY_WATCH_STATE/);
  assert.match(block,/status = blockedAt > 0/);
  assert.match(block,/'NOT_STARTED'/);
  assert.match(block,/'WAITING_SLOT'/);
  assert.match(block,/KEY_ENGINE_AUTHORIZED/);
  assert.match(block,/Number\(stored\?\.authorizationAt \|\| 0\) === authorizationAt/);
  assert.match(block,/const source = sameScope \? stored\.states : \{\}/);
  assert.match(block,/staleScope:Boolean\(stored && !sameScope\)/);
  const responseStart=block.indexOf('return send(res, 200');
  assert.ok(responseStart>=0);
  const response=block.slice(responseStart);
  assert.doesNotMatch(response,/authorizationAt/);
  assert.doesNotMatch(response,/engineInstanceId/);
});

test('token list shows server-confirmed not-started state and keeps it out of watched KPI',()=>{
  assert.match(html,/function realEntryDidNotStart\(s\)/);
  assert.match(html,/'STAND-BY'/);
  assert.match(html,/Object\.keys\(validated\)\.filter\(s=>!openBySymbol\(s\)&&!revalidateBlock\[s\]&&!realEntryDidNotStart\(s\)\)/);
  assert.match(html,/watched=!!validated\[selectedSymbol\]&&!realEntryDidNotStart\(selectedSymbol\)&&!active/);
  assert.match(html,/setInterval\(refreshServerEntryWatch,3000\)/);
});

test('full slots send no order and leave a terminal blocked STAND-BY watch state',()=>{
  assert.match(watch,/next\.pendingUntil=0;\s*next\.blockedAt=at;\s*return \{action:'STANDBY'/);
  const start=worker.indexOf("if(result.action==='STANDBY')");
  const end=worker.indexOf("if(result.action!=='TRIGGER')",start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.match(block,/ENTRY_STANDBY_NO_SLOT/);
  assert.match(block,/await persistEntryWatchStateNow\(\)/);
  assert.doesNotMatch(block,/executeWatchedEntry|callEntryExecute/);
  assert.doesNotMatch(html,/50 secondes/);
  assert.doesNotMatch(html,/ATTENTE PLACE|ATTENTE PRIX|N’A PAS DÉMARRÉ/);
  assert.match(html,/\.selectionTable td\.missedStatus\{font-size:13px/);
});
