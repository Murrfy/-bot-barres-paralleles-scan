import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

test('terminal command results persist ACK/FAIL records for the originating controller',()=>{
  assert.match(sync,/function commandTerminalResultKey\(commandId\)/);
  assert.match(sync,/status: 'ACK'/);
  assert.match(sync,/writeCommandTerminalResult\([\s\S]*'FAIL'/);
  const writer=sync.slice(sync.indexOf('async function writeCommandTerminalResult'),sync.indexOf('async function pushDeadLetter'));
  assert.match(writer,/const commandId = String\(command\?\.id \|\| ''\)/);
  assert.match(writer,/commandId,/);
  assert.doesNotMatch(writer,/normalizedCommandId/);
  assert.match(sync,/deviceId: String\(command\?\.deviceId \|\| ''\)/);
  assert.match(sync,/String\(COMMAND_DEDUPE_TTL_SECONDS\)/);
});

test('controller command-status endpoint is controller-authenticated and privacy fenced',()=>{
  const start=sync.indexOf("if (action === 'command-status' && req.method === 'GET')");
  const end=sync.indexOf("if (action === 'command' && req.method === 'POST')",start);
  assert.ok(start>=0&&end>start,'command-status endpoint missing');
  const block=sync.slice(start,end);
  assert.match(block,/requireDevice\(req, res, \['controller'\]\)/);
  assert.match(block,/commandTerminalResultKey\(commandId\)/);
  assert.match(block,/clientCommandId/);
  assert.match(block,/command:client:/);
  assert.match(block,/status:'NOT_FOUND'/);
  assert.match(block,/String\(result\.deviceId \|\| ''\) !== String\(device\.deviceId \|\| ''\)/);
  assert.match(block,/COMMAND_RESULT_NOT_FOUND/);
  assert.match(block,/status:'PENDING'/);
  assert.match(block,/\['ACK','FAIL'\]\.includes\(status\)/);
});

test('ACK completion stores structured terminal result atomically with processing removal',()=>{
  const start=sync.indexOf('async function completeProcessingCommandAtomic');
  const end=sync.indexOf('function masterAuthorityMutationCode',start);
  assert.ok(start>=0&&end>start,'completion helper missing');
  const block=sync.slice(start,end);
  assert.match(block,/doneValue = JSON\.stringify/);
  assert.match(block,/redis\.call\('LREM', KEYS\[1\], 1, ARGV\[1\]\)/);
  assert.match(block,/redis\.call\('SET', KEYS\[5\], ARGV\[5\], 'EX', ARGV\[6\]\)/);
});


test('terminal status carries committed active config proof back to the iPhone',()=>{
  const start=sync.indexOf("if (action === 'command-status' && req.method === 'GET')");
  const end=sync.indexOf("if (action === 'command' && req.method === 'POST')",start);
  const status=sync.slice(start,end);
  assert.match(status,/activeConfigCommitted:result\.activeConfigCommitted===true/);
  assert.match(status,/activeConfigKind:String\(result\.activeConfigKind \|\| ''\)/);
  assert.match(status,/activeConfig:result\.activeConfig/);

  const complete=sync.slice(sync.indexOf('async function completeProcessingCommandAtomic'),sync.indexOf('function masterAuthorityMutationCode'));
  assert.match(complete,/activeConfigCommitted:true/);
  assert.match(complete,/controllerRevision:controllerCommit\.nextRevision/);
  assert.match(complete,/controllerStateHash:controllerCommit\.nextStateHash/);
});
