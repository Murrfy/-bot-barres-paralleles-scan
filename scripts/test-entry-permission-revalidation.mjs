import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-only';
process.env.BINANCE_TRADING_API_KEY='api-key-test';
process.env.BINANCE_TRADING_API_SECRET='secret';
process.env.VERCEL_GIT_COMMIT_SHA='sha-prod';

const {default:handler}=await import('../api/binance-entry-execute.js?permission-revalidation-test='+Date.now());

function stableStringify(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>v===undefined?'null':stableStringify(v)).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableStringify(value[k])).join(',')+'}';
}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}

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
    headers:{
      cookie:'__Host-zenith_device=master-token',
      host:'zenith.test',
      'x-forwarded-proto':'https',
      origin:'https://zenith.test',
    },
    body:{
      type:'EXEC_OPEN_POSITION',
      commandId:'cmd-permission-001',
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

function safePermission(overrides={}){
  return {
    ipRestrict:true,
    enableReading:true,
    enableWithdrawals:false,
    enableInternalTransfer:false,
    enableMargin:false,
    enableFutures:true,
    permitsUniversalTransfer:false,
    enableVanillaOptions:false,
    enableFixApiTrade:false,
    enableSpotAndMarginTrading:false,
    enablePortfolioMarginTrading:false,
    ...overrides,
  };
}

function runtimeFixtures(){
  const data={
    executionMode:'REAL',
    userStream:{
      connected:true,
      ready:true,
      failClosed:false,
      needsReconciliation:false,
    },
  };
  return {
    runtime:JSON.stringify({
      updatedAt:Date.now(),
      masterDeviceId:'master-1',
      data,
    }),
    report:JSON.stringify({
      version:2,
      status:'CLEAN_REAL',
      failClosed:false,
      reasons:[],
      observedAt:Date.now(),
      runtimeDataHash:sha256(stableStringify(data)),
    }),
    arm:JSON.stringify({
      version:1,
      masterDeviceId:'master-1',
      deploymentSha:'sha-prod',
    }),
  };
}

function harness({permission=safePermission(),permissionHttpStatus=200}={}){
  const original=globalThis.fetch;
  const fx=runtimeFixtures();
  let futuresCalls=0;
  let permissionCalls=0;

  globalThis.fetch=async(url,init={})=>{
    if(url==='https://redis.test'){
      const cmd=JSON.parse(init.body);
      let result=null;
      if(cmd[0]==='GET'){
        if(String(cmd[1]).includes(':device:')){
          result=JSON.stringify({role:'master',deviceId:'master-1',createdAt:Date.now()});
        }else if(cmd[1]==='zenith:v1:role-device:master'){
          result='master-1';
        }else if(cmd[1]==='zenith:v1:role-issued-at:master'){
          result=String(Date.now()-1000);
        }else if(cmd[1]==='zenith:v1:master'){
          result='master-1';
        }else if(cmd[1]==='zenith:v1:state'){
          result=fx.runtime;
        }else if(cmd[1]==='zenith:v1:reconcile:last'){
          result=fx.report;
        }else if(cmd[1]==='zenith:v1:safety:real-execution-armed'){
          result=fx.arm;
        }else if(cmd[1]==='zenith:v1:master-mode'){
          result='RUNNING';
        }else if(cmd[1]==='zenith:v1:safety:emergency-stop'){
          result='0';
        }
      }else if(cmd[0]==='EVAL'&&String(cmd[3]||'').includes(':rate:entry-execution:')){
        result=1;
      }
      return new Response(JSON.stringify({result}));
    }

    const u=new URL(url);
    if(u.origin==='https://api.binance.com'){
      permissionCalls++;
      if(u.pathname==='/api/v3/time'){
        return new Response(JSON.stringify({serverTime:Date.now()}));
      }
      if(u.pathname==='/sapi/v1/account/apiRestrictions'){
        return new Response(
          permissionHttpStatus===200?JSON.stringify(permission):JSON.stringify({code:-1000,msg:'permission check failed'}),
          {status:permissionHttpStatus}
        );
      }
      throw new Error('Unexpected Binance permission path: '+u.pathname);
    }

    if(u.origin==='https://fapi.binance.com'){
      futuresCalls++;
      throw new Error('Futures API must not be reached when permission revalidation blocks');
    }

    throw new Error('Unexpected external request: '+url);
  };

  return {
    get futuresCalls(){return futuresCalls},
    get permissionCalls(){return permissionCalls},
    restore(){globalThis.fetch=original},
  };
}

test('unsafe trading-key permissions block a new real entry before Futures preflight',async()=>{
  const h=harness({permission:safePermission({ipRestrict:false,enableWithdrawals:true})});
  try{
    const res=response();
    await handler(request(),res);
    assert.equal(res.code,423);
    assert.equal(res.body.code,'BINANCE_API_PERMISSION_REVALIDATION_BLOCKED');
    assert.ok(res.body.blockers.includes('BINANCE_API_IP_RESTRICTION_REQUIRED'));
    assert.ok(res.body.blockers.includes('BINANCE_API_WITHDRAWALS_MUST_BE_DISABLED'));
    assert.equal(res.body.writeAttempted,false);
    assert.equal(h.permissionCalls,2);
    assert.equal(h.futuresCalls,0);
  }finally{h.restore()}
});

test('unavailable trading-key permission check fails closed before Futures preflight',async()=>{
  const h=harness({permissionHttpStatus:503});
  try{
    const res=response();
    await handler(request(),res);
    assert.equal(res.code,503);
    assert.equal(res.body.code,'BINANCE_API_PERMISSION_REVALIDATION_FAILED');
    assert.equal(res.body.writeAttempted,false);
    assert.equal(h.permissionCalls,2);
    assert.equal(h.futuresCalls,0);
  }finally{h.restore()}
});
