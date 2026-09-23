import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.UPSTASH_REDIS_REST_URL='https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN='test-only';

const { default: handler } = await import('../api/zenith-sync.js?legacy-rotation-test=' + Date.now());

const legacyToken='legacy-token-for-migration-test';
const legacyHash=crypto.createHash('sha256').update(legacyToken).digest('hex');
const legacyKey='zenith:v1:device:'+legacyHash;
const record=JSON.stringify({
  deviceId:'iphone-controller-1',
  role:'controller',
  deviceName:'iPhone contrôleur Zenith',
  createdAt:Date.now()-60_000,
  lastSeenAt:Date.now()-30_000,
});

function response(){
  return {
    headers:{},
    getHeader(k){return this.headers[k]},
    setHeader(k,v){this.headers[k]=v},
    status(n){this.code=n;return this},
    json(body){this.body=body;return body},
  };
}

function request(){
  return {
    method:'GET',
    query:{action:'whoami'},
    headers:{authorization:'Bearer '+legacyToken},
  };
}

test('legacy Bearer migration rotates the token and invalidates the old credential',async()=>{
  const originalFetch=globalThis.fetch;
  let legacyActive=true;
  let rotatedKey='';
  let rotatedRaw='';
  const commands=[];

  globalThis.fetch=async(url,init={})=>{
    assert.equal(url,'https://redis.test');
    const command=JSON.parse(init.body);
    commands.push(command);
    let result=null;

    if(command[0]==='GET'&&command[1]===legacyKey){
      result=legacyActive?record:null;
    }else if(command[0]==='GET'&&command[1]==='zenith:v1:role-device:controller'){
      result='iphone-controller-1';
    }else if(command[0]==='EVAL'){
      assert.equal(command[2],'2');
      assert.equal(command[3],legacyKey);
      rotatedKey=String(command[4]||'');
      rotatedRaw=String(command[6]||'');
      legacyActive=false;
      result=1;
    }

    return new Response(JSON.stringify({result}));
  };

  try{
    const first=response();
    await handler(request(),first);
    assert.equal(first.code,200);
    assert.equal(first.body.ok,true);
    assert.equal(first.body.device.role,'controller');

    const setCookie=Array.isArray(first.headers['Set-Cookie'])
      ? first.headers['Set-Cookie'].join('; ')
      : String(first.headers['Set-Cookie']||'');
    assert.match(setCookie,/__Host-zenith_device=/);
    assert.equal(setCookie.includes(legacyToken),false);
    assert.match(rotatedKey,/^zenith:v1:device:[a-f0-9]{64}$/);
    assert.notEqual(rotatedKey,legacyKey);
    assert.match(rotatedRaw,/"deviceId":"iphone-controller-1"/);

    const second=response();
    await handler(request(),second);
    assert.equal(second.code,401);
    assert.equal(second.body.code,'UNAUTHORIZED_DEVICE');

    const evalCount=commands.filter(command=>command[0]==='EVAL').length;
    assert.equal(evalCount,1);
  }finally{
    globalThis.fetch=originalFetch;
  }
});
