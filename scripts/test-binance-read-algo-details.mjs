import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAlgoOrderDetails } from '../api/binance-read.js';

test('Binance read exposes normalized conditional algo order identity',()=>{
  const [o]=normalizeAlgoOrderDetails([{
    symbol:'btcusdt',algoId:12,clientAlgoId:'zth-MAX-abc',
    side:'SELL',positionSide:'BOTH',orderType:'STOP_MARKET',algoStatus:'NEW',
    quantity:'0.02',triggerPrice:'48000',reduceOnly:false,closePosition:true,
    workingType:'CONTRACT_PRICE',priceMatch:'NONE',updateTime:100
  }]);
  assert.equal(o.symbol,'BTCUSDT');
  assert.equal(o.clientAlgoId,'zth-MAX-abc');
  assert.equal(o.type,'STOP_MARKET');
  assert.equal(o.status,'NEW');
  assert.equal(o.triggerPrice,'48000');
  assert.equal(o.closePosition,true);
  assert.equal(o.reduceOnly,false);
});

test('Binance read tolerates alternate REST field names without inventing values',()=>{
  const [o]=normalizeAlgoOrderDetails([{
    symbol:'ETHUSDT',clientOrderId:'zth-PRO-abc',side:'BUY',
    type:'STOP',status:'NEW',origQty:'2',stopPrice:'3100',reduceOnly:'true'
  }]);
  assert.equal(o.clientAlgoId,'zth-PRO-abc');
  assert.equal(o.type,'STOP');
  assert.equal(o.origQty,'2');
  assert.equal(o.triggerPrice,'3100');
  assert.equal(o.reduceOnly,true);
});
