import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { conflictingProtectiveOrders, emergencyProtection } from '../api/binance-protective-update-execute.js';

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
    {orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',timeInForce:'IOC',reduceOnly:true,closePosition:false,origQty:'1',priceMatch:'OPPONENT',clientAlgoId:'zth-MAX-old'},
    {orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',timeInForce:'IOC',reduceOnly:true,closePosition:false,origQty:'1',priceMatch:'OPPONENT',clientAlgoId:'zth-MAX-new'},
  ];
  assert.equal(conflictingProtectiveOrders(runtime(orders),update,'MAX_LOSS',['zth-MAX-old','zth-MAX-new']).length,0);
  assert.equal(conflictingProtectiveOrders(runtime([...orders,{
    orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',timeInForce:'IOC',reduceOnly:true,closePosition:false,origQty:'1',priceMatch:'OPPONENT',clientAlgoId:'manual-stop'
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


test('emergency protection validator accepts $400 but rejects anything above the hard cap',()=>{
  const base={orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',timeInForce:'IOC',reduceOnly:true,closePosition:false,origQty:'1',priceMatch:'OPPONENT',clientAlgoId:'zth-MAX-cap'};
  const update={symbol:'BTCUSDT',direction:'LONG',quantity:1};
  assert.ok(emergencyProtection(runtime([{...base,triggerPrice:'49600'}]),update,50000));
  assert.equal(emergencyProtection(runtime([{...base,triggerPrice:'49599.99'}]),update,50000),null);
});

test('SHORT emergency protection uses the same $400 hard cap',()=>{
  const base={orderClass:'ALGO',symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',
    type:'STOP',timeInForce:'IOC',reduceOnly:true,closePosition:false,origQty:'1',priceMatch:'OPPONENT',clientAlgoId:'zth-MAX-short'};
  const update={symbol:'BTCUSDT',direction:'SHORT',quantity:1};
  assert.ok(emergencyProtection(runtime([{...base,triggerPrice:'50400'}]),update,50000));
  assert.equal(emergencyProtection(runtime([{...base,triggerPrice:'50400.01'}]),update,50000),null);
});


test('cancel-old MAX-LOSS may use the exact transition repair target only with a confirmed new id',async()=>{
  const api=await readFile(new URL('../api/binance-protective-update-execute.js',import.meta.url),'utf8');
  assert.match(api,/phase==='CANCEL_OLD'&&update\.protectionKind==='MAX_LOSS'&&String\(req\.body\?\.newClientAlgoId\|\|''\)/);
  assert.match(api,/NEW_MAX_LOSS_PROTECTION_NOT_CONFIRMED/);
});


test('progressive placement blocks a standard reduce-only LIMIT that is not a Zenith exit target',()=>{
  const pending={
    orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'LIMIT',timeInForce:'GTC',reduceOnly:true,clientOrderId:'child-protection-limit'
  };
  const conflicts=conflictingProtectiveOrders(runtime([pending]),update,'PROGRESSIVE',[]);
  assert.equal(conflicts.length,1);
  assert.equal(conflicts[0].clientOrderId,'child-protection-limit');
});

test('progressive placement allows a normal Zenith zth-EXI target LIMIT',()=>{
  const target={
    orderClass:'STANDARD',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'LIMIT',timeInForce:'GTC',reduceOnly:true,
    clientOrderId:'zth-EXI-0123456789abcdef01234567'
  };
  assert.equal(conflictingProtectiveOrders(runtime([target]),update,'PROGRESSIVE',[]).length,0);
});


test('server enforces the configured MAX-LOSS cap, not only the global $400 ceiling',()=>{
  const source=fs.readFileSync('api/binance-protective-update-execute.js','utf8');
  assert.match(source,/KEY_CONTROLLER_STATE/);
  assert.match(source,/configuredMaxLossUsd\(state\.controllerState,update\.symbol\)/);
  assert.match(source,/const allowedMaxLoss=activeEdit\?requestedMaxLoss:configuredMaxLoss/);
  assert.match(source,/Math\.min\(allowedMaxLoss,REAL_RISK_LIMITS\.maxLossUsd\)/);
  assert.match(source,/MAX_LOSS_EXCEEDS_CONFIGURED_LIMIT/);
  assert.match(source,/CONFIGURED_MAX_LOSS_UNAVAILABLE/);
});
