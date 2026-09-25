import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const watch=fs.readFileSync('lib/entry-watch.mjs','utf8');

test('slot-delayed entry uses current observed price instead of original requested buy',()=>{
  assert.match(watch,/if\(next\.pendingUntil>0\)[\s\S]*if\(allowTrigger===true\)[\s\S]*limitPrice:px[\s\S]*delayedCurrentPrice:true/);
  assert.match(worker,/executeWatchedEntry\(config,\{[\s\S]*limitPrice:n\(result\.signal\?\.limitPrice,config\.buy\)/);
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
  assert.doesNotMatch(block,/authorizationAt/);
  assert.doesNotMatch(block,/engineInstanceId/);
});

test('token list shows server-confirmed not-started state and keeps it out of watched KPI',()=>{
  assert.match(html,/function realEntryDidNotStart\(s\)/);
  assert.match(html,/return 'N’A PAS DÉMARRÉ'/);
  assert.match(html,/Object\.keys\(validated\)\.filter\(s=>!openBySymbol\(s\)&&!revalidateBlock\[s\]&&!realEntryDidNotStart\(s\)\)/);
  assert.match(html,/watched=!!validated\[selectedSymbol\]&&!realEntryDidNotStart\(selectedSymbol\)&&!active/);
  assert.match(html,/setInterval\(refreshServerEntryWatch,3000\)/);
});

test('expired slot window never sends an order and remains a terminal blocked watch state',()=>{
  assert.match(watch,/if\(at>=next\.pendingUntil\)[\s\S]*next\.blockedAt=at;[\s\S]*return \{action:'EXPIRED'/);
  assert.match(html,/N’A PAS DÉMARRÉ — aucune place libérée pendant les 50 secondes/);
});
