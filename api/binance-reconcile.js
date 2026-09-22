import crypto from 'node:crypto';

const BASE = 'https://fapi.binance.com';
const RECV_WINDOW = 5000;

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN;

const PREFIX = 'zenith:v1';
const KEY_STATE = `${PREFIX}:state`;
const KEY_RECONCILE_LAST = `${PREFIX}:reconcile:last`;
const KEY_AUDIT = `${PREFIX}:audit`;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function redis(command) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const e = new Error('UPSTASH_NOT_CONFIGURED');
    e.code = 'UPSTASH_NOT_CONFIGURED';
    throw e;
  }

  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
  });

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!r.ok || data?.error) {
    const e = new Error(data?.error || `Redis HTTP ${r.status}`);
    e.code = 'REDIS_ERROR';
    throw e;
  }
  return data?.result;
}

async function requireZenithDevice(req) {
  const token = bearer(req);
  if (!token) return null;

  const tokenHash = sha256(token);
  const raw = await redis(['GET', `${PREFIX}:device:${tokenHash}`]);
  if (!raw) return null;

  try {
    const device = JSON.parse(raw);
    if (!device?.deviceId || !['controller', 'master'].includes(device?.role)) return null;

    const roleKey = device.role === 'master'
      ? `${PREFIX}:role-device:master`
      : `${PREFIX}:role-device:controller`;
    const owner = await redis(['GET', roleKey]);
    if (owner && String(owner) !== String(device.deviceId)) return null;

    return device;
  } catch {
    return null;
  }
}

