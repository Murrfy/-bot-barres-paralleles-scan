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
