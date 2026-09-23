import assert from 'node:assert/strict';
import test from 'node:test';

const originalEnv={
  VERCEL_ENV:process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_REF:process.env.VERCEL_GIT_COMMIT_REF,
  UPSTASH_REDIS_REST_URL:process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN:process.env.UPSTASH_REDIS_REST_TOKEN,
};
const originalFetch=globalThis.fetch;

function restore(){
  for(const [k,v] of Object.entries(originalEnv)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  globalThis.fetch=originalFetch;
}
function res(){
  return{headers:{},setHeader(k,v){this.headers[k]=String(v)},status(n){this.code=n;return this},json(b){this.body=b;return b}};
}
function headers(host='zenith.test'){
  return{host,origin:'https://'+host,'x-forwarded-proto':'https','content-length':'2'};
}
async function syncHandler(env,ref){
  process.env.VERCEL_ENV=env;
  process.env.VERCEL_GIT_COMMIT_REF=ref;
  process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN='test-only';
  return (await import('../api/zenith-sync.js?preview-v3='+env+'-'+ref+'-'+Date.now())).default;
}

test('Vercel preview blocks Zenith POST before Redis/Binance',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('external call forbidden')};
  try{
    const handler=await syncHandler('preview','feature-test');
    const out=res();
    await handler({method:'POST',query:{action:'pair'},headers:headers('preview.zenith.test'),body:{}},out);
    assert.equal(out.code,423);
    assert.equal(out.body.code,'NON_PRODUCTION_CONTROL_MUTATION');
    assert.equal(calls,0);
  }finally{restore()}
});

test('production deployment from non-main blocks Zenith POST before external access',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('external call forbidden')};
  try{
    const handler=await syncHandler('production','feature-test');
    const out=res();
    await handler({method:'POST',query:{action:'pair'},headers:headers(),body:{}},out);
    assert.equal(out.code,423);
    assert.equal(out.body.code,'NON_PRODUCTION_CONTROL_MUTATION');
    assert.equal(calls,0);
  }finally{restore()}
});

test('development and production main pass the central mutation environment gate',async()=>{
  for(const [env,ref] of [['development','feature-test'],['production','main']]){
    let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('health action should not call external services')};
    try{
      const handler=await syncHandler(env,ref);
      const out=res();
      await handler({method:'POST',query:{action:'health'},headers:headers(),body:{}},out);
      assert.notEqual(out.body?.code,'NON_PRODUCTION_CONTROL_MUTATION');
      assert.equal(out.code,404);
      assert.equal(calls,0);
    }finally{restore()}
  }
});

test('Vercel preview blocks reconciliation persistence before auth or external access',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('external call forbidden')};
  try{
    process.env.VERCEL_ENV='preview';
    process.env.VERCEL_GIT_COMMIT_REF='feature-test';
    process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN='test-only';
    const handler=(await import('../api/binance-reconcile.js?preview-v3='+Date.now())).default;
    const out=res();
    await handler({method:'POST',headers:headers('preview.zenith.test'),body:{}},out);
    assert.equal(out.code,423);
    assert.equal(out.body.code,'NON_PRODUCTION_CONTROL_MUTATION');
    assert.equal(calls,0);
  }finally{restore()}
});

test.after(restore);
