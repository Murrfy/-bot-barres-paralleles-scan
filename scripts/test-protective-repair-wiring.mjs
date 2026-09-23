import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

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