async function jsonFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!r.ok) {
      const e = new Error(data?.msg || `Binance HTTP ${r.status}`);
      e.status = r.status;
      e.binanceCode = data?.code;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function signedGet(path, apiKey, secret, serverTime, extra = {}) {
  const params = new URLSearchParams({
    timestamp: String(serverTime),
    recvWindow: String(RECV_WINDOW),
  });
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }

  const signature = crypto
    .createHmac('sha256', secret)
    .update(params.toString())
    .digest('hex');

  params.set('signature', signature);

  return jsonFetch(`${BASE}${path}?${params.toString()}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

function number(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function direction(position) {
  const ps = String(position?.positionSide || '').toUpperCase();
  if (ps === 'LONG' || ps === 'SHORT') return ps;
  return number(position?.positionAmt ?? position?.quantity ?? position?.qty) < 0 ? 'SHORT' : 'LONG';
}

function positionKey(position) {
  return `${String(position?.symbol || '').toUpperCase()}:${direction(position)}`;
}

function positionQty(position) {
  return Math.abs(number(position?.positionAmt ?? position?.quantity ?? position?.qty));
}

function nearlyEqual(a, b) {
  const aa = Math.abs(number(a));
  const bb = Math.abs(number(b));
  const diff = Math.abs(aa - bb);
  return diff <= 1e-12 || diff <= Math.max(aa, bb, 1) * 1e-8;
}

function normalizeActualPosition(p) {
  return {
    symbol: String(p.symbol || '').toUpperCase(),
    direction: direction(p),
    positionSide: String(p.positionSide || ''),
    positionAmt: String(p.positionAmt ?? ''),
    quantity: positionQty(p),
    entryPrice: number(p.entryPrice),
    breakEvenPrice: number(p.breakEvenPrice),
    markPrice: number(p.markPrice),
    unrealizedProfit: number(p.unRealizedProfit ?? p.unrealizedProfit),
    liquidationPrice: number(p.liquidationPrice),
    leverage: number(p.leverage),
    marginType: String(p.marginType || ''),
    isolatedMargin: number(p.isolatedMargin),
    notional: number(p.notional),
    updateTime: number(p.updateTime),
  };
}

function normalizeActualOrder(o) {
  return {
    symbol: String(o.symbol || '').toUpperCase(),
    orderId: String(o.orderId ?? ''),
    clientOrderId: String(o.clientOrderId ?? ''),
    side: String(o.side || ''),
    positionSide: String(o.positionSide || ''),
    type: String(o.type || ''),
    status: String(o.status || ''),
    origQty: String(o.origQty ?? ''),
    executedQty: String(o.executedQty ?? ''),
    price: String(o.price ?? ''),
    stopPrice: String(o.stopPrice ?? ''),
    reduceOnly: Boolean(o.reduceOnly),
    closePosition: Boolean(o.closePosition),
    timeInForce: String(o.timeInForce || ''),
    workingType: String(o.workingType || ''),
    priceProtect: Boolean(o.priceProtect),
    updateTime: number(o.updateTime ?? o.time),
  };
}

function normalizeActualAlgoOrder(o) {
  return {
    orderClass: 'ALGO',
    symbol: String(o.symbol || '').toUpperCase(),
    algoId: String(o.algoId ?? ''),
    clientAlgoId: String(o.clientAlgoId ?? ''),
    side: String(o.side || ''),
    positionSide: String(o.positionSide || ''),
    type: String(o.orderType || o.type || ''),
    status: String(o.algoStatus || ''),
    origQty: String(o.quantity ?? ''),
    executedQty: '',
    price: String(o.price ?? ''),
    stopPrice: String(o.triggerPrice ?? ''),
    triggerPrice: String(o.triggerPrice ?? ''),
    reduceOnly: Boolean(o.reduceOnly),
    closePosition: Boolean(o.closePosition),
    timeInForce: String(o.timeInForce || ''),
    workingType: String(o.workingType || ''),
    priceProtect: Boolean(o.priceProtect),
    updateTime: number(o.updateTime ?? o.createTime),
  };
}

function expectedPositions(runtimeState) {
  const data = runtimeState?.data || {};
  const list = Array.isArray(data.binancePositions) ? data.binancePositions : [];
  return list
    .filter(x => x && typeof x === 'object' && String(x.symbol || '').trim())
    .map(x => ({
      symbol: String(x.symbol || '').toUpperCase(),
      direction: direction(x),
      positionSide: String(x.positionSide || ''),
      positionAmt: String(x.positionAmt ?? x.quantity ?? x.qty ?? ''),
      quantity: positionQty(x),
      entryPrice: number(x.entryPrice),
    }));
}

function expectedOrders(runtimeState) {
  const data = runtimeState?.data || {};
  const source = Array.isArray(data.binanceOrders)
    ? data.binanceOrders
    : Array.isArray(data.protectiveOrders)
      ? data.protectiveOrders
      : [];

  return source
    .filter(x => x && typeof x === 'object')
    .map(x => ({
      symbol: String(x.symbol || '').toUpperCase(),
      orderId: String(x.orderId ?? ''),
      clientOrderId: String(x.clientOrderId ?? ''),
      algoId: String(x.algoId ?? ''),
      clientAlgoId: String(x.clientAlgoId ?? ''),
      type: String(x.type || ''),
      side: String(x.side || ''),
      positionSide: String(x.positionSide || ''),
      reduceOnly: Boolean(x.reduceOnly),
      closePosition: Boolean(x.closePosition),
    }));
}

function orderKey(order) {
  if (String(order?.algoId || '')) return `algo:${String(order.algoId)}`;
  if (String(order?.clientAlgoId || '')) return `algo-client:${String(order.clientAlgoId)}`;
  if (String(order?.orderId || '')) return `id:${String(order.orderId)}`;
  if (String(order?.clientOrderId || '')) return `client:${String(order.clientOrderId)}`;
  return '';
}

function reconcile(runtimeState, actualPositions, actualOrders) {
  const runtimeMode = String(runtimeState?.data?.executionMode || runtimeState?.data?.mode || '').toUpperCase();
  const runtimeIsReal = runtimeMode === 'REAL';
  const expectedPos = runtimeIsReal ? expectedPositions(runtimeState) : [];
  const expectedOrd = runtimeIsReal ? expectedOrders(runtimeState) : [];

  const actualPosMap = new Map(actualPositions.map(p => [positionKey(p), p]));
  const expectedPosMap = new Map(expectedPos.map(p => [positionKey(p), p]));

  const untrackedPositions = [];
  const missingPositions = [];
  const quantityMismatches = [];

  for (const [key, actual] of actualPosMap) {
    const expected = expectedPosMap.get(key);
    if (!expected) {
      untrackedPositions.push(actual);
      continue;
    }
    if (!nearlyEqual(actual.quantity, expected.quantity)) {
      quantityMismatches.push({
        key,
        symbol: actual.symbol,
        direction: actual.direction,
        expectedQuantity: expected.quantity,
        actualQuantity: actual.quantity,
      });
    }
  }

  for (const [key, expected] of expectedPosMap) {
    if (!actualPosMap.has(key)) missingPositions.push(expected);
  }

  const actualOrderMap = new Map(
    actualOrders.map(o => [orderKey(o), o]).filter(([key]) => key)
  );
  const expectedOrderMap = new Map(
    expectedOrd.map(o => [orderKey(o), o]).filter(([key]) => key)
  );

  const untrackedOrders = [];
  const missingOrders = [];

  for (const [key, actual] of actualOrderMap) {
    if (!expectedOrderMap.has(key)) untrackedOrders.push(actual);
  }
  for (const [key, expected] of expectedOrderMap) {
    if (!actualOrderMap.has(key)) missingOrders.push(expected);
  }

  const reasons = [];
  if (!runtimeIsReal && actualPositions.length) reasons.push('BINANCE_POSITION_WHILE_RUNTIME_NOT_REAL');
  if (!runtimeIsReal && actualOrders.length) reasons.push('BINANCE_ORDER_WHILE_RUNTIME_NOT_REAL');
  if (untrackedPositions.length) reasons.push('UNTRACKED_BINANCE_POSITION');
  if (missingPositions.length) reasons.push('MISSING_BINANCE_POSITION');
  if (quantityMismatches.length) reasons.push('BINANCE_POSITION_QUANTITY_MISMATCH');
  if (untrackedOrders.length) reasons.push('UNTRACKED_BINANCE_ORDER');
  if (missingOrders.length) reasons.push('MISSING_BINANCE_ORDER');

  const failClosed = reasons.length > 0;

  return {
    status: failClosed ? 'MISMATCH' : (runtimeIsReal ? 'CLEAN_REAL' : 'CLEAN_IDLE'),
    failClosed,
    reasons,
    runtimeStatePresent: Boolean(runtimeState),
    runtimeMode: runtimeMode || 'NONE',
    expected: {
      positions: expectedPos.length,
      orders: expectedOrd.length,
    },
    actual: {
      positions: actualPositions.length,
      orders: actualOrders.length,
    },
    differences: {
      untrackedPositions,
      missingPositions,
      quantityMismatches,
      untrackedOrders,
      missingOrders,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  }

  let device = null;
  try {
    device = await requireZenithDevice(req);
  } catch (e) {
    return send(res, 503, {
      ok: false,
      code: e?.code || 'AUTH_BACKEND_ERROR',
      error: e?.message || 'Authentification Zenith indisponible.',
    });
  }

  if (!device) {
    return send(res, 401, {
      ok: false,
      code: 'UNAUTHORIZED_DEVICE',
      error: 'Appareil Zenith non autorisé.',
    });
  }

  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) {
    return send(res, 503, {
      ok: false,
      code: 'MISSING_ENV',
      error: 'Variables Binance serveur absentes.',
    });
  }

  const started = Date.now();

  try {
    const [time, runtimeRaw] = await Promise.all([
      jsonFetch(`${BASE}/fapi/v1/time`),
      redis(['GET', KEY_STATE]),
    ]);

    const serverTime = number(time?.serverTime, NaN);
    if (!Number.isFinite(serverTime)) throw new Error('Heure Binance indisponible.');

    const [positions, openOrders, openAlgoOrders] = await Promise.all([
      signedGet('/fapi/v3/positionRisk', apiKey, secret, serverTime),
      signedGet('/fapi/v1/openOrders', apiKey, secret, serverTime),
      signedGet('/fapi/v1/openAlgoOrders', apiKey, secret, serverTime, { algoType: 'CONDITIONAL' }),
    ]);

    let runtimeState = null;
    try { runtimeState = runtimeRaw ? JSON.parse(runtimeRaw) : null; } catch {}

    const actualPositions = (Array.isArray(positions) ? positions : [])
      .filter(p => Math.abs(number(p.positionAmt)) > 0)
      .map(normalizeActualPosition);

    const standardOrders = (Array.isArray(openOrders) ? openOrders : [])
      .map(o => ({ orderClass: 'STANDARD', ...normalizeActualOrder(o) }));

    const algoOrders = (Array.isArray(openAlgoOrders) ? openAlgoOrders : [])
      .map(normalizeActualAlgoOrder);

    const actualOrders = [...standardOrders, ...algoOrders];

    const result = reconcile(runtimeState, actualPositions, actualOrders);
    result.actual.standardOrders = standardOrders.length;
    result.actual.algoOrders = algoOrders.length;
    const observedAt = Date.now();

    const report = {
      version: 1,
      observedAt,
      serverTime,
      latencyMs: observedAt - started,
      deviceRole: device.role,
      ...result,
    };

    const reportHash = sha256(JSON.stringify(report));
    const stored = { ...report, reportHash };

    await redis(['SET', KEY_RECONCILE_LAST, JSON.stringify(stored), 'EX', String(60 * 60 * 24 * 7)]);
    await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
      at: observedAt,
      kind: 'BINANCE_RECONCILIATION',
      deviceId: device.deviceId,
      role: device.role,
      status: report.status,
      failClosed: report.failClosed,
      reasons: report.reasons,
      reportHash,
    })]);
    await redis(['LTRIM', KEY_AUDIT, '0', '199']);

    return send(res, 200, { ok: true, report: stored });
  } catch (e) {
    return send(res, 502, {
      ok: false,
      code: 'BINANCE_RECONCILE_FAILED',
      error: e?.message || 'Réconciliation Binance impossible.',
      binanceCode: e?.binanceCode ?? null,
    });
  }
}
