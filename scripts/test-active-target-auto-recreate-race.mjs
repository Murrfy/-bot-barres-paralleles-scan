import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

function block(startText,endText){
  const start=worker.indexOf(startText);
  const end=worker.indexOf(endText,start+startText.length);
  assert.ok(start>=0,`missing start: ${startText}`);
  assert.ok(end>start,`missing end: ${endText}`);
  return worker.slice(start,end);
}

test('automatic target is suppressed only for a symbol whose target replacement is in flight',()=>{
  assert.match(worker,/const autoTarget=\{[\s\S]*suppressedSymbols:new Set\(\)/);
  const ensure=block('async function ensureAutomaticTargetForPosition','async function ensureAutomaticTargets');
  assert.match(ensure,/autoTarget\.suppressedSymbols\.has\(symbol\)/);
  assert.match(ensure,/TARGET_UPDATE_IN_PROGRESS/);
});

test('active target replacement suppresses recreation before cancel and restores automation in finally',()=>{
  const run=block('async function runProtectiveUpdate','async function waitForFullCloseState');
  const suppress=run.indexOf('autoTarget.suppressedSymbols.add(suppressedTargetSymbol)');
  const cancel=run.indexOf('if(!(await cancelOld()))return false;',suppress);
  const place=run.indexOf('newClientId=await placeNew();',cancel);
  const unsuppress=run.indexOf('autoTarget.suppressedSymbols.delete(suppressedTargetSymbol)',place);
  const reconcile=run.indexOf('scheduleReconcile(100)',unsuppress);
  assert.ok(suppress>=0&&cancel>suppress&&place>cancel&&unsuppress>place&&reconcile>unsuppress);
  assert.match(run,/const suppressedTargetSymbol=type==='EXEC_UPDATE_EXIT'&&previousId/);
  assert.match(run,/try\{/);
  assert.match(run,/\}finally\{/);
});

test('MAX-LOSS and progressive replacement paths are not suppressed by the target-only fence',()=>{
  const run=block('async function runProtectiveUpdate','async function waitForFullCloseState');
  assert.match(run,/const suppressedTargetSymbol=type==='EXEC_UPDATE_EXIT'&&previousId/);
  assert.match(run,/if\(maxLoss\|\|progressive\)/);
  assert.match(run,/placeNew\(\{deferReconcile:maxLoss\}\)/);
});
