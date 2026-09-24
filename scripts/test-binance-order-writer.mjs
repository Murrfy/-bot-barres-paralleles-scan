import test from 'node:test';
import assert from 'node:assert/strict';
import { placeStandardOrderIdempotent, signedBinanceRequest, BinanceRequestError } from '../lib/binance-order-writer.mjs';

function jsonResponse(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})}
const order={symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',timeInForce:'IOC',quantity:'0.02',reduceOnly:'true',priceMatch:'OPPONENT',newClientOrderId:'zth-EXI-0123456789abcdef01234567'};
const existingOrder={
  symbol:order.symbol,
  side:order.side,
  positionSide:order.positionSide,
  type:order.type,
  timeInForce:order.timeInForce,
  origQty:order.quantity,
  reduceOnly:true,
  priceMatch:order.priceMatch,
  clientOrderId:order.newClientOrderId,
  status:'NEW',
};


test('write lock performs only idempotency query and never POSTs',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    return jsonResponse({code:-2013,msg:'Order does not exist.'},400);
  };
  const r=await placeStandardOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',orderParams:order,writesEnabled:false,timestamp:1000});
  assert.equal(r.disposition,'WRITE_LOCKED');
  assert.equal(r.writeAttempted,false);
  assert.deepEqual(methods,['GET']);
});

test('existing client id is returned without duplicate POST',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    return jsonResponse({...existingOrder,orderId:9});
  };
  const r=await placeStandardOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',orderParams:order,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'EXISTING');
  assert.equal(r.writeAttempted,false);
  assert.deepEqual(methods,['GET']);
});

test('existing deterministic client id must match the intended order identity',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    return jsonResponse({...existingOrder,side:'BUY',orderId:91});
  };
  await assert.rejects(
    placeStandardOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',orderParams:order,writesEnabled:true,timestamp:1000}),
    e=>e instanceof BinanceRequestError&&e.message==='STANDARD_SIDE_MISMATCH'&&e.ambiguous===true
  );
  assert.deepEqual(methods,['GET']);
});

test('not-found query permits exactly one POST when writes are enabled',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET')return jsonResponse({code:-2013,msg:'Order does not exist.'},400);
    return jsonResponse({symbol:'BTCUSDT',clientOrderId:order.newClientOrderId,orderId:10,status:'NEW'});
  };
  const r=await placeStandardOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',orderParams:order,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'PLACED');
  assert.equal(r.writeAttempted,true);
  assert.deepEqual(methods,['GET','POST']);
});

test('ambiguous POST is resolved by deterministic client-id query without second POST',async()=>{
  const methods=[];
  let getCount=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'){
      getCount++;
      if(getCount===1)return jsonResponse({code:-2013,msg:'Order does not exist.'},400);
      return jsonResponse({...existingOrder,orderId:11});
    }
    throw new TypeError('network reset after send');
  };
  const r=await placeStandardOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',orderParams:order,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'RECOVERED_AFTER_AMBIGUOUS_POST');
  assert.deepEqual(methods,['GET','POST','GET']);
});

test('unresolved ambiguous POST fails closed and never retries POST',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET')return jsonResponse({code:-2013,msg:'Order does not exist.'},400);
    throw new TypeError('timeout');
  };
  await assert.rejects(
    placeStandardOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',orderParams:order,writesEnabled:true,timestamp:1000}),
    e=>e instanceof BinanceRequestError&&e.message==='ORDER_RESULT_AMBIGUOUS'&&e.ambiguous===true
  );
  assert.deepEqual(methods,['GET','POST','GET']);
});


test('Binance 429 preserves Retry-After metadata without marking execution ambiguous',async()=>{
  const fetchImpl=async()=>new Response(
    JSON.stringify({code:-1003,msg:'Too many requests'}),
    {status:429,headers:{'Content-Type':'application/json','Retry-After':'17'}}
  );
  await assert.rejects(
    signedBinanceRequest({
      fetchImpl,path:'/fapi/v1/order',method:'POST',
      apiKey:'k',secret:'s',params:{symbol:'BTCUSDT'},timestamp:1000
    }),
    e=>e instanceof BinanceRequestError &&
      e.status===429 &&
      e.retryAfterSeconds===17 &&
      e.ambiguous===false
  );
});
