import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import crypto from 'node:crypto';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';
process.env.BINANCE_API_KEY = 'test-only';
process.env.BINANCE_API_SECRET = 'test-only';
const source = fs.readFileSync('api/binance-reconcile.js', 'utf8')
  .replace(
    /^import \{[^\n]*deviceTokenCandidates[^\n]*\} from '\.\.\/lib\/device-session\.mjs';\n/m,
    "const deviceTokenCandidates = req => { const h=String(req?.headers?.authorization||''); const t=h.startsWith('Bearer ')?h.slice(7).trim():''; return t?[t]:[]; }; const deviceSessionRecordActive = () => true; const roleAssignmentKey = (prefix,role) => prefix + ':role-issued-at:' + role; const deviceRoleAssignmentActive = (device,issuedAt) => !issuedAt || Number(device?.createdAt||0) >= Number(issuedAt); const sameOriginMutation = req => String(req?.headers?.origin||'') === 'https://zenith.test';\n"
  )
  .replace(
    /^import \{ REAL_RISK_LIMITS \} from '\.\.\/lib\/risk-policy\.mjs';\n/m,
    "const REAL_RISK_LIMITS = Object.freeze({ maxLossUsd: 400 });\n"
  )
  .replace(
    /^import \{ requestBodyStatus \} from '\.\.\/lib\/request-body-limit\.mjs';\n/m,
    "const requestBodyStatus = (req,maxBytes) => { const bytes=Number(req?.headers?.['content-length']||0); return bytes>maxBytes?{ok:false,maxBytes}:{ok:true,maxBytes}; };\n"
  );
const { default: handler, reconcile, normalizeActualPosition, normalizeActualOrder, normalizeActualAlgoOrder } = await import(
  'data:text/javascript;base64,' + Buffer.from(source + '\nexport { reconcile, normalizeActualPosition, normalizeActualOrder, normalizeActualAlgoOrder };').toString('base64')
);
const runtime = (positions = [], orders = [], mode = 'REAL') => ({
  updatedAt: Date.now(), data: { executionMode: mode, binancePositions: positions, binanceOrders: orders },
});
const position = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '1', entryPrice: '50000' };
const stop = { symbol: 'BTCUSDT', positionSide: 'BOTH', side: 'SELL', type: 'STOP_MARKET',
  orderId: 42, origQty: '1', executedQty: '0', reduceOnly: true, closePosition: false };
const emergency = { orderClass:'ALGO', symbol:'BTCUSDT', positionSide:'BOTH', side:'SELL',
  type:'STOP_MARKET', algoId:77, clientAlgoId:'zth-MAX-test', triggerPrice:'49600',
  reduceOnly:false, closePosition:true, algoStatus:'NEW' };
const progressive = { orderClass:'ALGO', symbol:'BTCUSDT', positionSide:'BOTH', side:'SELL',
  type:'STOP', algoId:78, clientAlgoId:'zth-PRO-test', quantity:'1', triggerPrice:'51000',
  reduceOnly:true, closePosition:false, algoStatus:'NEW' };
