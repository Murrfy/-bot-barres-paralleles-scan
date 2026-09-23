import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-only';

const {default:handler}=await import('../api/zenith-sync.js?one-shot-bearer='+Date.now());

const PREFIX='zenith:v1';
const oldToken='legacy-bearer-token-1234567890';
const oldHash=crypto.createHash('sha256').update(oldToken).digest('hex');
const oldKey=`${PREFIX}:device:${oldHash}`;
const roleKey=`${PREFIX}:role-device:controller`;
const createdAt=Date.now()-60_000;

function response(){
  const headers=new Map();
  return {
    code:0,
    body:null,
    setHeader(k,v){headers.set(String(k).toLowerCase(),v)},
    getHeader(k){return headers.get(String(k).toLowerCase())},
    status(n){this.code=n;return this},
    json(body){this.body=body;return body},
  };
}

function request(headers={}){
  return {
    method:'GET',
    query:{action:'whoami'},
    headers:{
      host:'zenithfinal3-ahle.vercel.app',
      'x-forwarded-proto':'https',
      ...headers,
    },
  };
}

function extractCookieToken(res){
  const rows=Array.isArray(res.getHeader('set-cookie'))
    ? res.getHeader('set-cookie')
    : [res.getHeader('set-cookie')].filter(Boolean);
  const row=rows.find(v=>String(v).startsWith('__Host-zenith_device='));
  if(!row)return '';
  const encoded=String(row).split(';')[0].split('=').slice(1).join('=');
  return decodeURIComponent(encoded);
}

test('legacy Bearer whoami rotates to a fresh cookie and invalidates the old token',async()=>{
  const store=new Map([
    [oldKey,JSON.stringify({
      deviceId:'controller-12345678',
      role:'controller',
      deviceName:'Legacy iPhone',
      createdAt,
      lastSeenAt:createdAt,
    })],
    [roleKey,'controller-12345678'],
  ]);

  const original=globalThis.fetch;
  globalThis.fetch=async(url,init={})=>{
    assert.equal(url,'https://redis.test');
    const c=JSON.parse(init.body);
    let result=null;

    if(c[0]==='GET'){
      result=store.has(c[1])?store.get(c[1]):null;
    }else if(c[0]==='SET'){
      store.set(c[1],c[2]);
      result='OK';
    }else if(c[0]==='DEL'){
      result=store.delete(c[1])?1:0;
    }else if(c[0]==='EVAL'&&String(c[1]).includes("local currentRole")){
      const oldSessionKey=c[3];
      const newSessionKey=c[4];
      const currentRoleKey=c[5];
      const expectedDeviceId=String(c[6]);
      const updatedRecord=String(c[7]);

      if(String(store.get(currentRoleKey)||'')!==expectedDeviceId){
        result=-1;
      }else if(!store.has(oldSessionKey)){
        result=0;
      }else{
        store.set(newSessionKey,updatedRecord);
        store.delete(oldSessionKey);
        result=1;
      }
    }else{
      throw new Error('Unexpected Redis command: '+JSON.stringify(c));
    }

    return new Response(JSON.stringify({result}));
  };

  try{
    const first=response();
    await handler(request({authorization:'Bearer '+oldToken}),first);
    assert.equal(first.code,200);
    assert.equal(first.body?.ok,true);

    const newToken=extractCookieToken(first);
    assert.ok(newToken);
    assert.notEqual(newToken,oldToken);
    assert.equal(store.has(oldKey),false);

    const newHash=crypto.createHash('sha256').update(newToken).digest('hex');
    const newKey=`${PREFIX}:device:${newHash}`;
    assert.equal(store.has(newKey),true);

    const replay=response();
    await handler(request({authorization:'Bearer '+oldToken}),replay);
    assert.equal(replay.code,401);
    assert.equal(replay.body?.code,'UNAUTHORIZED_DEVICE');

    const cookieSession=response();
    await handler(request({cookie:'__Host-zenith_device='+encodeURIComponent(newToken)}),cookieSession);
    assert.equal(cookieSession.code,200);
    assert.equal(cookieSession.body?.ok,true);
  }finally{
    globalThis.fetch=original;
  }
});
