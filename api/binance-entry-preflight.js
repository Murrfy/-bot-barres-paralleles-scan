import crypto from 'node:crypto';
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
    if (!device?.deviceId || !['controller','master'].includes(device?.role)) return null;
    const roleKey = device.role === 'master'
      ? `${PREFIX}:role-device:master`
      : `${PREFIX}:role-device:controller`;
    const owner = await redis(['GET', roleKey]);
    if (!owner || String(owner) !== String(device.deviceId)) return null;
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
    return send(res, 401, { ok: false, code: 'UNAUTHORIZED_DEVICE' });
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

  const startedAt = Date.now();

  try {
    const [time, exchangeInfo, ticker] = await Promise.all([
      jsonFetch(`${BASE}/fapi/v1/time`),
      jsonFetch(`${BASE}/fapi/v1/exchangeInfo`),
      jsonFetch(`${BASE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`),
    ]);
    const serverTime = Number(time?.serverTime);
    if (!Number.isFinite(serverTime)) throw new Error('Heure Binance indisponible.');

    const [symbolConfigRaw, bracketsRaw, positionMode, account, positions, standardOrders, algoOrders] = await Promise.all([
      signedGet('/fapi/v1/symbolConfig', apiKey, secret, serverTime, { symbol }),
      signedGet('/fapi/v1/leverageBracket', apiKey, secret, serverTime, { symbol }),
      signedGet('/fapi/v1/positionSide/dual', apiKey, secret, serverTime),
      signedGet('/fapi/v3/account', apiKey, secret, serverTime),
      signedGet('/fapi/v3/positionRisk', apiKey, secret, serverTime),
      signedGet('/fapi/v1/openOrders', apiKey, secret, serverTime, { symbol }),
      signedGet('/fapi/v1/openAlgoOrders', apiKey, secret, serverTime, { symbol, algoType: 'CONDITIONAL' }),
    ]);

    const symbolInfo = (Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [])
      .find(x => String(x?.symbol || '').toUpperCase() === symbol) || null;
    const symbolConfig = firstForSymbol(symbolConfigRaw, symbol);
    const bracketInfo = firstForSymbol(bracketsRaw, symbol);
    const usdt = (Array.isArray(account?.assets) ? account.assets : [])
      .find(x => String(x?.asset || '').toUpperCase() === 'USDT') || {};
    const referencePrice = requestedPrice > 0 ? requestedPrice : number(ticker?.price);

    const evaluation = evaluateEntryRisk({
      symbol,
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

    return send(res, 200, {
      ok: true,
      mode: 'READ_ONLY_PREFLIGHT',
      writeAttempted: false,
      ready: evaluation.ready,
      reasons: evaluation.reasons,
      limits: REAL_RISK_LIMITS,
      normalized: evaluation.normalized,
      observedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
    });
  } catch (e) {
    return send(res, 502, {
      ok: false,
      code: 'BINANCE_PREFLIGHT_FAILED',
      error: e?.message || 'Pré-contrôle Binance indisponible.',
      binanceCode: e?.binanceCode,
      status: e?.status,
      latencyMs: Date.now() - startedAt,
    });
  }
}
