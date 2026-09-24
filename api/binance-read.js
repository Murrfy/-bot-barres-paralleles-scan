import crypto from 'node:crypto';
import { deviceTokenCandidates, deviceSessionRecordActive, roleAssignmentKey, deviceRoleAssignmentActive, engineInstanceHeader, enginePrincipalInstanceActive } from '../lib/device-session.mjs';

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
const BINANCE_READ_RATE_LIMIT_PER_MINUTE = 12;

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
    signal: AbortSignal.timeout(8000),
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
  for (const token of deviceTokenCandidates(req)) {
    const tokenHash = sha256(token);
    const raw = await redis(['GET', `${PREFIX}:device:${tokenHash}`]);
    if (!raw) continue;
    try {
      const device = JSON.parse(raw);
      if (!deviceSessionRecordActive(device) || !device?.deviceId || !['controller', 'master'].includes(device?.role)) continue;
      const roleKey = device.role === 'master'
        ? `${PREFIX}:role-device:master`
        : `${PREFIX}:role-device:controller`;
      const owner = await redis(['GET', roleKey]);
      if (!owner || String(owner) !== String(device.deviceId)) continue;
      const issuedAt=await redis(['GET',roleAssignmentKey(PREFIX,device.role)]);
      if(!deviceRoleAssignmentActive(device,issuedAt))continue;
      if(String(device?.principal||'')==='engine'){
        const suppliedInstance=engineInstanceHeader(req);
        const [currentInstance,currentLease]=await Promise.all([
          redis(['GET',`${PREFIX}:engine-instance`]),
          redis(['GET',`${PREFIX}:master`]),
        ]);
        if(!enginePrincipalInstanceActive(device,suppliedInstance,String(currentInstance||''))){
          const e=new Error('ENGINE_INSTANCE_FENCED');e.code='ENGINE_INSTANCE_FENCED';throw e;
        }
        if(String(currentLease||'')!==String(device.deviceId||'')){
          const e=new Error('MASTER_LEASE_REQUIRED');e.code='MASTER_LEASE_REQUIRED';throw e;
        }
      }
      return device;
    } catch (e) {
      if (e?.code === 'ENGINE_INSTANCE_FENCED' || e?.code === 'MASTER_LEASE_REQUIRED') throw e;
    }
  }
  return null;
}

async function binanceReadRateAllowed(deviceId) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${PREFIX}:rate:binance-read:${sha256(deviceId)}:${bucket}`;
  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count = Number(await redis(['EVAL', script, '1', key, '120'])) || 0;
  return count <= BINANCE_READ_RATE_LIMIT_PER_MINUTE;
}

function retryAfterSeconds() {
  return Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
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

export function normalizeAlgoOrderDetails(openAlgoOrders) {
  return (Array.isArray(openAlgoOrders) ? openAlgoOrders : []).map(o => ({
    symbol: String(o?.symbol || '').toUpperCase(),
    algoId: String(o?.algoId ?? ''),
    clientAlgoId: String(o?.clientAlgoId ?? o?.clientOrderId ?? ''),
    side: String(o?.side || '').toUpperCase(),
    positionSide: String(o?.positionSide || 'BOTH').toUpperCase(),
    type: String(o?.orderType ?? o?.type ?? '').toUpperCase(),
    status: String(o?.algoStatus ?? o?.status ?? '').toUpperCase(),
    origQty: String(o?.quantity ?? o?.origQty ?? ''),
    price: String(o?.price ?? ''),
    triggerPrice: String(o?.triggerPrice ?? o?.stopPrice ?? ''),
    reduceOnly: o?.reduceOnly === true || o?.reduceOnly === 'true',
    closePosition: o?.closePosition === true || o?.closePosition === 'true',
    timeInForce: String(o?.timeInForce || ''),
    workingType: String(o?.workingType || ''),
    priceMatch: String(o?.priceMatch || ''),
    updateTime: Number(o?.updateTime ?? o?.time ?? o?.createTime ?? 0),
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });

  let device = null;
  try {
    device = await requireZenithDevice(req);
  } catch (e) {
    if (e?.code === 'ENGINE_INSTANCE_FENCED' || e?.code === 'MASTER_LEASE_REQUIRED') {
      return send(res, 409, {
        ok: false,
        code: e.code,
        error: e.code === 'ENGINE_INSTANCE_FENCED'
          ? 'Instance moteur Zenith révoquée.'
          : 'Bail MASTER Zenith requis.',
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
      code: 'UNAUTHORIZED_DEVICE',
      error: 'Appareil Zenith non autorisé.',
    });
  }

  try {
    if (!(await binanceReadRateAllowed(device.deviceId))) {
      const retryAfter = retryAfterSeconds();
      res.setHeader('Retry-After', String(retryAfter));
      return send(res, 429, {
        ok: false,
        code: 'BINANCE_READ_RATE_LIMIT',
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
    const time = await jsonFetch(`${BASE}/fapi/v1/time`);
    const serverTime = Number(time?.serverTime);
    if (!Number.isFinite(serverTime)) throw new Error('Heure Binance indisponible.');

    const [balance, positions, account, openOrders, openAlgoOrders] = await Promise.all([
      signedGet('/fapi/v3/balance', apiKey, secret, serverTime),
      signedGet('/fapi/v3/positionRisk', apiKey, secret, serverTime),
      signedGet('/fapi/v3/account', apiKey, secret, serverTime),
      signedGet('/fapi/v1/openOrders', apiKey, secret, serverTime),
      signedGet('/fapi/v1/openAlgoOrders', apiKey, secret, serverTime, { algoType: 'CONDITIONAL' }),
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

    const standardOrderDetails = (Array.isArray(openOrders) ? openOrders : []).map(o => ({
      symbol: String(o?.symbol || '').toUpperCase(),
      orderId: String(o?.orderId ?? ''),
      clientOrderId: String(o?.clientOrderId ?? ''),
      side: String(o?.side || '').toUpperCase(),
      positionSide: String(o?.positionSide || 'BOTH').toUpperCase(),
      type: String(o?.type || '').toUpperCase(),
      status: String(o?.status || '').toUpperCase(),
      origQty: String(o?.origQty ?? ''),
      executedQty: String(o?.executedQty ?? ''),
      price: String(o?.price ?? ''),
      reduceOnly: o?.reduceOnly === true || o?.reduceOnly === 'true',
      timeInForce: String(o?.timeInForce || ''),
      updateTime: Number(o?.updateTime ?? o?.time ?? 0),
    }));

    const algoOrderDetails = normalizeAlgoOrderDetails(openAlgoOrders);

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
      openOrders: (Array.isArray(openOrders) ? openOrders.length : 0) + (Array.isArray(openAlgoOrders) ? openAlgoOrders.length : 0),
      standardOpenOrders: Array.isArray(openOrders) ? openOrders.length : 0,
      standardOrderDetails,
      algoOpenOrders: Array.isArray(openAlgoOrders) ? openAlgoOrders.length : 0,
      algoOrderDetails,
    });
  } catch (e) {
    return send(res, 502, {
      ok: false,
      code: 'BINANCE_READ_FAILED',
      error: 'Connexion Binance impossible.',
      binanceCode: e?.binanceCode ?? null,
    });
  }
}
