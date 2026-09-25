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

test('only explicit MARKET opening is dispatched; generic opening remains unsupported',()=>{
  const open=buildMasterCommandDispatch({id:'command-12345678',type:'EXEC_OPEN_POSITION',payload:{}});
  assert.equal(open.supported,false);

  const market=buildMasterCommandDispatch({
    id:'market-command-123',
    type:'EXEC_OPEN_MARKET_POSITION',
    payload:{symbol:'BTCUSDT',side:'BUY',orderType:'MARKET',margin:100,leverage:10,maxLoss:40,requestedAt:1800000000000}
  });
  assert.equal(market.supported,true);
  assert.equal(market.endpoint,'/api/binance-entry-execute');
  assert.equal(market.body.phase,'SUBMIT_MARKET_ENTRY');
  assert.equal(market.body.orderType,'MARKET');
  assert.equal(market.body.requestedAt,1800000000000);
  assert.equal('limitPrice' in market.body,false);

  const exit=buildMasterCommandDispatch({
    id:'command-exit-1234',type:'EXEC_UPDATE_EXIT',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,targetPrice:51000}
  });
  assert.equal(exit.supported,true);
  assert.equal(exit.endpoint,'/api/binance-protective-update-execute');
  assert.equal(exit.body.targetPrice,51000);

  const protection=buildMasterCommandDispatch({
    id:'command-protect-12',type:'EXEC_UPDATE_PROTECTION',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:50500,limitPrice:50500,protectionKind:'PROGRESSIVE'}
  });
  assert.equal(protection.supported,true);
  assert.equal(protection.body.protectionKind,'PROGRESSIVE');
  assert.equal(protection.body.triggerPrice,50500);
  assert.equal(protection.body.limitPrice,50500);
});


test('entry cancellation maps to protective endpoint without position-close fields',()=>{
  const d=buildMasterCommandDispatch({
    id:'command-cancel-1234',
    type:'EXEC_CANCEL_ENTRY',
    payload:{symbol:'BTCUSDT',clientOrderId:'zth-ENT-0123456789abcdef01234567'}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'/api/binance-protective-execute');
  assert.equal(d.body.type,'EXEC_CANCEL_ENTRY');
  assert.equal(d.body.clientOrderId,'zth-ENT-0123456789abcdef01234567');
  assert.equal('quantity' in d.body,false);
});

test('cancel entry requires Binance client order id',()=>{
  assert.throws(()=>buildMasterCommandDispatch({
    id:'command-cancel-1234',type:'EXEC_CANCEL_ENTRY',payload:{symbol:'BTCUSDT'}
  }),/CLIENT_ORDER_ID_INVALID/);
});


test('active protection-table config command is server-only and carries no Binance endpoint',()=>{
  const activeConfig={
    targetProfit:40,manualTargetProfit:40,
    protectionStages:[{enabled:true,arm:105,floor:100}],
    exactSaleEnabled:false,exactSalePrice:0,exactSaleSource:'settings'
  };
  const d=buildMasterCommandDispatch({
    id:'active-config-command-123',
    type:'EXEC_UPDATE_ACTIVE_CONFIG',
    payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.02,activeConfig}
  });
  assert.equal(d.supported,true);
  assert.equal(d.endpoint,'');
  assert.equal(d.body.type,'EXEC_UPDATE_ACTIVE_CONFIG');
  assert.deepEqual(d.body.activeConfig,activeConfig);
});


test('cancel dispatch rejects non-Zenith entry ids',()=>{
  assert.throws(()=>buildMasterCommandDispatch({id:'command-cancel-1234',type:'EXEC_CANCEL_ENTRY',payload:{symbol:'BTCUSDT',clientOrderId:'external-order-123'}}),/CANCEL_TARGET_NOT_ZENITH_ENTRY/);
});
