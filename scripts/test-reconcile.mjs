import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import crypto from 'node:crypto';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
process.env.BINANCE_API_KEY = 'test-only';
process.env.BINANCE_API_SECRET = 'test-only';
const source = fs.readFileSync('api/binance-reconcile.js', 'utf8').replace(
  /^import \{ deviceTokenCandidates \} from '\.\.\/lib\/device-session\.mjs';\n/m,
  "const deviceTokenCandidates = req => { const h=String(req?.headers?.authorization||''); const t=h.startsWith('Bearer ')?h.slice(7).trim():''; return t?[t]:[]; };\n"
);
const { default: handler, reconcile, normalizeActualPosition, normalizeActualOrder } = await import(
  'data:text/javascript;base64,' + Buffer.from(source + '\nexport { reconcile, normalizeActualPosition, normalizeActualOrder };').toString('base64')
);
const runtime = (positions = [], orders = [], mode = 'REAL') => ({
  updatedAt: Date.now(), data: { executionMode: mode, binancePositions: positions, binanceOrders: orders },
});
const position = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '1' };
const stop = { symbol: 'BTCUSDT', positionSide: 'BOTH', side: 'SELL', type: 'STOP_MARKET',
  orderId: 42, origQty: '1', executedQty: '0', reduceOnly: true, closePosition: false };
const normalized = normalizeActualPosition(position);
const normalizedStop = normalizeActualOrder(stop);

test('fresh simulation with empty Binance inventory is clean', () => {
  assert.equal(reconcile(runtime([], [], 'SIMULATION'), [], []).status, 'CLEAN_IDLE');
});
test('missing or stale runtime never certifies clean', () => {
  assert.equal(reconcile(null, [], []).failClosed, true);
  const old = runtime(); old.updatedAt -= 31000;
  assert.equal(reconcile(old, [], []).failClosed, true);
});
test('unknown Binance activity blocks simulation', () => {
  assert.equal(reconcile(runtime([], [], 'SIMULATION'), [normalized], []).failClosed, true);
});
test('matching position and closing stop are reconciled', () => {
  assert.equal(reconcile(runtime([position], [stop]), [normalized], [normalizedStop]).failClosed, false);
});
test('quantity changes and missing positions block', () => {
  assert.ok(reconcile(runtime([{ ...position, positionAmt: '2' }], [stop]), [normalized], [normalizedStop]).reasons.includes('BINANCE_POSITION_QUANTITY_MISMATCH'));
  assert.ok(reconcile(runtime([position]), [], []).reasons.includes('MISSING_BINANCE_POSITION'));
});
test('missing protection blocks even if runtime did not declare it', () => {
  assert.ok(reconcile(runtime([position]), [normalized], []).reasons.includes('MISSING_BINANCE_PROTECTION'));
});
test('string false is not a reduce-only protection', () => {
  const unsafe = normalizeActualOrder({ ...stop, reduceOnly: 'false' });
  assert.equal(unsafe.reduceOnly, false);
  assert.ok(reconcile(runtime([position], [stop]), [normalized], [unsafe]).reasons.includes('MISSING_BINANCE_PROTECTION'));
});
test('same order ID on another symbol does not match', () => {
  const other = { ...normalizedStop, symbol: 'ETHUSDT' };
  const result = reconcile(runtime([], [stop]), [], [other]);
  assert.ok(result.reasons.includes('MISSING_BINANCE_ORDER'));
  assert.ok(result.reasons.includes('UNTRACKED_BINANCE_ORDER'));
});
test('wrong closing side and insufficient remaining quantity block', () => {
  for (const changed of [{ side: 'BUY' }, { executedQty: '0.5' }]) {
    assert.ok(reconcile(runtime([position], [stop]), [normalized], [{ ...normalizedStop, ...changed }]).reasons.includes('MISSING_BINANCE_PROTECTION'));
  }
});
test('duplicate and absent order identities block', () => {
  assert.ok(reconcile(runtime(), [], [normalizedStop, normalizedStop]).reasons.includes('ORDER_IDENTITIES_INVALID'));
  assert.ok(reconcile(runtime(), [], [{ symbol: 'BTCUSDT' }]).reasons.includes('ORDER_IDENTITIES_INVALID'));
});

test('HTTP handler rejects replaced devices, malformed Binance data, and failed reads', async () => {
  const original = globalThis.fetch;
  try {
    for (const scenario of ['replaced', 'missing-owner', 'invalid', 'unavailable', 'clean', 'runtime-race']) {
      const state = JSON.stringify(runtime([], [], 'SIMULATION'));
      let stored;
      let binanceCalls = 0;
      globalThis.fetch = async (url, init = {}) => {
        if (url === 'https://redis.test') {
          const c = JSON.parse(init.body);
          let result = null;
          if (c[0] === 'GET') {
            if (c[1].includes(':device:')) result = JSON.stringify({ role: 'controller', deviceId: 'current' });
            else if (c[1].includes('role-device:')) result = scenario === 'replaced' ? 'replacement' : scenario === 'missing-owner' ? null : 'current';
            else if (c[1] === 'zenith:v1:state') result = state;
          }
          if (c[0] === 'EVAL') {
            const report = JSON.parse(c[6]);
            result = scenario === 'runtime-race' && !report.failClosed ? -1 : 1;
            if (result === 1) stored = report;
          }
          return new Response(JSON.stringify({ result }));
        }
        binanceCalls++;
        assert.equal(init.method || 'GET', 'GET', 'no Binance writes');
        const path = new URL(url).pathname;
        assert.ok(['/fapi/v1/time', '/fapi/v3/positionRisk', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders'].includes(path));
        if (path.endsWith('/time')) return new Response(JSON.stringify({ serverTime: Date.now() }));
        if (scenario === 'unavailable') return new Response('{}', { status: 503 });
        return new Response(JSON.stringify(scenario === 'invalid' ? { unexpected: true } : []));
      };
      const res = { setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
      await handler({ method: 'GET', headers: { authorization: 'Bearer test-device' } }, res);
      if (['replaced', 'missing-owner'].includes(scenario)) {
        assert.equal(res.code, 401); assert.equal(binanceCalls, 0);
      } else if (scenario === 'clean') {
        assert.equal(res.code, 200); assert.equal(stored.failClosed, false);
        assert.equal(stored.runtimeHash, crypto.createHash('sha256').update(state).digest('hex'));
      } else {
        assert.equal(res.code, 502); assert.equal(stored.failClosed, true);
      }
    }
  } finally { globalThis.fetch = original; }
});
