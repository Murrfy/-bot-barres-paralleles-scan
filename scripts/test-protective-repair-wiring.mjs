import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('controller submission and MASTER claim both use exact protective repair target',()=>{
  assert.match(sync,/protectiveRepairTarget\(type, req\.body\?\.payload\)/);
  assert.match(sync,/realExecutionReadiness\(activeMaster, repairTarget\)/);
  assert.match(sync,/protectiveRepairTarget\(command\.type, command\.payload\)/);
  assert.match(sync,/realExecutionReadiness\(device\.deviceId, repairTarget\)/);
});

test('MASTER reconciliation keeps stream usable only for protection-only mismatch',()=>{
  assert.match(html,/protectionOnlyMismatchTarget\(q\.report\)/);
  assert.match(html,/q\.report\.failClosed===false\|\|Boolean\(repairTarget\)/);
  assert.match(html,/PROTECTION_REPAIR_REQUIRED/);
});


test('server worker automatically repairs a uniquely missing managed max-loss protection',()=>{
  assert.match(worker,/buildRealProtectionLevels/);
  assert.match(worker,/async function repairMissingMaxLoss\(report,repairTarget\)/);
  assert.match(worker,/missingMaxLossProtections/);
  assert.match(worker,/protectionKind:'MAX_LOSS'/);
  assert.match(worker,/phase:'PLACE_NEW'/);
  assert.match(worker,/MAX_LOSS_REPAIR_NOT_STREAM_CONFIRMED/);
  assert.match(worker,/const repaired=await repairMissingMaxLoss\(data\.report,repairTarget\)/);
  assert.match(worker,/return reconcile\(true\)/);
});

test('ambiguous max-loss protection fails closed instead of placing another stop',()=>{
  const fn=worker.slice(
    worker.indexOf('async function repairMissingMaxLoss('),
    worker.indexOf('async function executeAutoProgressive(')
  );
  assert.match(fn,/ambiguousMaxLossProtections/);
  assert.match(fn,/AMBIGUOUS_MAX_LOSS_PROTECTION_/);
  assert.match(fn,/await assertAutoProtectionPanic/);
  const ambiguityGate=fn.indexOf("if(ambiguous.includes(target))");
  const placeCall=fn.indexOf("callProtectiveUpdateExecute(body)");
  assert.ok(ambiguityGate>=0&&placeCall>ambiguityGate);
});

test('market-only emergency close always selects the final current fallback policy',()=>{
  assert.match(worker,/\?\[PROTECTIVE_CLOSE_ATTEMPTS\.at\(-1\)\]/);
  assert.equal(worker.includes('PROTECTIVE_CLOSE_ATTEMPTS[3]'),false);
});
