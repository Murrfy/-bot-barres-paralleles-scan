import test from 'node:test';
import assert from 'node:assert/strict';
import { placeAlgoOrderIdempotent, cancelAlgoOrderIdempotent } from '../lib/binance-algo-writer.mjs';
import { BinanceRequestError } from '../lib/binance-order-writer.mjs';

function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})}
const params={
  algoType:'CONDITIONAL',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
  type:'STOP_MARKET',triggerPrice:'49000',workingType:'CONTRACT_PRICE',
  priceProtect:'false',closePosition:'true',clientAlgoId:'zth-MAX-0123456789abcdef01234567'
};
const existing={algoId:1,algoStatus:'NEW',orderType:'STOP_MARKET',...params};

test('algo write lock queries idempotency and never POSTs',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{methods.push(init.method);return response({code:-2013,msg:'Order does not exist.'},400)};
  const r=await placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:false,timestamp:1000});
  assert.equal(r.disposition,'WRITE_LOCKED');
  assert.deepEqual(methods,['GET']);
});

test('existing matching algo id never duplicate POSTs',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{methods.push(init.method);return response(existing)};
  const r=await placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'EXISTING');
  assert.deepEqual(methods,['GET']);
});

test('existing mismatched algo identity fails closed',async()=>{
  const fetchImpl=async()=>response({...existing,triggerPrice:'48000'});
  await assert.rejects(
    placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000}),
    e=>e instanceof BinanceRequestError&&e.message==='ALGO_TRIGGER_PRICE_MISMATCH'
  );
});

test('missing algo permits one POST only',async()=>{
  const methods=[];let gets=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'&&gets++===0)return response({code:-2013,msg:'Order does not exist.'},400);
    return response(existing);
  };
  const r=await placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'PLACED');
  assert.deepEqual(methods,['GET','POST']);
});

test('ambiguous algo POST is recovered by query and never repeated',async()=>{
  const methods=[];let gets=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'){
      gets++;
      if(gets===1)return response({code:-2013,msg:'Order does not exist.'},400);
      return response(existing);
    }
    throw new TypeError('socket reset');
  };
  const r=await placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'RECOVERED_AFTER_AMBIGUOUS_POST');
  assert.deepEqual(methods,['GET','POST','GET']);
});

test('unresolved ambiguous algo POST fails closed',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET')return response({code:-2013,msg:'Order does not exist.'},400);
    throw new TypeError('timeout');
  };
  await assert.rejects(
    placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000}),
    e=>e instanceof BinanceRequestError&&e.message==='ALGO_ORDER_RESULT_AMBIGUOUS'
  );
  assert.deepEqual(methods,['GET','POST','GET']);
});

test('algo cancel verifies identity before DELETE',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(methods.length===1)return response(existing);
    if(init.method==='DELETE')return response({complete:true});
    return response({...existing,algoStatus:'CANCELED'});
  };
  const r=await cancelAlgoOrderIdempotent({
    fetchImpl,apiKey:'k',secret:'s',symbol:'BTCUSDT',clientAlgoId:params.clientAlgoId,
    expected:params,writesEnabled:true,timestamp:1000
  });
  assert.equal(r.disposition,'CANCELED');
  assert.deepEqual(methods,['GET','DELETE','GET']);
});


test('progressive STOP idempotency verifies the explicit LIMIT price',async()=>{
  const progressive={
    algoType:'CONDITIONAL',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',
    type:'STOP',triggerPrice:'50500',price:'50500',timeInForce:'GTC',
    workingType:'CONTRACT_PRICE',priceProtect:'false',quantity:'0.02',
    reduceOnly:'true',clientAlgoId:'zth-PRO-0123456789abcdef01234567'
  };
  const existingProgressive={algoId:2,algoStatus:'NEW',orderType:'STOP',...progressive};
  const okFetch=async()=>response(existingProgressive);
  const ok=await placeAlgoOrderIdempotent({
    fetchImpl:okFetch,apiKey:'k',secret:'s',algoParams:progressive,writesEnabled:true,timestamp:1000
  });
  assert.equal(ok.disposition,'EXISTING');

  const badFetch=async()=>response({...existingProgressive,price:'50499.9'});
  await assert.rejects(
    placeAlgoOrderIdempotent({
      fetchImpl:badFetch,apiKey:'k',secret:'s',algoParams:progressive,writesEnabled:true,timestamp:1000
    }),
    e=>e instanceof BinanceRequestError&&e.message==='ALGO_LIMIT_PRICE_MISMATCH'
  );
});