const normalized = normalizeActualPosition(position);
const normalizedStop = normalizeActualOrder(stop);
const normalizedEmergency = normalizeActualAlgoOrder(emergency);
const normalizedProgressive = normalizeActualAlgoOrder(progressive);

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
test('matching position requires a valid close-all MAX-LOSS algo stop', () => {
  const result = reconcile(runtime([position], [emergency]), [normalized], [normalizedEmergency]);
  assert.equal(result.failClosed, false);
  assert.deepEqual(result.differences.missingMaxLossProtections, []);
  assert.deepEqual(result.differences.ambiguousMaxLossProtections, []);
});
test('quantity changes and missing positions block', () => {
  assert.ok(reconcile(runtime([{ ...position, positionAmt: '2' }], [emergency]), [normalized], [normalizedEmergency]).reasons.includes('BINANCE_POSITION_QUANTITY_MISMATCH'));
  assert.ok(reconcile(runtime([position]), [], []).reasons.includes('MISSING_BINANCE_POSITION'));
});
test('missing protection blocks even if runtime did not declare it', () => {
  const result = reconcile(runtime([position]), [normalized], []);
  assert.ok(result.reasons.includes('MISSING_BINANCE_PROTECTION'));
  assert.ok(result.reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION'));
});
test('progressive STOP alone never substitutes for the emergency MAX-LOSS stop', () => {
  const result = reconcile(runtime([position], [progressive]), [normalized], [normalizedProgressive]);
  assert.equal(result.reasons.includes('MISSING_BINANCE_PROTECTION'), false);
  assert.ok(result.reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION'));
  assert.deepEqual(result.differences.missingMaxLossProtections, ['BTCUSDT:LONG']);
});

test('MAX-LOSS STOP_MARKET must trigger on the loss side of the entry', () => {
  const wrong = { ...emergency, algoId:79, clientAlgoId:'zth-MAX-wrong', triggerPrice:'51000' };
  const actual = normalizeActualAlgoOrder(wrong);
  const result = reconcile(runtime([position], [wrong]), [normalized], [actual]);
  assert.ok(result.reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION'));
});

test('multiple valid MAX-LOSS close-all stops fail closed as ambiguous', () => {
  const second = { ...emergency, algoId:80, clientAlgoId:'zth-MAX-second', triggerPrice:'49700' };
  const result = reconcile(
    runtime([position], [emergency, second]),
    [normalized],
    [normalizedEmergency, normalizeActualAlgoOrder(second)]
  );
  assert.ok(result.reasons.includes('AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION'));
  assert.deepEqual(result.differences.ambiguousMaxLossProtections, ['BTCUSDT:LONG']);
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

test('HTTP reconciliation requires bounded same-origin POST', async () => {
  const makeRes=()=>({setHeader(){},status(n){this.code=n;return this},json(body){this.body=body}});
  {
    const res=makeRes();
    await handler({method:'GET',headers:{origin:'https://zenith.test'}},res);
    assert.equal(res.code,405);
  }
  {
    const res=makeRes();
    await handler({method:'POST',headers:{origin:'https://evil.test'}},res);
    assert.equal(res.code,403);
    assert.equal(res.body.code,'ORIGIN_FORBIDDEN');
  }
  {
    const res=makeRes();
    await handler({method:'POST',headers:{origin:'https://zenith.test','content-length':'5000'}},res);
    assert.equal(res.code,413);
    assert.equal(res.body.code,'REQUEST_BODY_TOO_LARGE');
  }
});

test('HTTP reconciliation is MASTER-only and rejects malformed or failed Binance reads', async () => {
  const original = globalThis.fetch;
  try {
    for (const scenario of ['controller', 'replaced', 'missing-owner', 'lease-mismatch', 'rate-limited', 'invalid', 'unavailable', 'clean', 'runtime-race']) {
      const state = JSON.stringify(runtime([], [], 'SIMULATION'));
      let stored;
      let binanceCalls = 0;
      globalThis.fetch = async (url, init = {}) => {
        if (url === 'https://redis.test') {
          const c = JSON.parse(init.body);
          let result = null;
          if (c[0] === 'GET') {
            if (c[1].includes(':device:')) {
              result = JSON.stringify({
                role: scenario === 'controller' ? 'controller' : 'master',
                deviceId: 'current',
                createdAt: 1800000100000
              });
            } else if (c[1] === 'zenith:v1:role-device:master') {
              result = scenario === 'replaced' ? 'replacement' : scenario === 'missing-owner' ? null : 'current';
            } else if (c[1] === 'zenith:v1:master') {
              result = scenario === 'lease-mismatch' ? 'other-master' : 'current';
            } else if (c[1] === 'zenith:v1:role-issued-at:master') {
              result = '1800000000000';
            } else if (c[1] === 'zenith:v1:state') {
              result = state;
            }
          }
          if (c[0] === 'EVAL') {
            if (c[2] === '1') {
              result = scenario === 'rate-limited' ? 31 : 1;
            } else {
              const report = JSON.parse(c[6]);
              result = scenario === 'runtime-race' && !report.failClosed ? -1 : 1;
              if (result === 1) stored = report;
            }
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
      await handler({ method: 'POST', headers: { authorization: 'Bearer test-device', origin: 'https://zenith.test' } }, res);
      if (['controller', 'replaced', 'missing-owner'].includes(scenario)) {
        assert.equal(res.code, 401); assert.equal(binanceCalls, 0);
      } else if (scenario === 'lease-mismatch') {
        assert.equal(res.code, 409); assert.equal(res.body.code, 'MASTER_LEASE_REQUIRED'); assert.equal(binanceCalls, 0);
      } else if (scenario === 'rate-limited') {
        assert.equal(res.code, 429); assert.equal(res.body.code, 'BINANCE_RECONCILE_RATE_LIMIT'); assert.equal(binanceCalls, 0);
      } else if (scenario === 'clean') {
        assert.equal(res.code, 200); assert.equal(stored.failClosed, false);
        assert.equal(stored.deviceRole, 'master');
        assert.equal(stored.runtimeHash, crypto.createHash('sha256').update(state).digest('hex'));
      } else {
        assert.equal(res.code, 502); assert.equal(stored.failClosed, true);
      }
    }
  } finally { globalThis.fetch = original; }
});


test('Zenith-managed reduce-only order without a live position is an orphan mismatch', () => {
  const stale = normalizeActualOrder({
    symbol:'BTCUSDT',positionSide:'BOTH',side:'SELL',type:'LIMIT',
    orderId:99,clientOrderId:'zth-EXI-0123456789abcdef01234567',
    origQty:'1',executedQty:'0',reduceOnly:true,closePosition:false,
    price:'51000',timeInForce:'GTC'
  });
  const result = reconcile(runtime([], [stale]), [], [stale]);
  assert.ok(result.reasons.includes('ORPHAN_ZENITH_PROTECTIVE_ORDER'));
  assert.equal(result.differences.orphanZenithProtectiveOrders.length,1);
});

test('Zenith-managed algo protection without a live position is an orphan mismatch', () => {
  const stale = normalizeActualAlgoOrder({
    symbol:'BTCUSDT',positionSide:'BOTH',side:'SELL',orderType:'STOP',
    algoId:100,clientAlgoId:'zth-PRO-0123456789abcdef01234567',
    quantity:'1',reduceOnly:true,closePosition:false,
    price:'50500',triggerPrice:'50500',timeInForce:'GTC',algoStatus:'NEW'
  });
  const result = reconcile(runtime([], [stale]), [], [stale]);
  assert.ok(result.reasons.includes('ORPHAN_ZENITH_PROTECTIVE_ORDER'));
});

test('external reduce-only order is not classified as a Zenith orphan', () => {
  const external = normalizeActualOrder({
    symbol:'BTCUSDT',positionSide:'BOTH',side:'SELL',type:'LIMIT',
    orderId:101,clientOrderId:'manual-exit',
    origQty:'1',executedQty:'0',reduceOnly:true,closePosition:false,
    price:'51000',timeInForce:'GTC'
  });
  const result = reconcile(runtime([], [external]), [], [external]);
  assert.equal(result.reasons.includes('ORPHAN_ZENITH_PROTECTIVE_ORDER'),false);
});


test('MAX-LOSS beyond the hard $400 cap is treated as missing protection', () => {
  const unsafe = normalizeActualAlgoOrder({
    ...emergency,
    algoId:177,
    clientAlgoId:'zth-MAX-too-far',
    triggerPrice:'49599'
  });
  const result = reconcile(runtime([position], [unsafe]), [normalized], [unsafe]);
  assert.ok(result.reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION'));
  assert.equal(result.differences.unsafeMaxLossProtections.length,1);
  assert.ok(result.differences.unsafeMaxLossProtections[0].impliedLossUsd>400);
});

test('MAX-LOSS exactly at the hard $400 cap remains valid', () => {
  const result = reconcile(runtime([position], [emergency]), [normalized], [normalizedEmergency]);
  assert.equal(result.reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION'),false);
  assert.equal(result.differences.unsafeMaxLossProtections.length,0);
});


test('external close-all STOP_MARKET never satisfies Zenith mandatory MAX-LOSS', () => {
  const external = { ...emergency, algoId:181, clientAlgoId:'manual-max-loss' };
  const actual = normalizeActualAlgoOrder(external);
  const result = reconcile(runtime([position], [external]), [normalized], [actual]);
  assert.ok(result.reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION'));
  assert.deepEqual(result.differences.missingMaxLossProtections, ['BTCUSDT:LONG']);
});
