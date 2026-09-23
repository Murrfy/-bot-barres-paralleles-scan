import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeInventoryFromUserStream } from '../lib/master-runtime-inventory.mjs';

function baseState(overrides={}) {
  return {
    connected:true,
    needsReconciliation:false,
    failClosed:false,
    failReasons:[],
    connectionId:'ws-1',
    positions:{},
    standardOrders:{},
    algoOrders:{},
    ...overrides,
  };
}

test('ready stream exports complete real inventory shape while mode can remain simulation-locked',()=>{
  const out=runtimeInventoryFromUserStream(baseState({
    positions:{
      'BTCUSDT:BOTH':{symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.02',entryPrice:'50000',marginType:'isolated',positionLifecycleAt:7,eventTime:10}
    },
    standardOrders:{
      a:{symbol:'BTCUSDT',orderId:'1',clientOrderId:'zth-1',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',status:'NEW',originalQuantity:'0.02',cumulativeFilledQuantity:'0',reduceOnly:true,closePosition:false,terminal:false,eventTime:11}
    }
  }));
  assert.equal(out.executionMode,'SIMULATION');
  assert.equal(out.activePositions,1);
  assert.equal(out.openOrderCount,1);
  assert.equal(out.binancePositions[0].positionAmt,'0.02');
  assert.equal(out.binancePositions[0].lifecycleAt,7);
  assert.equal(out.binanceOrders[0].reduceOnly,true);
  assert.equal(out.userStream.ready,true);
});

test('terminal standard and algo orders are excluded from open inventory',()=>{
  const out=runtimeInventoryFromUserStream(baseState({
    standardOrders:{
      a:{symbol:'BTCUSDT',orderId:'1',status:'FILLED',terminal:true},
      b:{symbol:'BTCUSDT',orderId:'2',side:'SELL',positionSide:'BOTH',type:'LIMIT',status:'NEW',terminal:false}
    },
    algoOrders:{
      a:{symbol:'BTCUSDT',algoId:'10',status:'FINISHED',side:'SELL',positionSide:'BOTH',orderType:'STOP_MARKET'},
      b:{symbol:'BTCUSDT',algoId:'11',status:'NEW',side:'SELL',positionSide:'BOTH',orderType:'STOP_MARKET',reduceOnly:true}
    }
  }));
  assert.equal(out.openOrderCount,2);
  assert.deepEqual(out.binanceOrders.map(x=>x.orderId||x.algoId).sort(),['11','2']);
});

test('disconnected or unreconciled stream is always fail-closed',()=>{
  for(const state of [
    baseState({connected:false,failClosed:true,needsReconciliation:true,failReasons:['STREAM_DISCONNECTED']}),
    baseState({needsReconciliation:true,failClosed:true,failReasons:['RECONCILIATION_REQUIRED']}),
  ]){
    const out=runtimeInventoryFromUserStream(state,'REAL');
    assert.equal(out.userStream.ready,false);
    assert.equal(out.userStream.failClosed,true);
  }
});
