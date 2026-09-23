import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { jsonStructureStatus, plainJsonObject } from '../lib/json-structure.mjs';

test('normal Zenith JSON structures remain accepted',()=>{
  const value={
    settings:{margin:1000,protectionStages:[{enabled:true,arm:30,floor:20}]},
    tokenSettings:{BTCUSDT:{leverage:10}},
    manualTokens:{},
    validated:{BTCUSDT:{validated:true}}
  };
  const status=jsonStructureStatus(value,{maxDepth:16,maxNodes:20000,maxArrayLength:2000,maxObjectKeys:2000});
  assert.equal(status.ok,true);
  assert.equal(plainJsonObject(value),true);
});

test('top-level state blocks must be plain JSON objects',()=>{
  assert.equal(plainJsonObject([]),false);
  assert.equal(plainJsonObject(new Date()),false);
  assert.equal(plainJsonObject(Object.create(null)),true);
});

test('dangerous prototype keys are rejected at any depth',()=>{
  const value=JSON.parse('{"settings":{"nested":{"__proto__":{"polluted":true}}}}');
  const status=jsonStructureStatus(value);
  assert.equal(status.ok,false);
  assert.equal(status.reason,'JSON_DANGEROUS_KEY');
});

test('pathological depth is rejected before recursive hashing',()=>{
  const value={};
  let cursor=value;
  for(let i=0;i<20;i+=1){cursor.next={};cursor=cursor.next}
  const status=jsonStructureStatus(value,{maxDepth:16});
  assert.equal(status.ok,false);
  assert.equal(status.reason,'JSON_DEPTH_EXCEEDED');
});

test('node, array and object-key ceilings are enforced',()=>{
  assert.equal(jsonStructureStatus({rows:[1,2,3]},{maxNodes:3}).reason,'JSON_NODE_LIMIT_EXCEEDED');
  assert.equal(jsonStructureStatus({rows:[1,2,3]},{maxArrayLength:2}).reason,'JSON_ARRAY_LIMIT_EXCEEDED');
  assert.equal(jsonStructureStatus({a:1,b:2,c:3},{maxObjectKeys:2}).reason,'JSON_OBJECT_KEY_LIMIT_EXCEEDED');
});

test('controller and MASTER runtime state validate structure before hash or storage',()=>{
  const sync=fs.readFileSync('api/zenith-sync.js','utf8');
  assert.ok(sync.includes("import { jsonStructureStatus, plainJsonObject } from '../lib/json-structure.mjs'"));

  const controllerStart=sync.indexOf("if (action === 'controller-state' && req.method === 'POST')");
  const controllerEnd=sync.indexOf("if (action === 'state' && req.method === 'GET')",controllerStart);
  assert.ok(controllerStart>=0&&controllerEnd>controllerStart);
  const controller=sync.slice(controllerStart,controllerEnd);
  assert.ok(controller.includes('plainJsonObject(data)'));
  assert.ok(controller.includes("'CONTROLLER_STATE_BLOCK_INVALID'"));
  assert.ok(controller.includes('jsonStructureStatus(safeData'));
  assert.ok(controller.includes("'CONTROLLER_STATE_STRUCTURE_INVALID'"));
  assert.ok(controller.indexOf('jsonStructureStatus(safeData') < controller.indexOf('const stateHash = sha256'));

  const runtimeStart=sync.indexOf("if (action === 'state' && req.method === 'POST')");
  const runtimeEnd=sync.indexOf("if (action === 'command' && req.method === 'POST')",runtimeStart);
  assert.ok(runtimeStart>=0&&runtimeEnd>runtimeStart);
  const runtime=sync.slice(runtimeStart,runtimeEnd);
  assert.ok(runtime.includes('plainJsonObject(data)'));
  assert.ok(runtime.includes('jsonStructureStatus(data'));
  assert.ok(runtime.includes("'RUNTIME_STATE_STRUCTURE_INVALID'"));
  assert.ok(runtime.indexOf('jsonStructureStatus(data') < runtime.indexOf('const snapshot = {'));
});
