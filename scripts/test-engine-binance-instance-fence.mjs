import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  enginePrincipalInstanceActive,
  validEngineInstanceId,
} from '../lib/device-session.mjs';

const protectedApis=[
  'api/binance-user-stream-session.js',
  'api/binance-runtime-snapshot.js',
  'api/binance-reconcile.js',
  'api/binance-entry-preflight.js',
  'api/binance-entry-execute.js',
  'api/binance-protective-execute.js',
  'api/binance-protective-update-execute.js',
  'api/binance-order-test.js',
];

test('engine instance helper accepts ordinary paired devices without adding a new requirement',()=>{
  assert.equal(enginePrincipalInstanceActive({principal:'device'},'', ''),true);
  assert.equal(enginePrincipalInstanceActive({role:'master'},'', ''),true);
});

test('engine instance helper requires exact session/header/current-instance agreement',()=>{
  const instance='engine-instance-1234567890abcdef';
  assert.equal(validEngineInstanceId(instance),true);
  const engine={principal:'engine',engineInstanceId:instance};
  assert.equal(enginePrincipalInstanceActive(engine,instance,instance),true);
  assert.equal(enginePrincipalInstanceActive(engine,'',instance),false);
  assert.equal(enginePrincipalInstanceActive(engine,instance,''),false);
  assert.equal(enginePrincipalInstanceActive(engine,'engine-instance-aaaaaaaaaaaaaaaa',instance),false);
  assert.equal(enginePrincipalInstanceActive(engine,instance,'engine-instance-bbbbbbbbbbbbbbbb'),false);
});

test('every separate Binance MASTER API enforces current engine-instance fencing',()=>{
  for(const file of protectedApis){
    const source=fs.readFileSync(file,'utf8');
    assert.ok(source.includes('engineInstanceHeader'),file+' must read the engine instance header');
    assert.ok(source.includes('enginePrincipalInstanceActive'),file+' must validate the engine session instance');
    assert.ok(source.includes("`${PREFIX}:engine-instance`"),file+' must compare against the current Redis engine instance');
    assert.ok(source.includes("'ENGINE_INSTANCE_FENCED'"),file+' must fail closed for a stale engine process');
  }
});

test('engine instance fencing occurs before the MASTER lease is accepted',()=>{
  for(const file of protectedApis){
    const source=fs.readFileSync(file,'utf8');
    const start=source.indexOf('async function requireCurrentMaster');
    assert.ok(start>=0,file+' missing requireCurrentMaster');
    const end=source.indexOf('\n}',start);
    const block=source.slice(start,end+2);
    const fence=block.indexOf('enginePrincipalInstanceActive');
    const leaseFailure=block.indexOf('MASTER_LEASE_REQUIRED');
    assert.ok(fence>=0&&leaseFailure>fence,file+' must fence engine instance before accepting the MASTER lease');
  }
});
