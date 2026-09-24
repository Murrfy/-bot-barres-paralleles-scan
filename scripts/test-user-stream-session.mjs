import assert from 'node:assert/strict';
import test from 'node:test';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
process.env.BINANCE_API_KEY = 'api-key-test';
process.env.VERCEL_ENV = 'production';
process.env.VERCEL_GIT_COMMIT_REF = 'main';

const { default: handler } = await import('../api/binance-user-stream-session.js?test=' + Date.now());
const sessionKey = 'zenith:v1:binance-user-stream';

function response() {
  return {
    headers: {},
    setHeader(k,v){ this.headers[k]=v; },
    status(n){ this.code=n; return this; },
    json(body){ this.body=body; return body; },
  };
}

function harness({
  role='master',registered='master-1',lease='master-1',storedSession=null,rateCount=1,
  roleEpoch=Date.now()-1000,gateRoleEpoch=null,mutationLocked=false,
  leaseChangesAfterBinance=false,loseLockAfterBinance=false
}={}) {
  const original = globalThis.fetch;
  let session = storedSession;
  let lockToken = mutationLocked ? 'other-mutation' : '';
  const binanceCalls = [];
  globalThis.fetch = async (url, init={}) => {
    if (url === 'https://redis.test') {
      const c = JSON.parse(init.body);
      let result = null;
      if (c[0] === 'GET' && String(c[1]).includes(':device:')) {
        result = JSON.stringify({role,deviceId:role==='master'?'master-1':'controller-1',createdAt:Date.now()});
      } else if (c[0] === 'GET' && c[1] === 'zenith:v1:role-device:master') {
        result = registered;
      } else if (c[0] === 'GET' && c[1] === 'zenith:v1:master') {
        result = lease;
      } else if (c[0] === 'GET' && c[1] === 'zenith:v1:role-issued-at:master') {
        result = String(roleEpoch);
      } else if (c[0] === 'GET' && c[1] === sessionKey) {
        result = session ? JSON.stringify(session) : null;
      } else if (c[0] === 'SET' && c[1] === sessionKey) {
        session = JSON.parse(c[2]);
        result = 'OK';
      } else if (c[0] === 'DEL' && c[1] === sessionKey) {
        session = null;
        result = 1;
      } else if (c[0] === 'EVAL' && String(c[3] || '').includes(':rate:user-stream:')) {
        result = rateCount;
      } else if (c[0] === 'EVAL' && c[2] === '4' &&
                 c[3] === 'zenith:v1:role-device:master' &&
                 c[4] === 'zenith:v1:master' &&
                 c[6] === 'zenith:v1:binance-user-stream:mutation-lock') {
        const observedEpoch = gateRoleEpoch == null ? String(roleEpoch) : String(gateRoleEpoch);
        const isRenew = String(c[1] || '').includes("redis.call('EXPIRE', KEYS[4]");
        if (String(registered || '') !== String(c[7] || '') || String(lease || '') !== String(c[7] || '')) {
          result = -1;
        } else if (observedEpoch !== String(c[8] || '')) {
          result = -2;
        } else if (isRenew) {
          result = lockToken && lockToken === String(c[9] || '') ? 1 : -3;
        } else if (lockToken) {
          result = 0;
        } else {
          lockToken = String(c[9] || '');
          result = 1;
        }
      } else if (c[0] === 'EVAL' && c[2] === '5' &&
                 c[3] === 'zenith:v1:role-device:master' &&
                 c[4] === 'zenith:v1:master' &&
                 c[6] === 'zenith:v1:binance-user-stream:mutation-lock' &&
                 c[7] === sessionKey) {
        const observedEpoch = gateRoleEpoch == null ? String(roleEpoch) : String(gateRoleEpoch);
        if (String(registered || '') !== String(c[8] || '') || String(lease || '') !== String(c[8] || '')) {
          result = -1;
        } else if (observedEpoch !== String(c[9] || '')) {
          result = -2;
        } else if (!lockToken || lockToken !== String(c[10] || '')) {
          result = -3;
        } else if (String(c[11] || '') === 'DEL') {
          session = null;
          result = 1;
        } else {
          session = JSON.parse(c[12]);
          result = 1;
        }
      } else if (c[0] === 'EVAL' && c[2] === '1' &&
                 c[3] === 'zenith:v1:binance-user-stream:mutation-lock') {
        if (lockToken && lockToken === String(c[4] || '')) {
          lockToken = '';
          result = 1;
        } else {
          result = 0;
        }
      }
      return new Response(JSON.stringify({result}));
    }
    const u = new URL(url);
    assert.equal(u.origin, 'https://fapi.binance.com');
    assert.equal(u.pathname, '/fapi/v1/listenKey');
    assert.equal(init.headers['X-MBX-APIKEY'], 'api-key-test');
    binanceCalls.push(init.method);
    if (leaseChangesAfterBinance) lease = 'other-master';
    if (loseLockAfterBinance) lockToken = 'other-mutation';
    if (init.method === 'POST') return new Response(JSON.stringify({listenKey:'listen-abc'}));
    if (init.method === 'PUT') return new Response(JSON.stringify({listenKey:'listen-abc'}));
    if (init.method === 'DELETE') return new Response('{}');
    return new Response('{}',{status:405});
  };
  return {
    binanceCalls,
    get session(){ return session; },
    get mutationLocked(){ return Boolean(lockToken); },
    restore(){ globalThis.fetch=original; },
  };
}

function req(method,action){
  return {
    method,
    query:{action},
    headers:{cookie:'__Host-zenith_device=master-token',host:'zenith.test','x-forwarded-proto':'https',origin:'https://zenith.test'},
  };
}

