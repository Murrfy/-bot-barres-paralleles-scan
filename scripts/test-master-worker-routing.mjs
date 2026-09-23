import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('MASTER worker routes close, cancel and protective updates separately',()=>{
  assert.match(html,/if\(dispatch\.type==='EXEC_CLOSE_POSITION'\)\{\s*ok=await runMasterFullClose/);
  assert.match(html,/else if\(dispatch\.type==='EXEC_CANCEL_ENTRY'\)\{\s*ok=await runMasterCancelEntry/);
  assert.match(html,/else if\(dispatch\.type==='EXEC_UPDATE_EXIT'\|\|dispatch\.type==='EXEC_UPDATE_PROTECTION'\)\{\s*ok=await runMasterProtectiveUpdate/);
  assert.doesNotMatch(html,/const ok=await runMasterFullClose\(command,raw\);/);
});

test('mutating cancel/update workers require stream confirmation before ACK',()=>{
  assert.match(html,/waitForStreamOrder\(\{kind:'STANDARD',clientId:clientOrderId,terminal:true\}/);
  assert.match(html,/waitForStreamOrder\(\{kind,clientId:previousId,terminal:true\}/);
  assert.match(html,/waitForStreamOrder\(\{kind,clientId,terminal:false\}/);
  assert.match(html,/reconcileMasterUserStream\(\)/);
});


test('place-first protection replacement publishes and reconciles new protection before retiring old',()=>{
  const fn=html.slice(html.indexOf('async function runMasterProtectiveUpdate'),html.indexOf('async function waitForFullCloseState'));
  const placeCall=fn.indexOf("newClientId=await placeNew()");
  const cancelCall=fn.indexOf("await cancelOld(newClientId)");
  assert.ok(placeCall>=0&&cancelCall>placeCall);
  const placeFn=fn.slice(fn.indexOf('async function placeNew()'),fn.indexOf("let newClientId=''"));
  assert.match(placeFn,/waitForStreamOrder\(\{kind,clientId,terminal:false\}/);
  assert.match(placeFn,/await publishMasterStreamState\(\);\s*const reconciled=await awaitMasterReconciliation\(\)/);
});

test('automatic progressive replacement also reconciles the new order before cancel-old',()=>{
  const start=html.indexOf('async function executeMasterAutoProgressive');
  const end=html.indexOf('async function runMasterAutoProtection',start);
  const fn=html.slice(start,end);
  const place=fn.indexOf("phase:'PLACE_NEW'");
  const publish=fn.indexOf('await publishMasterStreamState()');
  const reconcile=fn.indexOf('await awaitMasterReconciliation()');
  const cancel=fn.indexOf("phase:'CANCEL_OLD'");
  assert.ok(place>=0&&publish>place&&reconcile>publish&&cancel>reconcile);
});


test('critical MASTER execution waits for any in-flight reconciliation instead of treating busy as failure',()=>{
  assert.match(html,/async function awaitMasterReconciliation\(timeoutMs=5000\)/);
  assert.match(html,/while\(masterUserStream\.reconcileBusy&&Date\.now\(\)<deadline\)/);
  assert.match(html,/RECONCILIATION_BUSY_TIMEOUT/);
  const start=html.indexOf('async function safeAckAfterReconcile');
  const end=html.indexOf('async function masterExecutionCycle',start);
  const critical=html.slice(start,end);
  assert.doesNotMatch(critical,/await reconcileMasterUserStream\(\)/);
  assert.match(critical,/await awaitMasterReconciliation\(\)/);
});

test('full-close ACK requires successful reconciled stream readiness',()=>{
  const start=html.indexOf('async function safeAckFullClose');
  const end=html.indexOf('async function runMasterFullClose',start);
  const fn=html.slice(start,end);
  assert.match(fn,/const reconciled=await awaitMasterReconciliation\(\)/);
  assert.match(fn,/reconciled!==true\|\|masterRuntimeState\.userStreamReady!==true/);
  assert.match(fn,/throw new Error\('RECONCILIATION_NOT_READY'\)/);
  assert.ok(fn.indexOf('RECONCILIATION_NOT_READY')<fn.indexOf('await ackMasterCommand'));
});
