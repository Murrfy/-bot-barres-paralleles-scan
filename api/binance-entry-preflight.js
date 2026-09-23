import crypto from 'node:crypto';
import { deviceTokenCandidates } from '../lib/device-session.mjs';
import { evaluateEntryRisk, REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';

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
const ENTRY_PREFLIGHT_HTTP_RATE_LIMIT_PER_MINUTE = 6;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
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
    if (!device?.deviceId || device.role !== 'master') continue;

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

async function entryPreflightHttpRateAllowed(deviceId) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${PREFIX}:rate:entry-preflight-http:${sha256(deviceId)}:${bucket}`;
  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count = Number(await redis(['EVAL', script, '1', key, '120'])) || 0;
  return count <= ENTRY_PREFLIGHT_HTTP_RATE_LIMIT_PER_MINUTE;
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
  const signature = crypto.createHmac('sha256', secret).update(params.toString()).digest('hex');
  params.set('signature', signature);
  return jsonFetch(`${BASE}${path}?${params.toString()}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

function number(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function firstForSymbol(value, symbol) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.find(x => String(x?.symbol || '').toUpperCase() === symbol) || null;
}

export async function runLiveEntryPreflight({
  apiKey,
  secret,
  symbol,
  margin,
  leverage,
  maxLoss,
  requestedPrice = 0,
} = {}) {
  if (!apiKey || !secret) throw new Error('BINANCE_CREDENTIALS_REQUIRED');
  const sym = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(sym) ||
      !(number(margin) > 0) ||
      !(number(leverage) > 0) ||
      !(number(maxLoss) > 0)) {
    const e = new Error('PREFLIGHT_REQUEST_INVALID');
    e.code = 'PREFLIGHT_REQUEST_INVALID';
    throw e;
  }

  const startedAt = Date.now();
  const pricePromise = number(requestedPrice) > 0
    ? Promise.resolve({ price: String(number(requestedPrice)) })
    : jsonFetch(`${BASE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(sym)}`);

  const [time, exchangeInfo, ticker] = await Promise.all([
    jsonFetch(`${BASE}/fapi/v1/time`),
    jsonFetch(`${BASE}/fapi/v1/exchangeInfo`),
    pricePromise,
  ]);
  const serverTime = Number(time?.serverTime);
  if (!Number.isFinite(serverTime)) throw new Error('BINANCE_TIME_INVALID');

  const [symbolConfigRaw, bracketsRaw, positionMode, account, positions, standardOrders, algoOrders] = await Promise.all([
    signedGet('/fapi/v1/symbolConfig', apiKey, secret, serverTime, { symbol: sym }),
    signedGet('/fapi/v1/leverageBracket', apiKey, secret, serverTime, { symbol: sym }),
    signedGet('/fapi/v1/positionSide/dual', apiKey, secret, serverTime),
    signedGet('/fapi/v3/account', apiKey, secret, serverTime),
    signedGet('/fapi/v3/positionRisk', apiKey, secret, serverTime),
    signedGet('/fapi/v1/openOrders', apiKey, secret, serverTime, { symbol: sym }),
    signedGet('/fapi/v1/openAlgoOrders', apiKey, secret, serverTime, { symbol: sym, algoType: 'CONDITIONAL' }),
  ]);

  const symbolInfo = (Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [])
    .find(x => String(x?.symbol || '').toUpperCase() === sym) || null;
  const symbolConfig = firstForSymbol(symbolConfigRaw, sym);
  const bracketInfo = firstForSymbol(bracketsRaw, sym);
  const usdt = (Array.isArray(account?.assets) ? account.assets : [])
    .find(x => String(x?.asset || '').toUpperCase() === 'USDT') || {};
  const referencePrice = number(requestedPrice) > 0 ? number(requestedPrice) : number(ticker?.price);

  const evaluation = evaluateEntryRisk({
    symbol: sym,
    margin,
    leverage,
    maxLoss,
    referencePrice,
    symbolInfo,
    symbolConfig,
    bracketInfo,
    dualSidePosition: positionMode?.dualSidePosition === true,
    positions,
    standardOrders,
    algoOrders,
    availableBalanceUsdt: number(usdt?.availableBalance, number(account?.availableBalance, -1)),
  });

  return {
    evaluation,
    observedAt: Date.now(),
    serverTime,
    latencyMs: Date.now() - startedAt,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  }

  let master = null;
  try {
    master = await requireCurrentMaster(req);
  } catch (e) {
    if (e?.code === 'MASTER_LEASE_REQUIRED') {
      return send(res, 409, { ok: false, code: 'MASTER_LEASE_REQUIRED' });
    }
    return send(res, 503, {
      ok: false,
      code: e?.code || 'AUTH_BACKEND_ERROR',
      error: 'Authentification Zenith indisponible.',
    });
  }
  if (!master) {
    return send(res, 401, { ok: false, code: 'MASTER_REQUIRED' });
  }

  try {
    if (!(await entryPreflightHttpRateAllowed(master.deviceId))) {
      const retryAfter = retryAfterSeconds();
      res.setHeader('Retry-After', String(retryAfter));
      return send(res, 429, {
        ok: false,
        code: 'ENTRY_PREFLIGHT_HTTP_RATE_LIMIT',
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

  const symbol = String(req.query?.symbol || '').trim().toUpperCase();
  const margin = number(req.query?.margin);
  const leverage = number(req.query?.leverage);
  const maxLoss = number(req.query?.maxLoss);
  const requestedPrice = number(req.query?.price);

  if (!/^[A-Z0-9]{3,30}$/.test(symbol) || !(margin > 0) || !(leverage > 0) || !(maxLoss > 0)) {
    return send(res, 400, { ok: false, code: 'PREFLIGHT_REQUEST_INVALID' });
  }

  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) {
    return send(res, 503, { ok: false, code: 'MISSING_ENV', error: 'Variables Binance serveur absentes.' });
  }

  try {
    const result = await runLiveEntryPreflight({
      apiKey,
      secret,
      symbol,
      margin,
      leverage,
      maxLoss,
      requestedPrice,
    });
    return send(res, 200, {
      ok: true,
      mode: 'READ_ONLY_PREFLIGHT',
      writeAttempted: false,
      ready: result.evaluation.ready,
      reasons: result.evaluation.reasons,
      limits: REAL_RISK_LIMITS,
      normalized: result.evaluation.normalized,
      observedAt: result.observedAt,
      serverTime: result.serverTime,
      latencyMs: result.latencyMs,
    });
  } catch (e) {
    return send(res, 502, {
      ok: false,
      code: e?.code === 'PREFLIGHT_REQUEST_INVALID' ? e.code : 'BINANCE_PREFLIGHT_FAILED',
      error: 'Pré-contrôle Binance indisponible.',
      binanceCode: e?.binanceCode,
      status: e?.status,
    });
  }
}
