import crypto from 'node:crypto';

const BINANCE_API_BASE = 'https://api.binance.com';
const BINANCE_API_RESTRICTIONS_PATH = '/sapi/v1/account/apiRestrictions';
const BINANCE_API_TIME_PATH = '/api/v3/time';
const BINANCE_PERMISSION_RECV_WINDOW = 5000;
const BINANCE_PERMISSION_TIMEOUT_MS = 8000;

export function binanceApiPermissionBlockers(permission) {
  if (!permission || typeof permission !== 'object') return ['BINANCE_API_PERMISSIONS_UNAVAILABLE'];
  const blockers = [];
  if (permission.ipRestrict !== true) blockers.push('BINANCE_API_IP_RESTRICTION_REQUIRED');
  if (permission.enableReading !== true) blockers.push('BINANCE_API_READING_REQUIRED');
  if (permission.enableFutures !== true) blockers.push('BINANCE_API_FUTURES_REQUIRED');
  const forbidden = [
    ['enableWithdrawals', 'BINANCE_API_WITHDRAWALS_MUST_BE_DISABLED'],
    ['enableInternalTransfer', 'BINANCE_API_INTERNAL_TRANSFER_MUST_BE_DISABLED'],
    ['enableMargin', 'BINANCE_API_MARGIN_MUST_BE_DISABLED'],
    ['permitsUniversalTransfer', 'BINANCE_API_UNIVERSAL_TRANSFER_MUST_BE_DISABLED'],
    ['enableVanillaOptions', 'BINANCE_API_OPTIONS_MUST_BE_DISABLED'],
    ['enableFixApiTrade', 'BINANCE_API_FIX_TRADE_MUST_BE_DISABLED'],
    ['enableSpotAndMarginTrading', 'BINANCE_API_SPOT_MARGIN_TRADING_MUST_BE_DISABLED'],
    ['enablePortfolioMarginTrading', 'BINANCE_API_PORTFOLIO_MARGIN_MUST_BE_DISABLED'],
  ];
  for (const [field, code] of forbidden) {
    if (permission[field] === true) blockers.push(code);
  }
  return blockers;
}

async function binanceJson(url, init = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BINANCE_PERMISSION_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, cache: 'no-store', signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok || data?.code) {
      const error = new Error('BINANCE_API_PERMISSION_CHECK_FAILED');
      error.code = 'BINANCE_API_PERMISSION_CHECK_FAILED';
      error.status = response.status;
      error.binanceCode = data?.code ?? null;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBinanceApiPermissions({
  apiKey = process.env.BINANCE_API_KEY || '',
  secret = process.env.BINANCE_API_SECRET || '',
  fetchImpl = fetch,
} = {}) {
  if (!apiKey || !secret) {
    const error = new Error('BINANCE_API_CREDENTIALS_MISSING');
    error.code = 'BINANCE_API_CREDENTIALS_MISSING';
    throw error;
  }

  const time = await binanceJson(`${BINANCE_API_BASE}${BINANCE_API_TIME_PATH}`, {}, fetchImpl);
  const serverTime = Number(time?.serverTime);
  if (!Number.isFinite(serverTime)) {
    const error = new Error('BINANCE_API_PERMISSION_CHECK_FAILED');
    error.code = 'BINANCE_API_PERMISSION_CHECK_FAILED';
    throw error;
  }

  const query = new URLSearchParams({
    timestamp: String(serverTime),
    recvWindow: String(BINANCE_PERMISSION_RECV_WINDOW),
  });
  const signature = crypto.createHmac('sha256', secret).update(query.toString()).digest('hex');
  query.set('signature', signature);

  return binanceJson(
    `${BINANCE_API_BASE}${BINANCE_API_RESTRICTIONS_PATH}?${query.toString()}`,
    { method: 'GET', headers: { 'X-MBX-APIKEY': apiKey } },
    fetchImpl,
  );
}
