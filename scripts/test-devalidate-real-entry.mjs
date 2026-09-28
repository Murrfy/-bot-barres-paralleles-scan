import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');

test('devalidation stops central watch before dispatch and waits for ACK before completion',()=>{
  const start=html.indexOf('async function devalidateSelected()');
  const end=html.indexOf('function tokenDefaults()',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);

  const removeWatch=block.indexOf('delete validated[s]');
  const syncCentral=block.indexOf('await syncControllerCloudStateNow()',removeWatch);
  const buildCancel=block.indexOf('buildControllerDevalidateEntryCommand',syncCentral);
  const submit=block.indexOf("fetch('/api/zenith-sync?action=command'",buildCancel);
  const waitAck=block.indexOf('await waitControllerCommandTerminal',submit);
  const verifyBinance=block.indexOf('await refreshBinanceAccount()',waitAck);
  const removeList=block.indexOf('delete manualTokens[s]',verifyBinance);
  const done=block.indexOf('achat surveillé annulé et confirmé',removeList);

  assert.ok(removeWatch>=0);
  assert.ok(syncCentral>removeWatch);
  assert.ok(buildCancel>syncCentral);
  assert.ok(submit>buildCancel);
  assert.ok(waitAck>submit);
  assert.ok(verifyBinance>waitAck);
  assert.ok(removeList>verifyBinance);
  assert.ok(done>removeList);
  assert.match(block,/if\(!centralWatchStopped\)/);
  assert.match(block,/ENTRY_STILL_OPEN_AFTER_ACK/);
});

test('devalidation command can cover prepared transition with no visible Binance order',()=>{
  assert.match(html,/buildControllerDevalidateEntryCommand\(s,observedOrder,Date\.now\(\)\)/);
  const helperStart=html.indexOf('function managedRealEntryForSymbol');
  const helperEnd=html.indexOf('async function waitControllerCommandTerminal',helperStart);
  const helper=html.slice(helperStart,helperEnd);
  assert.match(helper,/zth-ENT-/);
  assert.match(helper,/PLUSIEURS_ENTREES_ZENITH/);
});
