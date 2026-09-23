import assert from 'node:assert/strict';
import test from 'node:test';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='redis-token';
process.env.BINANCE_API_KEY='api-key';
process.env.BINANCE_API_SECRET='secret';

const {default:handler}=await import('../api/binance-runtime-snapshot.js?test='+Date.now());

function response(){
  return {setHeader(){},status(n){this.code=n;return this},json(body){this.body=body;return body}};
}
function req(){return {method:'GET',headers:{authorization:'Bearer master-token'}}}
function harness({role='master',registered='master-1',lease='master-1'}={}){
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(url,init={})=>{
    if(url==='https://redis.test'){
      const c=JSON.parse(init.body);
      let result=null;
      if(c[0]==='GET'&&String(c[1]).includes(':device:'))result=JSON.stringify({role,deviceId:role==='master'?'master-1':'controller-1'});
      else if(c[0]==='GET'&&c[1]==='zenith:v1:role-device:master')result=registered;
      else if(c[0]==='GET'&&c[1]==='zenith:v1:master')result=lease;
      return new Response(JSON.stringify({result}));
    }
    const u=new URL(url);calls.push(u.pathname);
    if(u.pathname==='/fapi/v1/time')return new Response(JSON.stringify({serverTime:1700000000000}));
    if(u.pathname==='/fapi/v3/positionRisk')return new Response(JSON.stringify([
      {symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.02',entryPrice:'50000',breakEvenPrice:'50001',markPrice:'50100',unRealizedProfit:'2',liquidationPrice:'45000',leverage:'10',marginType:'isolated',isolatedMargin:'100',notional:'1002',updateTime:10},
      {symbol:'ETHUSDT',positionSide:'BOTH',positionAmt:'0',entryPrice:'0'}
    ]));
    if(u.pathname==='/fapi/v1/openOrders')return new Response(JSON.stringify([
      {symbol:'BTCUSDT',orderId:1,clientOrderId:'zth-exit',side:'SELL',positionSide:'BOTH',type:'LIMIT',status:'NEW',origQty:'0.02',executedQty:'0',price:'51000',reduceOnly:true,closePosition:false,timeInForce:'GTC'}
    ]));
    if(u.pathname==='/fapi/v1/openAlgoOrders')return new Response(JSON.stringify([
      {symbol:'BTCUSDT',algoId:2,clientAlgoId:'zth-stop',side:'SELL',positionSide:'BOTH',orderType:'STOP_MARKET',algoStatus:'NEW',quantity:'0.02',triggerPrice:'49000',reduceOnly:true,closePosition:false}
    ]));
    return new Response('{}',{status:404});
  };
  return {calls,restore(){globalThis.fetch=original}};
}

test('snapshot is restricted to current leased MASTER',async()=>{
  for(const scenario of [
    {role:'controller',expected:401},
    {role:'master',registered:'other',expected:401},
    {role:'master',lease:'other',expected:409},
  ]){
    const h=harness(scenario);
    try{
      const res=response();await handler(req(),res);
      assert.equal(res.code,scenario.expected);
      assert.deepEqual(h.calls,[]);
    }finally{h.restore()}
  }
});

test('snapshot returns normalized full inventory without trading writes',async()=>{
  const h=harness();
  try{
    const res=response();await handler(req(),res);
    assert.equal(res.code,200);
    assert.equal(res.body.mode,'READ_ONLY_RUNTIME_SEED');
    assert.equal(res.body.writeAttempted,false);
    assert.equal(res.body.snapshot.positions.length,1);
    assert.equal(res.body.snapshot.orders.length,2);
    assert.equal(res.body.snapshot.standardOrders[0].reduceOnly,true);
    assert.equal(res.body.snapshot.algoOrders[0].type,'STOP_MARKET');
    assert.ok(res.body.snapshot.snapshotHash);
  }finally{h.restore()}
});
