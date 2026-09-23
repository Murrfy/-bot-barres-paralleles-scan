import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-only';

const {default:handler}=await import('../api/zenith-sync.js?whoami-rotation-test='+Date.now());

function response(){
  return {
    headers:{},
    setHeader(k,v){this.headers[k]=v},
    getHeader(k){return this.headers[k]},
    status(n){this.code=n;return this},
    json(body){this.body=body;return body},
  };
}

function legacyWhoami(){
  return {
    method:'GET',
    query:{action:'whoami'},
    headers:{authorization:'Bearer legacy-token'},
  };
}

test('legacy whoami rotates Bearer atomically and invalidates the old token',async()=>{
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
  let oldPresent=true;
  let migrationArgs=null;

  globalThis.fetch=async(url,init={})=>{
    assert.equal(url,'https://redis.test');
    const command=JSON.parse(init.body);
    let result=null;

    if(command[0]==='GET'&&command[1]===oldKey){
      result=oldPresent?JSON.stringify(record):null;
    }else if(command[0]==='GET'&&command[1]==='zenith:v1:role-device:controller'){
      result='iphone-12345678';
    }else if(command[0]==='EVAL'){
      migrationArgs=command;
      if(!oldPresent) result=0;
      else {
        oldPresent=false;
        result=1;
      }
    }else if(command[0]==='DEL'&&command[1]===oldKey){
      oldPresent=false;
      result=1;
    }

    return new Response(JSON.stringify({result}));
  };

  try{
    const first=response();
    await handler(legacyWhoami(),first);
    assert.equal(first.code,200);
    assert.equal(first.body.ok,true);
    assert.equal(first.body.device.deviceId,'iphone-12345678');
    assert.equal('token' in first.body,false);
    assert.ok(Array.isArray(first.headers['Set-Cookie']));
    const setCookie=String(first.headers['Set-Cookie'][0]);
    assert.ok(setCookie.includes('__Host-zenith_device='));
    assert.ok(setCookie.includes('HttpOnly'));
    assert.equal(setCookie.includes('legacy-token'),false);

    assert.ok(migrationArgs);
    assert.equal(migrationArgs[0],'EVAL');
    assert.equal(migrationArgs[3],oldKey);
    assert.notEqual(migrationArgs[4],oldKey);

    const second=response();
    await handler(legacyWhoami(),second);
    assert.equal(second.code,401);
    assert.equal(second.body.code,'LEGACY_SESSION_INVALID');
  }finally{
    globalThis.fetch=original;
  }
});
