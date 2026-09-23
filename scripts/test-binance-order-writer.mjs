import test from 'node:test';
import assert from 'node:assert/strict';
import { placeStandardOrderIdempotent, modifyStandardLimitOrderIdempotent, BinanceRequestError } from '../lib/binance-order-writer.mjs';

function jsonResponse(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})}
const order={symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',timeInForce:'IOC',quantity:'0.02',reduceOnly:'true',priceMatch:'OPPONENT',newClientOrderId:'zth-EXI-0123456789abcdef01234567'};

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
    return jsonResponse({symbol:'BTCUSDT',clientOrderId:order.newClientOrderId,orderId:9,status:'NEW'});
  };
  const r=await placeStandardOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',orderParams:order,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'EXISTING');
  assert.equal(r.writeAttempted,false);
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
      return jsonResponse({symbol:'BTCUSDT',clientOrderId:order.newClientOrderId,orderId:11,status:'NEW'});
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


const exitOrder={symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',timeInForce:'GTC',origQty:'0.02',executedQty:'0',price:'51000',reduceOnly:true,clientOrderId:'zth-EXI-0123456789abcdef01234567',status:'NEW'};

test('reduce-only LIMIT modification is idempotent when target already matches',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{methods.push(init.method);return jsonResponse(exitOrder)};
  const r=await modifyStandardLimitOrderIdempotent({
    fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:exitOrder.clientOrderId,
    side:'SELL',quantity:0.02,price:51000,writesEnabled:true,timestamp:1000
  });
  assert.equal(r.disposition,'EXISTING_MATCH');
  assert.deepEqual(methods,['GET']);
});

test('reduce-only LIMIT modification sends one PUT and validates returned order',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET')return jsonResponse(exitOrder);
    if(init.method==='PUT')return jsonResponse({...exitOrder,price:'52000'});
    throw new Error('unexpected');
  };
  const r=await modifyStandardLimitOrderIdempotent({
    fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:exitOrder.clientOrderId,
    side:'SELL',quantity:0.02,price:52000,writesEnabled:true,timestamp:1000
  });
  assert.equal(r.disposition,'MODIFIED');
  assert.deepEqual(methods,['GET','PUT']);
});

test('partially filled exit is never modified in place',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{methods.push(init.method);return jsonResponse({...exitOrder,executedQty:'0.005',status:'PARTIALLY_FILLED'})};
  await assert.rejects(
    modifyStandardLimitOrderIdempotent({
      fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:exitOrder.clientOrderId,
      side:'SELL',quantity:0.015,price:52000,writesEnabled:true,timestamp:1000
    }),
    e=>e instanceof BinanceRequestError&&e.message==='MODIFY_TARGET_PARTIALLY_FILLED'
  );
  assert.deepEqual(methods,['GET']);
});

test('ambiguous PUT is recovered by query and never repeated',async()=>{
  const methods=[];let gets=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'){
      gets++;
      return jsonResponse(gets===1?exitOrder:{...exitOrder,price:'52000'});
    }
    if(init.method==='PUT')throw new TypeError('network reset');
    throw new Error('unexpected');
  };
  const r=await modifyStandardLimitOrderIdempotent({
    fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:exitOrder.clientOrderId,
    side:'SELL',quantity:0.02,price:52000,writesEnabled:true,timestamp:1000
  });
  assert.equal(r.disposition,'RECOVERED_AFTER_AMBIGUOUS_MODIFY');
  assert.deepEqual(methods,['GET','PUT','GET']);
});

test('unresolved ambiguous PUT fails closed after one PUT',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET')return jsonResponse(exitOrder);
    if(init.method==='PUT')throw new TypeError('timeout');
    throw new Error('unexpected');
  };
  await assert.rejects(
    modifyStandardLimitOrderIdempotent({
      fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientOrderId:exitOrder.clientOrderId,
      side:'SELL',quantity:0.02,price:52000,writesEnabled:true,timestamp:1000
    }),
    e=>e instanceof BinanceRequestError&&e.message==='ORDER_MODIFY_RESULT_AMBIGUOUS'&&e.ambiguous===true
  );
  assert.deepEqual(methods,['GET','PUT','GET']);
});
