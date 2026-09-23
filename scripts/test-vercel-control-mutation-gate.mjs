import test from 'node:test';
import assert from 'node:assert/strict';

test('Vercel preview cannot mutate Zenith central control state', async () => {
  const previousEnv = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;

  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_REF = 'feature-test';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';

  globalThis.fetch = async () => {
    externalCalls++;
    throw new Error('Preview mutation gate must reject before Redis/Binance');
  };

  try {
    const { default: handler } = await import('../api/zenith-sync.js?preview-control-gate=' + Date.now());
    const req = {
      method: 'POST',
      query: { action: 'pair' },
      headers: {
        host: 'preview.zenith.test',
        'x-forwarded-proto': 'https',
        origin: 'https://preview.zenith.test',
        'content-length': '2',
      },
      body: {},
    };
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(n) { this.code = n; return this; },
      json(body) { this.body = body; return body; },
    };

    await handler(req, res);
    assert.equal(res.code, 423);
    assert.equal(res.body.code, 'NON_PRODUCTION_CONTROL_MUTATION');
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
