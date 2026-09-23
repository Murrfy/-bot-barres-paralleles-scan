import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');

test('iPad MASTER validates its local config against the last applied hash before continuing protections',()=>{
  assert.match(html,/const appliedState=st\.q\.appliedState\|\|null/);
  assert.match(html,/localAppliedConfigMatches=Boolean\(appliedStateHash\)&&localHash===appliedStateHash/);
  assert.match(html,/st\.q\.protectiveDeferredSafe===true/);
  assert.match(html,/st\.q\.applyDeferred===true/);
});

test('automatic protection may continue on applied config while new entries remain blocked',()=>{
  assert.match(html,/masterRuntimeState\.synchronized\|\|masterRuntimeState\.configDeferredSafe/);
  assert.match(html,/masterRuntimeState\.synchronized===true&&masterRuntimeState\.configDeferredSafe!==true/);
  assert.match(html,/nouvelle configuration en attente/);
});

test('server allows only protective EXEC commands through safe deferred configuration',()=>{
  assert.match(sync,/function commandAllowedDuringDeferredConfig\(type, status\)/);
  assert.match(sync,/status\?\.protectiveDeferredSafe === true/);
  for(const type of ['EXEC_UPDATE_EXIT','EXEC_UPDATE_PROTECTION','EXEC_CLOSE_POSITION','EXEC_CANCEL_ENTRY']){
    assert.ok(sync.includes(`'${type}'`),type);
  }
  assert.doesNotMatch(sync,/PROTECTIVE_EXEC_COMMANDS[^;]*EXEC_OPEN_POSITION/s);
});

test('UI explicitly reports that MASTER protections remain active while config waits',()=>{
  assert.match(html,/IPAD MASTER · CONFIG EN ATTENTE · PROTECTIONS ACTIVES/);
  assert.match(html,/MASTER EN MARCHE · CONFIG EN ATTENTE/);
});
