// Lecture seule : bougies publiques Binance Futures (aucune clé, aucun ordre, aucun accès au compte).
// GET /api/market-klines?symbol=SUNUSDT&interval=4h&limit=500
// GET /api/market-klines?list=1   -> liste des contrats perpétuels USDT en cours
const BASE = 'https://fapi.binance.com';
const INTERVALS = new Set(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w']);
const SYMBOL_RE = /^[A-Z0-9]{2,24}(USDT|USDC)$/;

function send(res, status, body, cacheSeconds) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Cache-Control',
    cacheSeconds > 0
      ? `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}`
      : 'no-store'
  );
  res.status(status).send(JSON.stringify(body));
}

async function publicGet(path) {
  const r = await fetch(BASE + path, {
    method: 'GET',
    signal: AbortSignal.timeout(7000),
    cache: 'no-store',
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok || data === null) {
    const e = new Error('BINANCE_HTTP_' + r.status);
    e.status = r.status;
    throw e;
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'GET_ONLY' }, 0);
  const q = req.query || {};

  try {
    if (String(q.list || '') === '1') {
      const info = await publicGet('/fapi/v1/exchangeInfo');
      const symbols = (info?.symbols || [])
        .filter(s => s?.status === 'TRADING' && s?.contractType === 'PERPETUAL' && s?.quoteAsset === 'USDT')
        .map(s => String(s.symbol))
        .sort();
      return send(res, 200, { ok: true, readOnly: true, count: symbols.length, symbols }, 3600);
    }

    const symbol = String(q.symbol || '').toUpperCase().trim();
    const interval = String(q.interval || '4h').trim();
    const limitRaw = Number.parseInt(String(q.limit || '500'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(10, limitRaw)) : 500;
    if (!SYMBOL_RE.test(symbol)) return send(res, 400, { ok: false, error: 'BAD_SYMBOL' }, 0);
    if (!INTERVALS.has(interval)) return send(res, 400, { ok: false, error: 'BAD_INTERVAL' }, 0);

    const rows = await publicGet(
      `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`
    );
    const candles = (Array.isArray(rows) ? rows : []).map(k => ({
      t: Number(k[0]),
      o: Number(k[1]),
      h: Number(k[2]),
      l: Number(k[3]),
      c: Number(k[4]),
      v: Number(k[5]),
    }));
    return send(res, 200, { ok: true, readOnly: true, symbol, interval, count: candles.length, candles }, 60);
  } catch (e) {
    const upstream = Number(e?.status) || 0;
    const code = upstream === 400 ? 'UNKNOWN_SYMBOL' : upstream === 429 || upstream === 418 ? 'BINANCE_BUSY' : 'UPSTREAM_ERROR';
    return send(res, upstream === 400 ? 404 : 502, { ok: false, error: code }, 0);
  }
}
