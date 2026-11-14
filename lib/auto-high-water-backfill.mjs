// Rattrapage du meilleur gain atteint (high-water) d'une position ouverte.
// Utilisé après une (re)connexion du MASTER : une mèche qui a touché un seuil de
// protection de gain pendant que Zenith était déconnecté doit quand même armer la protection.
// Lecture seule (prix de marque Binance). Jamais d'ordre ici.
const MINUTE_MS = 60 * 1000;

function n(value, fallback = NaN) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

// Départ = première minute ENTIÈRE après l'ouverture de la position : on ne prend jamais
// un prix antérieur à l'ouverture (sinon on pourrait armer une protection à tort).
export function backfillStartTime(lifecycleAt, now = Date.now()) {
  const lifecycle = Math.floor(n(lifecycleAt, 0));
  if (!(lifecycle > 0)) return 0;
  const start = Math.ceil(lifecycle / MINUTE_MS) * MINUTE_MS;
  return start < n(now, Date.now()) ? start : 0;
}

// Prix le plus favorable observé (LONG : plus haut ; SHORT : plus bas) dans des bougies
// Binance markPriceKlines [openTime, open, high, low, close, ...].
export function favorableExtremeFromMarkKlines(klines, { direction, startTime } = {}) {
  const dir = String(direction || '').toUpperCase();
  if (!['LONG', 'SHORT'].includes(dir)) return NaN;
  const from = n(startTime, 0);
  let best = NaN;
  for (const row of Array.isArray(klines) ? klines : []) {
    if (!Array.isArray(row)) continue;
    const openTime = n(row[0]);
    if (!(openTime >= from)) continue;
    const price = dir === 'LONG' ? n(row[2]) : n(row[3]);
    if (!(price > 0)) continue;
    if (!Number.isFinite(best)) best = price;
    else best = dir === 'LONG' ? Math.max(best, price) : Math.min(best, price);
  }
  return best;
}

export function highWaterProfitFromExtreme({ position, extremePrice } = {}) {
  const amount = n(position?.positionAmt ?? position?.quantity, 0);
  const qty = Math.abs(amount);
  const entry = n(position?.entryPrice, 0);
  const px = n(extremePrice, 0);
  if (!(qty > 0) || !(entry > 0) || !(px > 0)) return NaN;
  return (amount >= 0 ? 1 : -1) * (px - entry) * qty;
}

// Blocage d'IP par Binance (HTTP 418 « banned until <ms> » ou 429 « too many requests »).
// Renvoie l'instant (ms) jusqu'auquel AUCUNE requête publique ne doit partir, ou 0.
// Réessayer pendant un blocage le prolonge : il faut se taire jusqu'à la fin + une marge.
export function binancePublicPauseUntil({ status, message, retryAfter, now = Date.now() } = {}) {
  const t = n(now, Date.now());
  const match = /banned until (\d{12,})/i.exec(String(message || ''));
  if (match) {
    const until = n(match[1], 0);
    if (until > t) return until + 5000;
  }
  const code = Math.floor(n(status, 0));
  if (code === 418 || code === 429) {
    const seconds = n(retryAfter, 0);
    return t + (seconds > 0 ? seconds * 1000 : 60000) + 2000;
  }
  return 0;
}

// Délai avant la prochaine tentative de rattrapage : jamais pendant un blocage Binance,
// et de plus en plus espacé (3 s, 6 s, 12 s… plafonné à 60 s) en cas d'échecs répétés.
export function markRecoveryRetryDelay({ attempt = 0, pauseUntil = 0, now = Date.now() } = {}) {
  const t = n(now, Date.now());
  const k = Math.max(0, Math.floor(n(attempt, 0)));
  const backoff = Math.min(60000, 3000 * 2 ** Math.min(k, 5));
  const pause = n(pauseUntil, 0) > t ? n(pauseUntil, 0) - t + 1000 : 0;
  return Math.max(backoff, pause);
}
