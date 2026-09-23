import crypto from 'node:crypto';
import { deviceTokenCandidates, deviceSessionRecordActive } from '../lib/device-session.mjs';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';

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
const BINANCE_RECONCILE_RATE_LIMIT_PER_MINUTE = 30;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => item === undefined ? 'null' : stableStringify(item)).join(',') + ']';
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = stableStringify(value[key]);
    if (encoded !== undefined) parts.push(JSON.stringify(key) + ':' + encoded);
  }
  return '{' + parts.join(',') + '}';
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

async function requireCurrentMaster(req) {
  for (const token of deviceTokenCandidates(req)) {
    const tokenHash = sha256(token);
    const raw = await redis(['GET', `${PREFIX}:device:${tokenHash}`]);
    if (!raw) continue;

    let device = null;
    try { device = JSON.parse(raw); } catch {}
    if (!deviceSessionRecordActive(device) || !device?.deviceId || device.role !== 'master') continue;

    const [registered, lease] = await Promise.all([
      redis(['GET', `${PREFIX}:role-device:master`]),
      redis(['GET', `${PREFIX}:master`]),
    ]);

    if (!registered || String(registered) !== String(device.deviceId)) continue;
    if (String(lease || '') !== String(device.deviceId)) {
      const e = new Error('MASTER_LEASE_REQUIRED');
      e.code = 'MASTER_LEASE_REQUIRED';
      throw e;
    }
    return device;
  }
  return null;
}

