import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('MAX-LOSS replacement confirms and publishes new stop before canceling old without interim full reconcile',()=>{
  assert.match(html,/async function placeNew\(\{deferReconcile=false\}=\{\}\)/);
  assert.match(html,/await publishMasterStreamState\(\);[\s\S]*if\(deferReconcile\)\{[\s\S]*return clientId;[\s\S]*\}[\s\S]*const reconciled=await awaitMasterReconciliation\(\)/);
  assert.match(html,/newClientId=await placeNew\(\{deferReconcile:maxLoss\}\);/);
  assert.match(html,/if\(!newClientId\)return false;[\s\S]*if\(!\(await cancelOld\(newClientId\)\)\)return false;/);
});

test('old MAX-LOSS cancellation still performs reconciliation after overlap is removed',()=>{
  const cancelStart=html.indexOf('async function cancelOld');
  const placeStart=html.indexOf('async function placeNew',cancelStart);
  assert.ok(cancelStart>=0&&placeStart>cancelStart);
  const cancelBlock=html.slice(cancelStart,placeStart);
  assert.match(cancelBlock,/waitForStreamOrder\(\{kind,clientId:previousId,terminal:true\}/);
  assert.match(cancelBlock,/const reconciled=await awaitMasterReconciliation\(\)/);
});
