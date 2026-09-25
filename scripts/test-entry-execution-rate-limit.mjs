import assert from 'node:assert/strict';
import test from 'node:test';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-only';

const {default:handler}=await import('../api/binance-entry-execute.js?rate-test='+Date.now());

function response(){
  return {
    headers:{},
    setHeader(k,v){this.headers[k]=String(v)},
    status(n){this.code=n;return this},
    json(body){this.body=body;return body},
  };
}

function request(){
  return {
    method:'POST',
    headers:{cookie:'__Host-zenith_device=master-token',host:'zenith.test','x-forwarded-proto':'https',origin:'https://zenith.test','x-zenith-engine-instance':'engine-instance-rate-limit-00001'},
    body:{
      type:'EXEC_OPEN_POSITION',
      phase:'PREPARE_PROTECTION',
      commandId:'cmd-rate-test-001',
      symbol:'BTCUSDT',
      side:'BUY',
      orderType:'LIMIT',
      margin:100,
      leverage:10,
      maxLoss:40,
      limitPrice:50000,
    },
  };
}

function harness({rateCount=7,failRateBackend=false}={}){
  const original=globalThis.fetch;
  let externalCalls=0;
  globalThis.fetch=async(url,init={})=>{
    if(url==='https://redis.test'){
      const c=JSON.parse(init.body);
      let result=null;
      if(c[0]==='GET'&&String(c[1]).includes(':device:')){
        result=JSON.stringify({role:'master',deviceId:'master-1',principal:'engine',engineInstanceId:'engine-instance-rate-limit-00001',createdAt:Date.now()});
      }else if(c[0]==='GET'&&c[1]==='zenith:v1:role-device:master'){
        result='master-1';
      }else if(c[0]==='GET'&&c[1]==='zenith:v1:master'){
        result='master-1';
      }else if(c[0]==='GET'&&c[1]==='zenith:v1:engine-instance'){
        result='engine-instance-rate-limit-00001';
      }else if(c[0]==='EVAL'&&String(c[3]||'').includes(':rate:entry-execution:')){
        if(failRateBackend)return new Response('{}',{status:503});
        result=rateCount;
      }
      return new Response(JSON.stringify({result}));
    }
    externalCalls++;
    throw new Error('Unexpected external request: '+url);
  };
  return {
    get externalCalls(){return externalCalls},
    restore(){globalThis.fetch=original},
  };
}

test('real entry execution is rate-limited before any Binance call',async()=>{
  const h=harness({rateCount:7});
  try{
    const res=response();
    await handler(request(),res);
    assert.equal(res.code,429);
    assert.equal(res.body.code,'ENTRY_EXECUTION_RATE_LIMIT');
    assert.equal(res.body.writeAttempted,false);
    assert.ok(Number(res.headers['Retry-After'])>=1);
    assert.equal(h.externalCalls,0);
  }finally{h.restore()}
});

test('real entry execution fails closed if its rate limiter backend is unavailable',async()=>{
  const h=harness({failRateBackend:true});
  try{
    const res=response();
    await handler(request(),res);
    assert.equal(res.code,503);
    assert.equal(res.body.writeAttempted,false);
    assert.equal(h.externalCalls,0);
  }finally{h.restore()}
});
