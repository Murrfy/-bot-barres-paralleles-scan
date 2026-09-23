import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserStreamState,
  markUserStreamConnected,
  markUserStreamDisconnected,
  markUserStreamReconciled,
  markUserStreamNeedsReconciliation,
  applyUserDataEvent,
  userStreamReady,
} from '../lib/user-stream-state.mjs';

function readyState(){
  let s=markUserStreamConnected(createUserStreamState(),{connectionId:'ws-1',at:1000});
  s=markUserStreamReconciled(s,{observedAt:1100,runtimeHash:'abc'});
  return s;
}

test('new connection fails closed until REST reconciliation',()=>{
  const s=markUserStreamConnected(createUserStreamState(),{connectionId:'ws-1',at:1000});
  assert.equal(userStreamReady(s),false);
  const r=markUserStreamReconciled(s,{observedAt:1001,runtimeHash:'abc'});
  assert.equal(userStreamReady(r),true);
});

test('partial fill followed by fill is tracked monotonically',()=>{
  let s=readyState();
  let r=applyUserDataEvent(s,{e:'ORDER_TRADE_UPDATE',E:1200,T:1199,o:{s:'BTCUSDT',c:'zth-entry-1',i:1,S:'BUY',o:'LIMIT',f:'GTC',q:'0.02',p:'50000',x:'TRADE',X:'PARTIALLY_FILLED',l:'0.01',z:'0.01',L:'50000',R:false,ps:'BOTH'}});
  assert.equal(r.applied,true);
  const key='BTCUSDT:client:zth-entry-1';
  assert.equal(r.state.standardOrders[key].status,'PARTIALLY_FILLED');
  r=applyUserDataEvent(r.state,{e:'ORDER_TRADE_UPDATE',E:1300,T:1299,o:{s:'BTCUSDT',c:'zth-entry-1',i:1,S:'BUY',o:'LIMIT',f:'GTC',q:'0.02',p:'50000',x:'TRADE',X:'FILLED',l:'0.01',z:'0.02',L:'50001',R:false,ps:'BOTH'}});
  assert.equal(r.state.standardOrders[key].terminal,true);
  assert.equal(r.state.standardOrders[key].cumulativeFilledQuantity,'0.02');
});

test('older event after a newer same-type event fails closed',()=>{
  let s=readyState();
  s=applyUserDataEvent(s,{e:'ORDER_TRADE_UPDATE',E:1300,o:{s:'BTCUSDT',c:'x1',i:1,X:'NEW'}}).state;
  const r=applyUserDataEvent(s,{e:'ORDER_TRADE_UPDATE',E:1200,o:{s:'BTCUSDT',c:'x1',i:1,X:'CANCELED'}});
  assert.equal(r.applied,false);
  assert.equal(r.state.failClosed,true);
  assert.ok(r.state.failReasons.includes('STREAM_EVENT_OUT_OF_ORDER'));
});

test('duplicate event time is ignored rather than applied twice',()=>{
  let s=readyState();
  s=applyUserDataEvent(s,{e:'ORDER_TRADE_UPDATE',E:1300,o:{s:'BTCUSDT',c:'x1',i:1,X:'NEW'}}).state;
  const r=applyUserDataEvent(s,{e:'ORDER_TRADE_UPDATE',E:1300,o:{s:'BTCUSDT',c:'x1',i:1,X:'NEW'}});
  assert.equal(r.duplicate,true);
});

test('ACCOUNT_UPDATE maintains only nonzero live positions',()=>{
  let s=readyState();
  let r=applyUserDataEvent(s,{e:'ACCOUNT_UPDATE',E:1400,T:1399,a:{m:'ORDER',B:[{a:'USDT',wb:'1000',cw:'1000',bc:'0'}],P:[{s:'BTCUSDT',pa:'0.02',ep:'50000',bep:'50001',up:'2',mt:'isolated',iw:'100',ps:'BOTH'}]}});
  assert.equal(Object.keys(r.state.positions).length,1);
  assert.equal(r.state.positions['BTCUSDT:BOTH'].marginType,'isolated');
  r=applyUserDataEvent(r.state,{e:'ACCOUNT_UPDATE',E:1500,T:1499,a:{m:'ORDER',P:[{s:'BTCUSDT',pa:'0',ep:'0',bep:'0',up:'0',mt:'isolated',iw:'0',ps:'BOTH'}]}});
  assert.equal(Object.keys(r.state.positions).length,0);
});

test('listenKey expiry and disconnect both require reconciliation',()=>{
  let s=readyState();
  let r=applyUserDataEvent(s,{e:'listenKeyExpired',E:1600});
  assert.equal(userStreamReady(r.state),false);
  assert.ok(r.state.failReasons.includes('LISTEN_KEY_EXPIRED'));
  r={state:markUserStreamDisconnected(readyState(),{at:1700})};
  assert.equal(userStreamReady(r.state),false);
  assert.equal(r.state.needsReconciliation,true);
});

