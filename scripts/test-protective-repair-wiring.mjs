import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const protectiveUpdate=await readFile(new URL('../api/binance-protective-update-execute.js',import.meta.url),'utf8');

test('controller submission and MASTER claim preserve exact repair while adding symbol-aware readiness',()=>{
  assert.match(sync,/protectiveRepairTarget\(type, req\.body\?\.payload\)/);
  assert.match(sync,/activeMaster, executionTarget, quarantineOperationAllowed, repairTarget/);
  assert.match(sync,/protectiveRepairTarget\(command\.type, command\.payload\)/);
  assert.match(sync,/device\.deviceId, executionTarget, quarantineOperationAllowed, repairTarget/);
  assert.match(sync,/maxLossLocalQuarantineReport\(report\)/);
  assert.match(sync,/SYMBOL_MAX_LOSS_QUARANTINED/);
});

test('quarantined symbol permits close or cancel but not a fresh protection edit',()=>{
  const start=sync.indexOf('function commandMayOperateQuarantinedSymbol');
  const end=sync.indexOf('\n}',start)+2;
  const block=sync.slice(start,end);
  assert.match(block,/EXEC_CLOSE_POSITION/);
  assert.match(block,/EXEC_CANCEL_ENTRY/);
  assert.doesNotMatch(block,/EXEC_UPDATE_PROTECTION/);
  assert.match(protectiveUpdate,/executionTarget,false/);
});

test('MASTER reconciliation keeps stream usable only for protection-only mismatch',()=>{
  assert.match(html,/protectionOnlyMismatchTarget\(q\.report\)/);
  assert.match(html,/q\.report\.failClosed===false\|\|Boolean\(repairTarget\)/);
  assert.match(html,/PROTECTION_REPAIR_REQUIRED/);
});
