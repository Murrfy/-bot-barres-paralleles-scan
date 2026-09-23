import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMasterCommandDispatch, masterExecutionEligible } from '../lib/master-command-dispatch.mjs';

test('MASTER execution pump is eligible only for armed live MASTER state',()=>{
  const base={role:'master',hidden:false,leaseActive:true,realExecutionArmed:true,userStreamReady:true,mode:'RUNNING'};
  assert.equal(masterExecutionEligible(base),true);
  assert.equal(masterExecutionEligible({...base,mode:'PAUSE_PENDING'}),true);
  for(const change of [
    {role:'controller'},{hidden:true},{leaseActive:false},{realExecutionArmed:false},{userStreamReady:false},{mode:'PAUSED'}
  ]) assert.equal(masterExecutionEligible({...base,...change}),false);
});

test('close command maps only to protective execution endpoint',()=>{
  const d=buildMasterCommandDispatch({
    id:'command-12345678',
    type:'EXEC_CLOSE_POSITION',
    payload:{symbol:'btcusdt',direction:'LONG',quantity:'0.02',closeAll:true,exitMode:'PROTECTIVE_IOC'}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'/api/binance-protective-execute');
  assert.equal(d.body.symbol,'BTCUSDT');
  assert.equal(d.body.direction,'LONG');
  assert.equal(d.body.quantity,0.02);
  assert.equal(d.body.exitMode,'PROTECTIVE_IOC');
});

test('EXEC_CLOSE_POSITION is full-close only and does not accept normal target orders',()=>{
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-12345678',type:'EXEC_CLOSE_POSITION',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'PROTECTIVE_IOC'}
  }),/CLOSE_ALL_REQUIRED/);
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-12345678',type:'EXEC_CLOSE_POSITION',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,closeAll:true,exitMode:'NORMAL_LIMIT',targetPrice:51000}
  }),/EXIT_MODE_INVALID/);
});

test('real LIMIT entry maps to the dedicated fail-closed entry endpoint',()=>{
  const d=buildMasterCommandDispatch({
    id:'command-open-1234',
    type:'EXEC_OPEN_POSITION',
    payload:{symbol:'btcusdt',side:'BUY',orderType:'LIMIT',limitPrice:50000,margin:100,leverage:10,maxLoss:40}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'/api/binance-entry-execute');
  assert.equal(d.body.symbol,'BTCUSDT');
  assert.equal(d.body.side,'BUY');
  assert.equal(d.body.orderType,'LIMIT');
  assert.equal(d.body.limitPrice,50000);
});

test('real entry dispatcher rejects market entry and malformed risk fields',()=>{
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-open-1234',type:'EXEC_OPEN_POSITION',
    payload:{symbol:'BTCUSDT',side:'BUY',orderType:'MARKET',limitPrice:50000,margin:100,leverage:10,maxLoss:40}
  }),/REAL_ENTRY_LIMIT_ONLY/);
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-open-1234',type:'EXEC_OPEN_POSITION',
    payload:{symbol:'BTCUSDT',side:'BUY',orderType:'LIMIT',limitPrice:50000,margin:0,leverage:10,maxLoss:40}
  }),/MARGIN_INVALID/);
});

test('not-yet-implemented protective mutations are never dispatched as writes',()=>{
  for(const type of ['EXEC_UPDATE_EXIT','EXEC_UPDATE_PROTECTION']){
    const d=buildMasterCommandDispatch({id:'command-12345678',type,payload:{}});
    assert.equal(d.supported,false,type);
  }
});


test('entry cancellation maps to protective endpoint without position-close fields',()=>{
  const d=buildMasterCommandDispatch({
    id:'command-cancel-1234',
    type:'EXEC_CANCEL_ENTRY',
    payload:{symbol:'BTCUSDT',clientOrderId:'zenith-entry-123'}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'/api/binance-protective-execute');
  assert.equal(d.body.type,'EXEC_CANCEL_ENTRY');
  assert.equal(d.body.clientOrderId,'zenith-entry-123');
  assert.equal('quantity' in d.body,false);
});

test('cancel entry requires Binance client order id',()=>{
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-cancel-1234',type:'EXEC_CANCEL_ENTRY',payload:{symbol:'BTCUSDT'}
  }),/CLIENT_ORDER_ID_INVALID/);
});
