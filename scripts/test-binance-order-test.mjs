import test from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='redis-token';
process.env.BINANCE_API_KEY='api-key';
process.env.BINANCE_API_SECRET='secret';

const {default:handler}=await import('../api/binance-order-test.js?test='+Date.now());

function response(){
  return {setHeader(){},status(n){this.code=n;return this},json(body){this.body=body;return body}};
}
function req(plan){
  return {method:'POST',headers:{authorization:'Bearer master-token'},body:{plan}};
}
function goodPlan(){
  return {
    writeAllowed:false,endpoint:'/fapi/v1/order',method:'POST',
    params:{
      symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',type:'LIMIT',quantity:'0.02',
      reduceOnly:'false',newClientOrderId:'zth-ENT-12345678',timeInForce:'GTC',price:'50000'
    }
  };
}
function harness({role='master',registered='master-1',lease='master-1'}={}){
  const original=globalThis.fetch;
  const binance=[];
  globalThis.fetch=async(url,init={})=>{
    if(url==='https://redis.test'){
      const c=JSON.parse(init.body);
      let result=null;
      if(c[0]==='GET'&&String(c[1]).includes(':device:'))result=JSON.stringify({role,deviceId:role==='master'?'master-1':'controller-1'});
      else if(c[0]==='GET'&&c[1]==='zenith:v1:role-device:master')result=registered;
      else if(c[0]==='GET'&&c[1]==='zenith:v1:master')result=lease;
      return new Response(JSON.stringify({result}));
    }
    const u=new URL(url);binance.push({path:u.pathname,method:init.method||'GET',body:String(init.body||'')});
    if(u.pathname==='/fapi/v1/time')return new Response(JSON.stringify({serverTime:1700000000000}));
    if(u.pathname==='/fapi/v1/order/test')return new Response('{}');
    return new Response('{}',{status:404});
  };
  return {binance,restore(){globalThis.fetch=original}};
}

test('only current leased MASTER can send a Binance test order',async()=>{
  for(const scenario of [
    {role:'controller',expected:401},
    {role:'master',registered:'other',expected:401},
    {role:'master',lease:'other',expected:409},
  ]){
    const h=harness(scenario);
    try{
      const res=response();await handler(req(goodPlan()),res);
      assert.equal(res.code,scenario.expected);
      assert.deepEqual(h.binance,[]);
    }finally{h.restore()}
  }
});

test('test endpoint signs only /fapi/v1/order/test and never submits to matching engine',async()=>{
  const h=harness();
  try{
    const res=response();await handler(req(goodPlan()),res);
    assert.equal(res.code,200);
    assert.equal(res.body.matchingEngineSubmitted,false);
    assert.equal(res.body.endpoint,'/fapi/v1/order/test');
    assert.deepEqual(h.binance.map(x=>x.path),['/fapi/v1/time','/fapi/v1/order/test']);
    const call=h.binance[1];
    assert.equal(call.method,'POST');
    assert.ok(call.body.includes('signature='));
    assert.ok(call.body.includes('newClientOrderId=zth-ENT-12345678'));
  }finally{h.restore()}
});