test('ALGO_UPDATE is tracked separately from standard orders',()=>{
  const r=applyUserDataEvent(readyState(),{e:'ALGO_UPDATE',E:1800,T:1799,o:{s:'BTCUSDT',ai:77,ca:'protect-77',X:'NEW',o:'STOP_MARKET',S:'SELL',ps:'BOTH',sp:'49000',ia:true}});
  assert.equal(Object.keys(r.state.algoOrders).length,1);
  assert.equal(r.state.algoOrders['BTCUSDT:algo:77'].activated,true);
});

test('explicit reconciliation invalidation keeps connection but fails closed',()=>{
  const s=markUserStreamNeedsReconciliation(readyState(),'RUNTIME_CHANGED');
  assert.equal(s.connected,true);
  assert.equal(s.needsReconciliation,true);
  assert.equal(s.failClosed,true);
  assert.ok(s.failReasons.includes('RUNTIME_CHANGED'));
});


test('certified REST reconciliation clears transient inventory invalidation',()=>{
  let s=readyState();
  s=markUserStreamNeedsReconciliation(s,'STREAM_INVENTORY_CHANGED');
  assert.equal(userStreamReady(s),false);
  const r=markUserStreamReconciled(s,{observedAt:1900,runtimeHash:'fresh-hash'});
  assert.equal(userStreamReady(r),true);
  assert.deepEqual(r.failReasons,[]);
});

test('fresh websocket connection resets stale connection-local failures before reconciliation',()=>{
  let s=readyState();
  s=markUserStreamDisconnected(s,{at:2000,reason:'SCHEDULED_23H_RECONNECT'});
  assert.ok(s.failReasons.includes('SCHEDULED_23H_RECONNECT'));
  s=markUserStreamConnected(s,{connectionId:'ws-2',at:2100});
  assert.deepEqual(s.failReasons,['RECONCILIATION_REQUIRED_AFTER_CONNECT']);
  s=markUserStreamReconciled(s,{observedAt:2200,runtimeHash:'new-connection-hash'});
  assert.equal(userStreamReady(s),true);
});


test('position lifecycle survives non-core updates but changes after flat-and-reopen',()=>{
  let s=readyState();
  let r=applyUserDataEvent(s,{e:'ACCOUNT_UPDATE',E:2300,T:2299,a:{m:'ORDER',P:[
    {s:'BTCUSDT',pa:'0.02',ep:'50000',bep:'50001',up:'2',mt:'isolated',iw:'100',ps:'BOTH'}
  ]}});
  assert.equal(r.state.positions['BTCUSDT:BOTH'].positionLifecycleAt,2299);

  r=applyUserDataEvent(r.state,{e:'ACCOUNT_UPDATE',E:2400,T:2399,a:{m:'FUNDING_FEE',P:[
    {s:'BTCUSDT',pa:'0.02',ep:'50000',bep:'50001',up:'3',mt:'isolated',iw:'99',ps:'BOTH'}
  ]}});
  assert.equal(r.state.positions['BTCUSDT:BOTH'].positionLifecycleAt,2299);

  r=applyUserDataEvent(r.state,{e:'ACCOUNT_UPDATE',E:2500,T:2499,a:{m:'ORDER',P:[
    {s:'BTCUSDT',pa:'0',ep:'0',bep:'0',up:'0',mt:'isolated',iw:'0',ps:'BOTH'}
  ]}});
  assert.equal(r.state.positions['BTCUSDT:BOTH'],undefined);

  r=applyUserDataEvent(r.state,{e:'ACCOUNT_UPDATE',E:2600,T:2599,a:{m:'ORDER',P:[
    {s:'BTCUSDT',pa:'0.02',ep:'50000',bep:'50001',up:'1',mt:'isolated',iw:'100',ps:'BOTH'}
  ]}});
  assert.equal(r.state.positions['BTCUSDT:BOTH'].positionLifecycleAt,2599);
  assert.notEqual(r.state.positions['BTCUSDT:BOTH'].positionLifecycleAt,2299);
});

test('changing quantity or entry starts a new position lifecycle',()=>{
  let s=readyState();
  let r=applyUserDataEvent(s,{e:'ACCOUNT_UPDATE',E:2700,T:2699,a:{m:'ORDER',P:[
    {s:'ETHUSDT',pa:'1',ep:'2000',bep:'2001',up:'0',mt:'isolated',iw:'100',ps:'BOTH'}
  ]}});
  assert.equal(r.state.positions['ETHUSDT:BOTH'].positionLifecycleAt,2699);
  r=applyUserDataEvent(r.state,{e:'ACCOUNT_UPDATE',E:2800,T:2799,a:{m:'ORDER',P:[
    {s:'ETHUSDT',pa:'2',ep:'2005',bep:'2006',up:'0',mt:'isolated',iw:'200',ps:'BOTH'}
  ]}});
  assert.equal(r.state.positions['ETHUSDT:BOTH'].positionLifecycleAt,2799);
});
