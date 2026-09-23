import assert from 'node:assert/strict';
import test from 'node:test';

const originalEnv={
  VERCEL_ENV:process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_REF:process.env.VERCEL_GIT_COMMIT_REF,
  UPSTASH_REDIS_REST_URL:process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN:process.env.UPSTASH_REDIS_REST_TOKEN,
};
const originalFetch=globalThis.fetch;

function restoreEnv(){
  for(const [key,value] of Object.entries(originalEnv)){
    if(value===undefined) delete process.env[key];
    else process.env[key]=value;
  }
  globalThis.fetch=originalFetch;
}

function response(){
  return {
    headers:{},
    setHeader(k,v){this.headers[k]=String(v)},
    status(n){this.code=n;return this},
    json(body){this.body=body;return body},
  };
}

function sameOriginHeaders(host='zenith.test'){
  return {
    host,
    origin:'https://'+host,
    'x-forwarded-proto':'https',
    'content-length':'2',
  };
}

async function loadSync(env,ref='feature-test'){
  process.env.VERCEL_ENV=env;
  process.env.VERCEL_GIT_COMMIT_REF=ref;
  process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN='test-only';
  return (await import('../api/zenith-sync.js?preview-gate='+env+'-'+ref+'-'+Date.now())).default;
}

test('Vercel preview rejects Zenith POST mutations before Redis/Binance',async()=>{
  let externalCalls=0;
  globalThis.fetch=async()=>{externalCalls++;throw new Error('preview must fail before external access')};
  try{
    const handler=await loadSync('preview','feature-test');
    const res=response();
    await handler({method:'POST',query:{action:'pair'},headers:sameOriginHeaders('preview.zenith.test'),body:{}},res);
    assert.equal(res.code,423);
    assert.equal(res.body.code,'NON_PRODUCTION_CONTROL_MUTATION');
    assert.equal(externalCalls,0);
  }finally{restoreEnv()}
});

test('Vercel production deployment from a non-main ref rejects Zenith mutations',async()=>{
  let externalCalls=0;
  globalThis.fetch=async()=>{externalCalls++;throw new Error('non-main production must fail before external access')};
  try{
    const handler=await loadSync('production','feature-test');
    const res=response();
    await handler({method:'POST',query:{action:'pair'},headers:sameOriginHeaders(),body:{}},res);
    assert.equal(res.code,423);
    assert.equal(res.body.code,'NON_PRODUCTION_CONTROL_MUTATION');
    assert.equal(externalCalls,0);
  }finally{restoreEnv()}
});

test('development and production main are not rejected by the preview mutation gate',async()=>{
  for(const [env,ref] of [['development','feature-test'],['production','main']]){
    let externalCalls=0;
    globalThis.fetch=async()=>{externalCalls++;throw new Error('health POST should not need external access')};
    try{
      const handler=await loadSync(env,ref);
      const res=response();
      await handler({method:'POST',query:{action:'health'},headers:sameOriginHeaders(),body:{}},res);
      assert.notEqual(res.body?.code,'NON_PRODUCTION_CONTROL_MUTATION');
      assert.equal(res.code,404);
      assert.equal(externalCalls,0);
    }finally{restoreEnv()}
  }
});

test('Vercel preview rejects reconciliation persistence before authentication or external access',async()=>{
  let externalCalls=0;
  globalThis.fetch=async()=>{externalCalls++;throw new Error('preview reconciliation must fail before external access')};
  try{
    process.env.VERCEL_ENV='preview';
    process.env.VERCEL_GIT_COMMIT_REF='feature-test';
    process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN='test-only';
    const handler=(await import('../api/binance-reconcile.js?preview-gate='+Date.now())).default;
    const res=response();
    await handler({method:'POST',headers:sameOriginHeaders('preview.zenith.test'),body:{}},res);
    assert.equal(res.code,423);
    assert.equal(res.body.code,'NON_PRODUCTION_CONTROL_MUTATION');
    assert.equal(externalCalls,0);
  }finally{restoreEnv()}
});

test.after(restoreEnv);
