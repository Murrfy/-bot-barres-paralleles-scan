import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { conflictingProtectiveOrders } from '../api/binance-protective-update-execute.js';

const update={symbol:'BTCUSDT',direction:'LONG'};

function runtime(binanceOrders){
  return {data:{binanceOrders}};
}

test('unknown exit target blocks automatic replacement',()=>{
  const conflicts=conflictingProtectiveOrders(runtime([{
    orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'LIMIT',timeInForce:'GTC',reduceOnly:true,clientOrderId:'manual-target'
  }]),update,'EXIT',[]);
  assert.equal(conflicts.length,1);
});

test('idempotent desired target is allowed but another target still blocks',()=>{
  const orders=[
    {orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',timeInForce:'GTC',reduceOnly:true,clientOrderId:'zth-EXI-new'},
    {orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',timeInForce:'GTC',reduceOnly:true,clientOrderId:'manual-target'},
  ];
  const conflicts=conflictingProtectiveOrders(runtime(orders),update,'EXIT',['zth-EXI-new']);
  assert.deepEqual(conflicts.map(x=>x.clientOrderId),['manual-target']);
});

test('max-loss replacement allows exactly old and new Zenith protections',()=>{
  const orders=[
    {orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',closePosition:true,clientAlgoId:'zth-MAX-old'},
    {orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',closePosition:true,clientAlgoId:'zth-MAX-new'},
  ];
  assert.equal(conflictingProtectiveOrders(runtime(orders),update,'MAX_LOSS',['zth-MAX-old','zth-MAX-new']).length,0);
  assert.equal(conflictingProtectiveOrders(runtime([...orders,{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',closePosition:true,clientAlgoId:'manual-stop'
  }]),update,'MAX_LOSS',['zth-MAX-old','zth-MAX-new']).length,1);
});


test('progressive replacement temporarily allows only the identified old and new Zenith protections',()=>{
  const orders=[
    {orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',timeInForce:'GTC',reduceOnly:true,clientAlgoId:'zth-PRO-old'},
    {orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',timeInForce:'GTC',reduceOnly:true,clientAlgoId:'zth-PRO-new'},
  ];
  assert.equal(conflictingProtectiveOrders(runtime(orders),update,'PROGRESSIVE',['zth-PRO-old','zth-PRO-new']).length,0);
  const withExternal=[...orders,{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'GTC',reduceOnly:true,clientAlgoId:'manual-stop'
  }];
  assert.deepEqual(
    conflictingProtectiveOrders(runtime(withExternal),update,'PROGRESSIVE',['zth-PRO-old','zth-PRO-new'])
      .map(x=>x.clientAlgoId),
    ['manual-stop']
  );
});


test('server refuses cancel-old progressive until the replacement STOP+LIMIT is confirmed',async()=>{
  const api=await readFile(new URL('../api/binance-protective-update-execute.js',import.meta.url),'utf8');
  assert.match(api,/NEW_PROGRESSIVE_PROTECTION_NOT_CONFIRMED/);
  assert.match(api,/newClientAlgoId/);
  assert.match(api,/confirmedNew\.type/);
  assert.match(api,/confirmedNew\.timeInForce/);
  assert.match(api,/confirmedNew\.reduceOnly/);
  assert.match(api,/confirmedNew\.price/);
  assert.match(api,/confirmedNew\?\.triggerPrice/);
  assert.match(api,/allowedIds\.push\(update\.previousClientAlgoId\)/);
});
