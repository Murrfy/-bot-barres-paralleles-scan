import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMasterCommandDispatch, masterExecutionEligible } from '../lib/master-command-dispatch.mjs';

test('MASTER execution pump is eligible only for armed live MASTER state',()=>{
  const base={role:'master',hidden:false,leaseActive:true,realExecutionArmed:true,synchronized:true,heartbeatFresh:true,userStreamReady:true,mode:'RUNNING'};
  assert.equal(masterExecutionEligible(base),true);
  assert.equal(masterExecutionEligible({...base,mode:'PAUSE_PENDING'}),true);
  for(const change of [
    {role:'controller'},{hidden:true},{leaseActive:false},{realExecutionArmed:false},{synchronized:false},{heartbeatFresh:false},{userStreamReady:false},{mode:'PAUSED'}
  ]) assert.equal(masterExecutionEligible({...base,...change}),false);
});

test('close command maps only to protective execution endpoint',()=>{
  const d=buildMasterCommandDispatch({
    id:'command-12345678',
    type:'EXEC_CLOSE_POSITION',
    payload:{symbol:'btcusdt',direction:'LONG',quantity:'0.02',exitMode:'PROTECTIVE_IOC'}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'/api/binance-protective-execute');
  assert.equal(d.body.symbol,'BTCUSDT');
  assert.equal(d.body.direction,'LONG');
  assert.equal(d.body.quantity,0.02);
  assert.equal(d.body.exitMode,'PROTECTIVE_IOC');
});

test('exact normal close requires explicit target price',()=>{
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-12345678',type:'EXEC_CLOSE_POSITION',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'NORMAL_LIMIT'}
  }),/TARGET_PRICE_REQUIRED/);
});

test('entry and not-yet-implemented protective mutations are never dispatched as writes',()=>{
  for(const type of ['EXEC_OPEN_POSITION','EXEC_UPDATE_EXIT','EXEC_UPDATE_PROTECTION','EXEC_CANCEL_ENTRY']){
    const d=buildMasterCommandDispatch({id:'command-12345678',type,payload:{}});
    assert.equal(d.supported,false,type);
  }
});