test('only the current leased MASTER can start the stream', async()=>{
  for (const scenario of [
    {role:'controller',expected:401},
    {role:'master',registered:'other',expected:401},
    {role:'master',lease:'other',expected:409},
  ]) {
    const h=harness(scenario);
    try{
      const res=response();
      await handler(req('POST','start'),res);
      assert.equal(res.code,scenario.expected);
      assert.deepEqual(h.binanceCalls,[]);
    } finally { h.restore(); }
  }
});

test('start obtains listenKey with API key only and stores it server-side',async()=>{
  const h=harness();
  try{
    const res=response();
    await handler(req('POST','start'),res);
    assert.equal(res.code,200);
    assert.equal(res.body.ok,true);
    assert.equal(res.body.listenKey,'listen-abc');
    assert.deepEqual(h.binanceCalls,['POST']);
    assert.equal(h.session.listenKey,'listen-abc');
    assert.equal(h.session.masterDeviceId,'master-1');
    assert.equal(res.body.tradingWriteAttempted,false);
  }finally{h.restore();}
});

test('keepalive uses the server-held session and never needs a listenKey request parameter',async()=>{
  const now=Date.now();
  const h=harness({storedSession:{version:1,listenKey:'listen-abc',masterDeviceId:'master-1',startedAt:now,keepaliveAt:now}});
  try{
    const res=response();
    await handler(req('POST','keepalive'),res);
    assert.equal(res.code,200);
    assert.deepEqual(h.binanceCalls,['PUT']);
    assert.equal(res.body.tradingWriteAttempted,false);
    assert.equal('listenKey' in res.body,false);
    assert.ok(h.session.keepaliveDueAt>h.session.keepaliveAt);
  }finally{h.restore();}
});

test('keepalive fails closed without a server session',async()=>{
  const h=harness();
  try{
    const res=response();
    await handler(req('POST','keepalive'),res);
    assert.equal(res.code,409);
    assert.equal(res.body.code,'USER_STREAM_SESSION_REQUIRED');
    assert.deepEqual(h.binanceCalls,[]);
  }finally{h.restore();}
});

test('close invalidates Binance stream and removes server session',async()=>{
  const h=harness({storedSession:{version:1,listenKey:'listen-abc',masterDeviceId:'master-1'}});
  try{
    const res=response();
    await handler(req('POST','close'),res);
    assert.equal(res.code,200);
    assert.deepEqual(h.binanceCalls,['DELETE']);
    assert.equal(h.session,null);
  }finally{h.restore();}
});

test('status never exposes the listenKey',async()=>{
  const h=harness({storedSession:{version:1,listenKey:'listen-abc',masterDeviceId:'master-1',startedAt:1,keepaliveAt:2,expiresAt:3,keepaliveDueAt:4}});
  try{
    const res=response();
    await handler(req('GET','status'),res);
    assert.equal(res.code,200);
    assert.equal(res.body.active,true);
    assert.equal('listenKey' in res.body.session,false);
    assert.equal(res.body.session.hasListenKey,true);
    assert.deepEqual(h.binanceCalls,[]);
  }finally{h.restore();}
});


test('user-stream mutations are rate-limited before Binance',async()=>{
  const h=harness({rateCount:13});
  try{
    const res=response();
    await handler(req('POST','start'),res);
    assert.equal(res.code,429);
    assert.equal(res.body.code,'USER_STREAM_RATE_LIMIT');
    assert.ok(Number(res.headers['Retry-After'])>=1);
    assert.deepEqual(h.binanceCalls,[]);
  }finally{h.restore();}
});


test('concurrent user-stream mutation is fenced before Binance',async()=>{
  const h=harness({mutationLocked:true});
  try{
    const res=response();
    await handler(req('POST','start'),res);
    assert.equal(res.code,409);
    assert.equal(res.body.code,'USER_STREAM_MUTATION_BUSY');
    assert.deepEqual(h.binanceCalls,[]);
  }finally{h.restore();}
});

test('MASTER role-epoch change is fenced before Binance user-stream mutation',async()=>{
  const baseEpoch=Date.now()-1000;
  const h=harness({roleEpoch:baseEpoch,gateRoleEpoch:baseEpoch+1});
  try{
    const res=response();
    await handler(req('POST','start'),res);
    assert.equal(res.code,409);
    assert.equal(res.body.code,'MASTER_ROLE_CHANGED');
    assert.deepEqual(h.binanceCalls,[]);
  }finally{h.restore();}
});

test('MASTER lease loss after Binance response blocks stale user-stream session commit',async()=>{
  const h=harness({leaseChangesAfterBinance:true});
  try{
    const res=response();
    await handler(req('POST','start'),res);
    assert.equal(res.code,409);
    assert.equal(res.body.code,'MASTER_LEASE_REQUIRED');
    assert.deepEqual(h.binanceCalls,['POST']);
    assert.equal(h.session,null);
  }finally{h.restore();}
});

test('mutation lock loss after Binance response blocks stale user-stream session commit',async()=>{
  const h=harness({loseLockAfterBinance:true});
  try{
    const res=response();
    await handler(req('POST','start'),res);
    assert.equal(res.code,409);
    assert.equal(res.body.code,'USER_STREAM_MUTATION_LOCK_LOST');
    assert.deepEqual(h.binanceCalls,['POST']);
    assert.equal(h.session,null);
  }finally{h.restore();}
});

test('user-stream mutation lock is released after a successful Binance mutation',async()=>{
  const h=harness();
  try{
    const res=response();
    await handler(req('POST','start'),res);
    assert.equal(res.code,200);
    assert.equal(h.mutationLocked,false);
  }finally{h.restore();}
});
