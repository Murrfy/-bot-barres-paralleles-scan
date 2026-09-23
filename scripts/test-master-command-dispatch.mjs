import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMasterCommandDispatch, masterCommandRetryDelay } from '../lib/master-command-dispatch.mjs';

test('close-position command maps to protective execution endpoint',()=>{
  const d=buildMasterCommandDispatch({
    id:'cmd-12345678',
    type:'EXEC_CLOSE_POSITION',
    payload:{symbol:'btcusdt',direction:'long',quantity:'0.02',exitMode:'PROTECTIVE_IOC'}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'/api/binance-protective-execute');
  assert.equal(d.body.symbol,'BTCUSDT');
  assert.equal(d.body.direction,'LONG');
  assert.equal(d.body.quantity,0.02);
  assert.equal(d.body.commandId,'cmd-12345678');
});

test('normal exact exit requires a positive target price',()=>{
  assert.equal(buildMasterCommandDispatch({
    id:'cmd-12345678',type:'EXEC_CLOSE_POSITION',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'NORMAL_LIMIT'}
  }).reason,'TARGET_PRICE_REQUIRED');
  const d=buildMasterCommandDispatch({
    id:'cmd-12345678',type:'EXEC_CLOSE_POSITION',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'NORMAL_LIMIT',targetPrice:51000}
  });
  assert.equal(d.supported,true);
  assert.equal(d.body.targetPrice,51000);
});

test('unimplemented EXEC types fail closed rather than dispatching',()=>{
  for(const type of ['EXEC_OPEN_POSITION','EXEC_UPDATE_EXIT','EXEC_UPDATE_PROTECTION','EXEC_CANCEL_ENTRY']){
    const d=buildMasterCommandDispatch({id:'cmd-12345678',type,payload:{}});
    assert.equal(d.supported,false);
    assert.equal(d.reason,'COMMAND_TYPE_NOT_IMPLEMENTED');
  }
});

test('invalid quantity, direction and symbol fail closed',()=>{
  assert.equal(buildMasterCommandDispatch({id:'cmd-12345678',type:'EXEC_CLOSE_POSITION',payload:{symbol:'!',direction:'LONG',quantity:1}}).supported,false);
  assert.equal(buildMasterCommandDispatch({id:'cmd-12345678',type:'EXEC_CLOSE_POSITION',payload:{symbol:'BTCUSDT',direction:'BOTH',quantity:1}}).supported,false);
  assert.equal(buildMasterCommandDispatch({id:'cmd-12345678',type:'EXEC_CLOSE_POSITION',payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0}}).supported,false);
});

test('worker retry delay is bounded',()=>{
  assert.equal(masterCommandRetryDelay(undefined),900);
  assert.equal(masterCommandRetryDelay(10),250);
  assert.equal(masterCommandRetryDelay(9000),5000);
  assert.equal(masterCommandRetryDelay(1500),1500);
});
