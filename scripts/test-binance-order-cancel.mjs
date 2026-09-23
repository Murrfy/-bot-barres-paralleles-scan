import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelEntryOrderIdempotent, BinanceRequestError } from '../lib/binance-order-writer.mjs';

const openOrder={symbol:'BTCUSDT',clientOrderId:'entry-123',orderId:1,status:'NEW',reduceOnly:false,positionSide:'BOTH'};
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})}

test('write lock never DELETEs',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{methods.push(init.method);return json(openOrder)};
  const r=await cancelEntryOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:'entry-123',writesEnabled:false,timestamp:1});
  assert.equal(r.disposition,'WRITE_LOCKED');
  assert.deepEqual(methods,['GET']);
});

test('cancel entry queries first then performs one DELETE',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET')return json(openOrder);
    return json({...openOrder,status:'CANCELED'});
  };
  const r=await cancelEntryOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:'entry-123',writesEnabled:true,timestamp:1});
  assert.equal(r.disposition,'CANCELED');
  assert.equal(r.writeAttempted,true);
  assert.deepEqual(methods,['GET','DELETE']);
});

test('filled order is never canceled and requests reconciliation',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{methods.push(init.method);return json({...openOrder,status:'FILLED'})};
  const r=await cancelEntryOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:'entry-123',writesEnabled:true,timestamp:1});
  assert.equal(r.disposition,'ALREADY_FILLED');
  assert.equal(r.writeAttempted,false);
  assert.equal(r.reconciliationRequired,true);
  assert.deepEqual(methods,['GET']);
});

test('reduce-only order is never canceled by entry-cancel path',async()=>{
  const fetchImpl=async()=>json({...openOrder,reduceOnly:true});
  await assert.rejects(
    cancelEntryOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:'entry-123',writesEnabled:true,timestamp:1}),
    e=>e instanceof BinanceRequestError&&e.message==='CANCEL_TARGET_IS_REDUCE_ONLY'
  );
});

test('ambiguous DELETE is resolved only by query, never blind DELETE retry',async()=>{
  const methods=[];let gets=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'){
      gets++;
      return json(gets===1?openOrder:{...openOrder,status:'CANCELED'});
    }
    throw new TypeError('network reset');
  };
  const r=await cancelEntryOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:'entry-123',writesEnabled:true,timestamp:1});
  assert.equal(r.disposition,'RECOVERED_CANCELED');
  assert.deepEqual(methods,['GET','DELETE','GET']);
});

test('unknown cancel target fails closed',async()=>{
  const fetchImpl=async()=>json({code:-2013,msg:'Order does not exist.'},400);
  await assert.rejects(
    cancelEntryOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:'entry-123',writesEnabled:true,timestamp:1}),
    e=>e instanceof BinanceRequestError&&e.message==='CANCEL_TARGET_UNKNOWN'&&e.ambiguous===true
  );
});
