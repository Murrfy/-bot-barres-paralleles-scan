import test from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
process.env.BINANCE_API_KEY = 'api-key-test';
process.env.BINANCE_API_SECRET = 'secret';

const { default: handler } = await import('../api/binance-entry-preflight.js?auth-test=' + Date.now());

function response() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = String(v); },
    status(n) { this.code = n; return this; },
    json(body) { this.body = body; return body; },
  };
}

function request() {
  return {
    method: 'GET',
    headers: { authorization: 'Bearer test-device' },
    query: { symbol: '', margin: '', leverage: '', maxLoss: '' },
  };
}

function harness({ role = 'master', registered = 'master-1', lease = 'master-1' } = {}) {
  const original = globalThis.fetch;
  let externalCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    if (url === 'https://redis.test') {
      const command = JSON.parse(init.body);
      let result = null;
      if (command[0] === 'GET' && String(command[1]).includes(':device:')) {
        result = JSON.stringify({ role, deviceId: role === 'master' ? 'master-1' : 'controller-1' });
      } else if (command[0] === 'GET' && command[1] === 'zenith:v1:role-device:master') {
        result = registered;
      } else if (command[0] === 'GET' && command[1] === 'zenith:v1:master') {
        result = lease;
      }
      return new Response(JSON.stringify({ result }));
    }
    externalCalls++;
    return new Response('{}', { status: 500 });
  };

  return {
    get externalCalls() { return externalCalls; },
    restore() { globalThis.fetch = original; },
  };
}

test('controller cannot call entry preflight HTTP endpoint', async () => {
  const h = harness({ role: 'controller' });
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 401);
    assert.equal(res.body.code, 'MASTER_REQUIRED');
    assert.equal(h.externalCalls, 0);
  } finally { h.restore(); }
});

test('replaced MASTER cannot call entry preflight HTTP endpoint', async () => {
  const h = harness({ registered: 'other-master' });
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 401);
    assert.equal(res.body.code, 'MASTER_REQUIRED');
    assert.equal(h.externalCalls, 0);
  } finally { h.restore(); }
});

test('MASTER without active lease cannot call entry preflight HTTP endpoint', async () => {
  const h = harness({ lease: 'other-master' });
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 409);
    assert.equal(res.body.code, 'MASTER_LEASE_REQUIRED');
    assert.equal(h.externalCalls, 0);
  } finally { h.restore(); }
});

test('current leased MASTER reaches preflight request validation', async () => {
  const h = harness();
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 400);
    assert.equal(res.body.code, 'PREFLIGHT_REQUEST_INVALID');
    assert.equal(h.externalCalls, 0);
  } finally { h.restore(); }
});
