import test from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
process.env.BINANCE_API_KEY = 'api-key-test';
process.env.BINANCE_API_SECRET = 'secret';

const { default: handler } = await import('../api/binance-read.js?rate-test=' + Date.now());

function response() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = String(v); },
    status(n) { this.code = n; return this; },
    json(body) { this.body = body; return body; },
  };
}

function request() {
  return { method: 'GET', headers: { cookie: '__Host-zenith_device=controller-token' } };
}

function harness({ rateCount = 1, redisFailure = false } = {}) {
  const original = globalThis.fetch;
  let binanceCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    if (url === 'https://redis.test') {
      if (redisFailure) return new Response('{}', { status: 503 });
      const command = JSON.parse(init.body);
      let result = null;
      if (command[0] === 'GET' && String(command[1]).includes(':device:')) {
        result = JSON.stringify({ role: 'controller', deviceId: 'controller-1', createdAt: Date.now() });
      } else if (command[0] === 'GET' && command[1] === 'zenith:v1:role-device:controller') {
        result = 'controller-1';
      } else if (command[0] === 'EVAL') {
        result = rateCount;
      }
      return new Response(JSON.stringify({ result }));
    }

    binanceCalls++;
    const path = new URL(url).pathname;
    if (path === '/fapi/v1/time') {
      return new Response(JSON.stringify({ serverTime: 1700000000000 }));
    }
    if (path === '/fapi/v3/balance') {
      return new Response(JSON.stringify([{ asset: 'USDT', balance: '1000', availableBalance: '900' }]));
    }
    if (path === '/fapi/v3/positionRisk') return new Response('[]');
    if (path === '/fapi/v3/account') return new Response(JSON.stringify({ totalWalletBalance: '1000', availableBalance: '900' }));
    if (path === '/fapi/v1/openOrders') return new Response('[]');
    if (path === '/fapi/v1/openAlgoOrders') return new Response('[]');
    return new Response('{}', { status: 404 });
  };

  return {
    get binanceCalls() { return binanceCalls; },
    restore() { globalThis.fetch = original; },
  };
}

test('authenticated Binance reads stay available below the server rate limit', async () => {
  const h = harness({ rateCount: 1 });
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 200);
    assert.equal(res.body.ok, true);
    assert.equal(h.binanceCalls, 6);
  } finally {
    h.restore();
  }
});

test('rate-limited device is rejected before any Binance request', async () => {
  const h = harness({ rateCount: 13 });
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 429);
    assert.equal(res.body.code, 'BINANCE_READ_RATE_LIMIT');
    assert.ok(Number(res.headers['Retry-After']) >= 1);
    assert.equal(h.binanceCalls, 0);
  } finally {
    h.restore();
  }
});

test('rate-limit backend failure fails closed before Binance', async () => {
  const h = harness({ redisFailure: true });
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 503);
    assert.equal(h.binanceCalls, 0);
  } finally {
    h.restore();
  }
});
