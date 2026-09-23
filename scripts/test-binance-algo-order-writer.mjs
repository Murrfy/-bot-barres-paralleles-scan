import test from 'node:test';
import assert from 'node:assert/strict';
import {
  placeAlgoOrderIdempotent,
  cancelAlgoOrderIdempotent,
  BinanceRequestError,
} from '../lib/binance-algo-order-writer.mjs';

function jsonResponse(body,status=200){
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
}

const params={
  algoType:'CONDITIONAL',
  symbol:'BTCUSDT',
  side:'SELL',
  positionSide:'BOTH',
  type:'STOP_MARKET',
  triggerPrice:'49000',
  workingType:'MARK_PRICE',
  closePosition:'true',
  clientAlgoId:'zth-PRO-0123456789abcdef01234567',
};

test('existing deterministic algo id prevents duplicate POST',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    return jsonResponse({...params,algoStatus:'NEW'});
  };
  const r=await placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'EXISTING');
  assert.equal(r.writeAttempted,false);
  assert.deepEqual(methods,['GET']);
});

test('missing algo permits exactly one POST',async()=>{
  const methods=[];let gets=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'){
      gets++; return jsonResponse({code:-2013,msg:'Order does not exist.'},400);
    }
    return jsonResponse({...params,algoId:42,algoStatus:'NEW'});
  };
  const r=await placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'PLACED');
  assert.equal(r.writeAttempted,true);
  assert.deepEqual(methods,['GET','POST']);
  assert.equal(gets,1);
});

test('ambiguous algo POST is recovered by query without duplicate POST',async()=>{
  const methods=[];let gets=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'){
      gets++;
      if(gets===1)return jsonResponse({code:-2013,msg:'Order does not exist.'},400);
      return jsonResponse({...params,algoId:43,algoStatus:'NEW'});
    }
    throw new TypeError('network reset after send');
  };
  const r=await placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'RECOVERED_AFTER_AMBIGUOUS_POST');
  assert.deepEqual(methods,['GET','POST','GET']);
});

test('unresolved ambiguous algo POST fails closed',async()=>{
  const methods=[];
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET')return jsonResponse({code:-2013,msg:'Order does not exist.'},400);
    throw new TypeError('timeout');
  };
  await assert.rejects(
    placeAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',algoParams:params,writesEnabled:true,timestamp:1000}),
    e=>e instanceof BinanceRequestError&&e.message==='ALGO_ORDER_RESULT_AMBIGUOUS'&&e.ambiguous===true
  );
  assert.deepEqual(methods,['GET','POST','GET']);
});

test('algo cancellation never retries DELETE after ambiguous result',async()=>{
  const methods=[];let gets=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'){
      gets++;
      return jsonResponse({...params,algoStatus:'NEW'});
    }
    if(init.method==='DELETE')throw new TypeError('network reset');
    throw new Error('unexpected');
  };
  await assert.rejects(
    cancelAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',clientAlgoId:params.clientAlgoId,writesEnabled:true,timestamp:1000}),
    e=>e instanceof BinanceRequestError&&e.message==='ALGO_CANCEL_RESULT_AMBIGUOUS'
  );
  assert.deepEqual(methods,['GET','DELETE','GET']);
  assert.equal(gets,2);
});

test('algo cancellation accepts not-found after successful/ambiguous cancellation as terminal evidence',async()=>{
  const methods=[];let gets=0;
  const fetchImpl=async(url,init={})=>{
    methods.push(init.method);
    if(init.method==='GET'){
      gets++;
      if(gets===1)return jsonResponse({...params,algoStatus:'NEW'});
      return jsonResponse({code:-2013,msg:'Order does not exist.'},400);
    }
    if(init.method==='DELETE')throw new TypeError('connection lost after delete');
    throw new Error('unexpected');
  };
  const r=await cancelAlgoOrderIdempotent({fetchImpl,apiKey:'k',secret:'s',clientAlgoId:params.clientAlgoId,writesEnabled:true,timestamp:1000});
  assert.equal(r.disposition,'NOT_FOUND_AFTER_CANCEL');
  assert.equal(r.reconciliationRequired,true);
  assert.deepEqual(methods,['GET','DELETE','GET']);
});
