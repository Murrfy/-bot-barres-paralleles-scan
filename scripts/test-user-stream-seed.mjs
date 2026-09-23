import test from 'node:test';
import assert from 'node:assert/strict';
import {seedUserStreamStateFromRuntimeSnapshot} from '../lib/user-stream-seed.mjs';
import {runtimeInventoryFromUserStream} from '../lib/master-runtime-inventory.mjs';

const snapshot={
  observedAt:1000,serverTime:900,
  positions:[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.02',entryPrice:50000,breakEvenPrice:50001,unrealizedProfit:2,marginType:'isolated',isolatedMargin:100,updateTime:777}],
  standardOrders:[{symbol:'BTCUSDT',orderId:'1',clientOrderId:'zth-exit',side:'SELL',positionSide:'BOTH',type:'LIMIT',status:'NEW',origQty:'0.02',executedQty:'0',price:'51000',reduceOnly:true,closePosition:false,timeInForce:'GTC'}],
  algoOrders:[{symbol:'BTCUSDT',algoId:'2',clientAlgoId:'zth-stop',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',status:'NEW',origQty:'0.02',triggerPrice:'49000',reduceOnly:true,closePosition:false}],
};

test('REST seed creates complete fail-closed inventory pending reconciliation',()=>{
  const state=seedUserStreamStateFromRuntimeSnapshot(snapshot,{connectionId:'ws-1',connectedAt:950});
  assert.equal(state.connected,true);
  assert.equal(state.needsReconciliation,true);
  assert.equal(state.failClosed,true);
  const inv=runtimeInventoryFromUserStream(state,'REAL');
  assert.equal(inv.activePositions,1);
  assert.equal(inv.openOrderCount,2);
  assert.equal(inv.userStream.ready,false);
  assert.equal(inv.binanceOrders.filter(x=>x.reduceOnly).length,2);
  assert.equal(inv.binancePositions[0].lifecycleAt,777);
});