async function reconciliationRateAllowed(deviceId) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${PREFIX}:rate:binance-reconcile:${sha256(deviceId)}:${bucket}`;
  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count = Number(await redis(['EVAL', script, '1', key, '120'])) || 0;
  return count <= BINANCE_RECONCILE_RATE_LIMIT_PER_MINUTE;
}

function retryAfterSeconds() {
  return Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
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
  const explicit = String(position?.direction || '').toUpperCase();
  if (explicit === 'LONG' || explicit === 'SHORT') return explicit;
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
  return aa === bb;
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
    reduceOnly: o.reduceOnly === true || o.reduceOnly === 'true',
    closePosition: o.closePosition === true || o.closePosition === 'true',
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
    reduceOnly: o.reduceOnly === true || o.reduceOnly === 'true',
    closePosition: o.closePosition === true || o.closePosition === 'true',
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
      reduceOnly: x.reduceOnly === true || x.reduceOnly === 'true',
      closePosition: x.closePosition === true || x.closePosition === 'true',
    }));
}

function orderKey(order) {
  if (String(order?.algoId || '')) return `${order.symbol}:algo:${String(order.algoId)}`;
  if (String(order?.clientAlgoId || '')) return `${order.symbol}:algo-client:${String(order.clientAlgoId)}`;
  if (String(order?.orderId || '')) return `${order.symbol}:id:${String(order.orderId)}`;
  if (String(order?.clientOrderId || '')) return `${order.symbol}:client:${String(order.clientOrderId)}`;
  return '';
}

function zenithManagedOrderId(order) {
  const id = String(order?.clientAlgoId || order?.clientOrderId || '');
  return /^zth-[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

function orderProtectsPosition(order, position) {
  if (String(order?.symbol || '').toUpperCase() !== String(position?.symbol || '').toUpperCase()) return false;
  if (String(order?.positionSide || '').toUpperCase() !== String(position?.positionSide || '').toUpperCase()) return false;
  const expectedSide = direction(position) === 'LONG' ? 'SELL' : 'BUY';
  if (String(order?.side || '').toUpperCase() !== expectedSide) return false;
  return order?.reduceOnly === true || order?.closePosition === true;
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

  const orphanZenithProtectiveOrders = actualOrders.filter(order =>
    Boolean(zenithManagedOrderId(order)) &&
    (order?.reduceOnly === true || order?.closePosition === true) &&
    !actualPositions.some(position => orderProtectsPosition(order, position))
  );
  if (orphanZenithProtectiveOrders.length) reasons.push('ORPHAN_ZENITH_PROTECTIVE_ORDER');

  if (!runtimeState || !runtimeState.data || typeof runtimeState.data !== 'object') reasons.push('RUNTIME_STATE_UNAVAILABLE');
  const runtimeAge = Date.now() - Number(runtimeState?.updatedAt);
  if (!Number.isFinite(runtimeAge) || runtimeAge < 0 || runtimeAge > 30000) reasons.push('RUNTIME_STATE_STALE');
  if (runtimeIsReal && (!Array.isArray(runtimeState.data.binancePositions) || !Array.isArray(runtimeState.data.binanceOrders))) reasons.push('RUNTIME_INVENTORY_INCOMPLETE');
  if (runtimeIsReal && Array.isArray(runtimeState.data.binancePositions) && runtimeState.data.binancePositions.some(p =>
    !p || !p.symbol || (p.positionAmt ?? p.quantity ?? p.qty) == null ||
    !Number.isFinite(Number(p.positionAmt ?? p.quantity ?? p.qty)) || positionQty(p) <= 0
  )) reasons.push('EXPECTED_POSITION_INVALID');
  if (runtimeIsReal && Array.isArray(runtimeState.data.binanceOrders) && runtimeState.data.binanceOrders.some(o =>
    !o || !o.symbol || !orderKey(o) || !['BUY', 'SELL'].includes(o.side) || !o.type
  )) reasons.push('EXPECTED_ORDER_INVALID');
  if (actualOrderMap.size !== actualOrders.length || expectedOrderMap.size !== expectedOrd.length) reasons.push('ORDER_IDENTITIES_INVALID');
  if (actualPosMap.size !== actualPositions.length || expectedPosMap.size !== expectedPos.length) reasons.push('POSITION_IDENTITIES_INVALID');
  // An order ID alone never proves that a protective order is safe.
  const orderMismatches = [];
  for (const [key, expected] of expectedOrderMap) {
    const actual = actualOrderMap.get(key);
    if (actual && ['symbol', 'side', 'positionSide', 'type', 'reduceOnly', 'closePosition'].some(field => actual[field] !== expected[field])) orderMismatches.push(key);
  }
  if (orderMismatches.length) reasons.push('BINANCE_ORDER_MISMATCH');
  const missingProtections = actualPositions.filter(position => !actualOrders.some(order =>
    order.symbol === position.symbol && order.positionSide === position.positionSide &&
    order.side === (position.direction === 'LONG' ? 'SELL' : 'BUY') &&
    ['STOP', 'STOP_MARKET', 'TRAILING_STOP_MARKET'].includes(String(order.type || '').toUpperCase()) &&
    (order.reduceOnly === true || order.closePosition === true) &&
    (order.closePosition === true || number(order.origQty) - number(order.executedQty) >= position.quantity)
  )).map(positionKey);
  if (missingProtections.length) reasons.push('MISSING_BINANCE_PROTECTION');

  const maxLossProtectionCounts = new Map();
  const unsafeMaxLossProtections = [];
  for (const position of actualPositions) {
    const key = positionKey(position);
    const entryPrice = number(position.entryPrice, NaN);
    const quantity = positionQty(position);
    const expectedSide = position.direction === 'LONG' ? 'SELL' : 'BUY';
    const valid = [];
    for (const order of actualOrders) {
      if (String(order?.orderClass || '').toUpperCase() !== 'ALGO') continue;
      if (String(order?.symbol || '').toUpperCase() !== position.symbol) continue;
      if (String(order?.positionSide || '').toUpperCase() !== String(position.positionSide || '').toUpperCase()) continue;
      if (String(order?.side || '').toUpperCase() !== expectedSide) continue;
      if (String(order?.type || '').toUpperCase() !== 'STOP_MARKET') continue;
      if (order?.closePosition !== true) continue;
      if (!zenithManagedOrderId(order)) continue;
      const trigger = number(order?.triggerPrice ?? order?.stopPrice, NaN);
      if (!(entryPrice > 0) || !(trigger > 0) || !(quantity > 0)) continue;
      const lossSide = position.direction === 'LONG' ? trigger < entryPrice : trigger > entryPrice;
      if (!lossSide) continue;
      const impliedLossUsd = position.direction === 'LONG'
        ? (entryPrice - trigger) * quantity
        : (trigger - entryPrice) * quantity;
      if (impliedLossUsd > REAL_RISK_LIMITS.maxLossUsd + 1e-8) {
        unsafeMaxLossProtections.push({
          key,
          symbol: position.symbol,
          direction: position.direction,
          triggerPrice: trigger,
          impliedLossUsd,
          hardMaxLossUsd: REAL_RISK_LIMITS.maxLossUsd,
          clientAlgoId: String(order?.clientAlgoId || ''),
          algoId: String(order?.algoId || ''),
        });
        continue;
      }
      valid.push(order);
    }
    maxLossProtectionCounts.set(key, valid.length);
  }
  const missingMaxLossProtections = actualPositions
    .filter(position => (maxLossProtectionCounts.get(positionKey(position)) || 0) === 0)
    .map(positionKey);
  const ambiguousMaxLossProtections = actualPositions
    .filter(position => (maxLossProtectionCounts.get(positionKey(position)) || 0) > 1)
    .map(positionKey);
  if (missingMaxLossProtections.length) reasons.push('MISSING_BINANCE_MAX_LOSS_PROTECTION');
  if (ambiguousMaxLossProtections.length) reasons.push('AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION');

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
      orderMismatches,
      orphanZenithProtectiveOrders,
      missingProtections,
      missingMaxLossProtections,
      ambiguousMaxLossProtections,
      unsafeMaxLossProtections,
    },
  };
}

async function persistReport(report, runtimeRaw = null) {
  const script = [
    "local previous = redis.call('GET', KEYS[1])",
    "if previous then",
    "  local ok, value = pcall(cjson.decode, previous)",
    "  if ok and tonumber(value.observedAt or 0) >= tonumber(ARGV[1]) then return 0 end",
    "end",
    "if ARGV[3] == '1' and (redis.call('GET', KEYS[2]) or '') ~= ARGV[4] then return -1 end",
    "redis.call('SET', KEYS[1], ARGV[2], 'EX', '30')",
    "return 1"
  ].join('\n');
  return Number(await redis(['EVAL', script, '2', KEY_RECONCILE_LAST, KEY_STATE,
    String(report.observedAt), JSON.stringify(report), runtimeRaw === null ? '0' : '1', runtimeRaw || '']));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  }

  let device = null;
  try {
    device = await requireCurrentMaster(req);
  } catch (e) {
    if (e?.code === 'MASTER_LEASE_REQUIRED') {
      return send(res, 409, {
        ok: false,
        code: 'MASTER_LEASE_REQUIRED',
        error: 'Le MASTER Zenith ne détient pas le lease actif.',
      });
    }
    return send(res, 503, {
      ok: false,
      code: e?.code || 'AUTH_BACKEND_ERROR',
      error: 'Authentification Zenith indisponible.',
    });
  }

  if (!device) {
    return send(res, 401, {
      ok: false,
      code: 'MASTER_REQUIRED',
      error: 'MASTER Zenith autorisé requis.',
    });
  }

  try {
    if (!(await reconciliationRateAllowed(device.deviceId))) {
      const retryAfter = retryAfterSeconds();
      res.setHeader('Retry-After', String(retryAfter));
      return send(res, 429, {
        ok: false,
        code: 'BINANCE_RECONCILE_RATE_LIMIT',
        retryAfterSeconds: retryAfter,
      });
    }
  } catch (e) {
    return send(res, 503, {
      ok: false,
      code: e?.code || 'RATE_LIMIT_BACKEND_ERROR',
      error: 'Protection anti-abus indisponible.',
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

    if (![positions, openOrders, openAlgoOrders].every(Array.isArray)) throw new Error('BINANCE_RESPONSE_INVALID');
    for (const p of positions) {
      if (!p || !p.symbol || !['BOTH', 'LONG', 'SHORT'].includes(p.positionSide) ||
          p.positionAmt === '' || p.positionAmt == null || !Number.isFinite(Number(p.positionAmt))) throw new Error('BINANCE_POSITION_INVALID');
    }
    for (const order of [...openOrders, ...openAlgoOrders]) {
      if (!order || !order.symbol || !['BUY', 'SELL'].includes(order.side) ||
          !['BOTH', 'LONG', 'SHORT'].includes(order.positionSide) ||
          !(order.orderId || order.clientOrderId || order.algoId || order.clientAlgoId)) throw new Error('BINANCE_ORDER_INVALID');
    }
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
    const observedAt = started;

    const report = {
      version: 2,
      observedAt,
      completedAt: Date.now(),
      runtimeHash: sha256(runtimeRaw || ''),
      runtimeDataHash: sha256(stableStringify(runtimeState?.data ?? null)),
      serverTime,
      latencyMs: Date.now() - started,
      deviceRole: device.role,
      ...result,
    };

    const reportHash = sha256(JSON.stringify(report));
    const stored = { ...report, reportHash };

    if (await persistReport(stored, runtimeRaw || '') !== 1) throw new Error('RECONCILIATION_SUPERSEDED_OR_RUNTIME_CHANGED');
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
    // Invalidate an earlier clean result when the new observation fails.
    try {
      await persistReport({ version: 2, observedAt: started, status: 'UNAVAILABLE', failClosed: true, reasons: ['BINANCE_RECONCILE_FAILED'] });
    } catch {}
    return send(res, 502, {
      ok: false,
      code: 'BINANCE_RECONCILE_FAILED',
      error: 'Réconciliation Binance impossible.',
      binanceCode: e?.binanceCode ?? null,
    });
  }
}
