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

test('real entry remains unreachable while protective mutations are routed',()=>{
  const d=buildMasterCommandDispatch({id:'command-12345678',type:'EXEC_OPEN_POSITION',payload:{}});
  assert.equal(d.supported,false);
});

test('exact exit update routes to protective mutation endpoint',()=>{
  const d=buildMasterCommandDispatch({
    id:'command-exit-1234',type:'EXEC_UPDATE_EXIT',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,targetPrice:52000,clientOrderId:'exit-123'}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'/api/binance-protective-mutate');
  assert.equal(d.body.type,'EXEC_UPDATE_EXIT');
  assert.equal(d.body.targetPrice,52000);
  assert.equal(d.body.clientOrderId,'exit-123');
});

test('protection update routes to protective mutation endpoint',()=>{
  const d=buildMasterCommandDispatch({
    id:'command-prot-1234',type:'EXEC_UPDATE_PROTECTION',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:49500,previousClientAlgoId:'prot-old'}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'/api/binance-protective-mutate');
  assert.equal(d.body.type,'EXEC_UPDATE_PROTECTION');
  assert.equal(d.body.triggerPrice,49500);
  assert.equal(d.body.previousClientAlgoId,'prot-old');
});

test('protective mutation dispatcher rejects invalid prices and quantities',()=>{
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-exit-1234',type:'EXEC_UPDATE_EXIT',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0,targetPrice:52000}
  }),/QUANTITY_INVALID/);
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-prot-1234',type:'EXEC_UPDATE_PROTECTION',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:0}
  }),/TRIGGER_PRICE_INVALID/);
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
