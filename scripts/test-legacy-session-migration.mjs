import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-only';

const {default:handler}=await import('../api/zenith-sync.js?legacy-migration-test='+Date.now());

function response(){
  return {
    headers:{},
    setHeader(k,v){this.headers[k]=v},
    getHeader(k){return this.headers[k]},
    status(n){this.code=n;return this},
    json(body){this.body=body;return body},
  };
}

function legacyRequest(){
  return {
    method:'POST',
    query:{action:'session-migrate'},
    headers:{
      authorization:'Bearer legacy-token',
      host:'zenith.test',
      'x-forwarded-proto':'https',
      origin:'https://zenith.test',
    },
  };
}

test('legacy Bearer migration rotates the token and normal Bearer auth is then rejected',async()=>{
  const original=globalThis.fetch;
  const legacyHash=crypto.createHash('sha256').update('legacy-token').digest('hex');
  const oldKey='zenith:v1:device:'+legacyHash;
  const record={
    deviceId:'iphone-12345678',
    role:'controller',
    deviceName:'iPhone',
    createdAt:Date.now()-1000,
    lastSeenAt:Date.now()-1000,
  };
  let migrationArgs=null;

  globalThis.fetch=async(url,init={})=>{
    assert.equal(url,'https://redis.test');
    const command=JSON.parse(init.body);
    let result=null;
    if(command[0]==='GET'&&command[1]===oldKey)result=JSON.stringify(record);
    else if(command[0]==='GET'&&command[1]==='zenith:v1:role-device:controller')result='iphone-12345678';
    else if(command[0]==='EVAL'){
      migrationArgs=command;
      result=1;
    }
    return new Response(JSON.stringify({result}));
  };

  try{
    const res=response();
    await handler(legacyRequest(),res);
    assert.equal(res.code,200);
    assert.equal(res.body.ok,true);
    assert.equal(res.body.sessionReady,true);
    assert.equal(res.body.migrated,true);
    assert.equal('token' in res.body,false);
    assert.ok(Array.isArray(res.headers['Set-Cookie']));
    assert.ok(String(res.headers['Set-Cookie'][0]).includes('__Host-zenith_device='));
    assert.ok(String(res.headers['Set-Cookie'][0]).includes('HttpOnly'));
    assert.ok(migrationArgs);
    assert.equal(migrationArgs[3],oldKey);
    assert.notEqual(migrationArgs[4],oldKey);

    const bearerOnly=response();
    await handler({
      method:'GET',
      query:{action:'whoami'},
      headers:{authorization:'Bearer legacy-token'},
    },bearerOnly);
    assert.equal(bearerOnly.code,401);
    assert.equal(bearerOnly.body.code,'UNAUTHORIZED_DEVICE');
  }finally{
    globalThis.fetch=original;
  }
});
