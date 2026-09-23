import assert from 'node:assert/strict';
import test from 'node:test';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
process.env.BINANCE_API_KEY = 'api-key-test';

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

function harness({role='master',registered='master-1',lease='master-1',storedSession=null,rateCount=1}={}) {
  const original = globalThis.fetch;
  let session = storedSession;
  const binanceCalls = [];
  globalThis.fetch = async (url, init={}) => {
    if (url === 'https://redis.test') {
      const c = JSON.parse(init.body);
      let result = null;
      if (c[0] === 'GET' && String(c[1]).includes(':device:')) {
        result = JSON.stringify({role,deviceId:role==='master'?'master-1':'controller-1'});
      } else if (c[0] === 'GET' && c[1] === 'zenith:v1:role-device:master') {
        result = registered;
      } else if (c[0] === 'GET' && c[1] === 'zenith:v1:master') {
        result = lease;
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
      }
      return new Response(JSON.stringify({result}));
    }
    const u = new URL(url);
    assert.equal(u.origin, 'https://fapi.binance.com');
    assert.equal(u.pathname, '/fapi/v1/listenKey');
    assert.equal(init.headers['X-MBX-APIKEY'], 'api-key-test');
    binanceCalls.push(init.method);
    if (init.method === 'POST') return new Response(JSON.stringify({listenKey:'listen-abc'}));
    if (init.method === 'PUT') return new Response(JSON.stringify({listenKey:'listen-abc'}));
    if (init.method === 'DELETE') return new Response('{}');
    return new Response('{}',{status:405});
  };
  return {
    binanceCalls,
    get session(){ return session; },
    restore(){ globalThis.fetch=original; },
  };
}

function req(method,action){
  return {
    method,
    query:{action},
    headers:{authorization:'Bearer master-token'},
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
