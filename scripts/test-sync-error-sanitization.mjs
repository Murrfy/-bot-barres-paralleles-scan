import assert from 'node:assert/strict';
import test from 'node:test';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-only';

const {default:handler}=await import('../api/zenith-sync.js?sanitize-sync-errors='+Date.now());

function response(){
  return {
    setHeader(){},
    status(n){this.code=n;return this},
    json(body){this.body=body;return body},
  };
}

test('Zenith sync does not expose internal Redis error messages to the browser',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(url)=>{
    if(url==='https://redis.test'){
      return new Response(JSON.stringify({error:'INTERNAL_REDIS_DETAIL_SHOULD_NOT_LEAK'}),{status:503});
    }
    throw new Error('Unexpected external request');
  };
  try{
    const res=response();
    await handler({
      method:'GET',
      query:{action:'master'},
      headers:{authorization:'Bearer test-device'},
    },res);
    assert.equal(res.code,500);
    assert.equal(res.body.code,'REDIS_ERROR');
    assert.equal(res.body.error,'Zenith sync unavailable.');
    assert.doesNotMatch(JSON.stringify(res.body),/INTERNAL_REDIS_DETAIL_SHOULD_NOT_LEAK/);
  }finally{
    globalThis.fetch=original;
  }
});
