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

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
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

async function requireZenithDevice(req) {
  const token = bearer(req);
  if (!token) return null;

  const raw = await redis(['GET', `${PREFIX}:device:${sha256(token)}`]);
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

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
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
      const err = new Error(data?.msg || `Binance HTTP ${r.status}`);
      err.status = r.status;
      err.binanceCode = data?.code;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function signedGet(path, apiKey, secret, serverTime) {
  const params = new URLSearchParams({
    timestamp: String(serverTime),
    recvWindow: String(RECV_WINDOW),
  });
  const signature = crypto.createHmac('sha256', secret).update(params.toString()).digest('hex');
  params.set('signature', signature);
  return jsonFetch(`${BASE}${path}?${params.toString()}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

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
    const time = await jsonFetch(`${BASE}/fapi/v1/time`);
    const serverTime = Number(time?.serverTime);
    if (!Number.isFinite(serverTime)) throw new Error('Heure Binance indisponible.');

    const [balance, positions, account, openOrders] = await Promise.all([
      signedGet('/fapi/v3/balance', apiKey, secret, serverTime),
      signedGet('/fapi/v3/positionRisk', apiKey, secret, serverTime),
      signedGet('/fapi/v3/account', apiKey, secret, serverTime),
      signedGet('/fapi/v1/openOrders', apiKey, secret, serverTime),
    ]);

    const usdt = Array.isArray(balance) ? balance.find(x => x.asset === 'USDT') : null;
    const livePositions = (Array.isArray(positions) ? positions : [])
      .filter(p => Math.abs(Number(p.positionAmt || 0)) > 0)
      .map(p => ({
        symbol: p.symbol,
        positionSide: p.positionSide,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        breakEvenPrice: p.breakEvenPrice,
        markPrice: p.markPrice,
        unrealizedProfit: p.unRealizedProfit ?? p.unrealizedProfit,
        liquidationPrice: p.liquidationPrice,
        leverage: p.leverage,
        marginType: p.marginType,
        isolatedMargin: p.isolatedMargin,
        notional: p.notional,
        updateTime: p.updateTime,
      }));

    return send(res, 200, {
      ok: true,
      mode: 'READ_ONLY',
      serverTime,
      latencyMs: Date.now() - started,
      usdt: usdt ? {
        balance: usdt.balance,
        availableBalance: usdt.availableBalance,
        crossWalletBalance: usdt.crossWalletBalance,
        crossUnPnl: usdt.crossUnPnl,
        maxWithdrawAmount: usdt.maxWithdrawAmount,
      } : null,
      account: {
        totalWalletBalance: account?.totalWalletBalance,
        totalUnrealizedProfit: account?.totalUnrealizedProfit,
        availableBalance: account?.availableBalance,
        totalInitialMargin: account?.totalInitialMargin,
        totalMaintMargin: account?.totalMaintMargin,
      },
      positions: livePositions,
      openOrders: Array.isArray(openOrders) ? openOrders.length : 0,
    });
  } catch (e) {
    return send(res, 502, {
      ok: false,
      code: 'BINANCE_READ_FAILED',
      error: e?.message || 'Connexion Binance impossible.',
      binanceCode: e?.binanceCode ?? null,
    });
  }
}
