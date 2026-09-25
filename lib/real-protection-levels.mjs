import { REAL_RISK_LIMITS } from './risk-policy.mjs';

function n(value, fallback = NaN) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function decimals(step) {
  const text = String(step || '');
  if (!text.includes('.')) return 0;
  return Math.min(12, text.split('.')[1].replace(/0+$/, '').length);
}

function cleanDirection(value) {
  const direction = String(value || '').toUpperCase();
  if (!['LONG', 'SHORT'].includes(direction)) throw new Error('DIRECTION_INVALID');
  return direction;
}

function positionShape(position = {}) {
  const side = String(position?.positionSide || 'BOTH').toUpperCase();
  if (side !== 'BOTH') throw new Error('HEDGE_MODE_UNSUPPORTED');
  const amount = n(position?.positionAmt ?? position?.quantity);
  if (!Number.isFinite(amount) || amount === 0) throw new Error('POSITION_AMOUNT_INVALID');
  const entryPrice = n(position?.entryPrice);
  if (!(entryPrice > 0)) throw new Error('ENTRY_PRICE_INVALID');
  return {
    symbol: String(position?.symbol || '').toUpperCase(),
    direction: amount > 0 ? 'LONG' : 'SHORT',
    quantity: Math.abs(amount),
    entryPrice,
  };
}

export function extractPriceFilter(source = {}) {
  if (String(source?.filterType || '').toUpperCase() === 'PRICE_FILTER') return source;
  if (Number(source?.tickSize) > 0) return source;
  const filters = Array.isArray(source?.filters) ? source.filters : [];
  return filters.find(f => String(f?.filterType || '').toUpperCase() === 'PRICE_FILTER') || null;
}

function normalizePriceFilter(source = {}) {
  const filter = extractPriceFilter(source);
  const tickSize = n(filter?.tickSize);
  const minPrice = n(filter?.minPrice, 0);
  const maxPrice = n(filter?.maxPrice, 0);
  if (!(tickSize > 0)) throw new Error('PRICE_TICK_REQUIRED');
  return { tickSize, minPrice, maxPrice };
}

function roundDirectional(rawPrice, direction, tickSize) {
  const raw = n(rawPrice);
  const tick = n(tickSize);
  if (!(raw > 0) || !(tick > 0)) throw new Error('PRICE_ROUNDING_INPUT_INVALID');
  const units = raw / tick;
  const roundedUnits = direction === 'LONG'
    ? Math.ceil(units - 1e-10)
    : Math.floor(units + 1e-10);
  return Number((roundedUnits * tick).toFixed(decimals(tick)));
}

function alignedToTick(price, tickSize) {
  const priceValue = n(price);
  const tick = n(tickSize);
  if (!(priceValue > 0) || !(tick > 0)) return false;
  const units = priceValue / tick;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

function nearestTickCandidates(rawPrice, tickSize) {
  const raw = n(rawPrice);
  const tick = n(tickSize);
  const units = raw / tick;
  const low = Math.floor(units + 1e-10) * tick;
  const high = Math.ceil(units - 1e-10) * tick;
  const d = decimals(tick);
  return {
    lower: Number(low.toFixed(d)),
    upper: Number(high.toFixed(d)),
  };
}

function enforcePriceBounds(price, { minPrice, maxPrice }) {
  if (!(price > 0)) throw new Error('PRICE_INVALID');
  if (minPrice > 0 && price < minPrice) throw new Error('PRICE_BELOW_EXCHANGE_MIN');
  if (maxPrice > 0 && price > maxPrice) throw new Error('PRICE_ABOVE_EXCHANGE_MAX');
  return price;
}

export function pnlAtLinearPrice({
  entryPrice,
  quantity,
  direction,
  price,
} = {}) {
  const entry = n(entryPrice);
  const qty = n(quantity);
  const mark = n(price);
  const dir = cleanDirection(direction);
  if (!(entry > 0) || !(qty > 0) || !(mark > 0)) throw new Error('PNL_INPUT_INVALID');
  const sign = dir === 'LONG' ? 1 : -1;
  return sign * (mark - entry) * qty;
}

export function priceForLinearPnl({
  entryPrice,
  quantity,
  direction,
  pnlUsd,
} = {}) {
  const entry = n(entryPrice);
  const qty = n(quantity);
  const pnl = n(pnlUsd);
  const dir = cleanDirection(direction);
  if (!(entry > 0) || !(qty > 0) || !Number.isFinite(pnl)) throw new Error('PNL_INPUT_INVALID');
  const sign = dir === 'LONG' ? 1 : -1;
  const price = entry + (pnl / (sign * qty));
  if (!(price > 0)) throw new Error('PNL_PRICE_NON_POSITIVE');
  return price;
}

export function priceAtLeastLinearPnl({
  entryPrice,
  quantity,
  direction,
  pnlUsd,
  priceFilter,
} = {}) {
  const filter = normalizePriceFilter(priceFilter);
  const rawPrice = priceForLinearPnl({ entryPrice, quantity, direction, pnlUsd });
  const price = enforcePriceBounds(
    roundDirectional(rawPrice, cleanDirection(direction), filter.tickSize),
    filter
  );
  const actualPnlUsd = pnlAtLinearPrice({
    entryPrice,
    quantity,
    direction,
    price,
  });
  if (actualPnlUsd + 1e-8 < n(pnlUsd)) throw new Error('PNL_FLOOR_NOT_PRESERVED');
  return {
    price,
    requestedPnlUsd: n(pnlUsd),
    actualPnlUsd,
    tickSize: filter.tickSize,
  };
}

export function highestReachedProtectionStage(stages, observedProfitUsd) {
  const observed = n(observedProfitUsd);
  if (!Number.isFinite(observed)) throw new Error('OBSERVED_PROFIT_INVALID');
  const rows = Array.isArray(stages) ? stages : [];
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    if (row.enabled === false) continue;
    const armProfitUsd = n(row.arm);
    const protectedProfitUsd = n(row.floor);
    if (!(armProfitUsd >= 0) || !(protectedProfitUsd >= 0) || !(protectedProfitUsd < armProfitUsd)) continue;
    if (observed + 1e-8 < armProfitUsd) continue;
    if (!best ||
        armProfitUsd > best.armProfitUsd ||
        (armProfitUsd === best.armProfitUsd && protectedProfitUsd > best.protectedProfitUsd)) {
      best = {
        index: i,
        armProfitUsd,
        protectedProfitUsd,
      };
    }
  }
  return best;
}

export function buildProgressiveProtectionLevel({
  position,
  armProfitUsd,
  protectedProfitUsd,
  priceFilter,
} = {}) {
  const live = positionShape(position);
  const arm = n(armProfitUsd);
  const protectedPnl = n(protectedProfitUsd);
  if (!(arm > 0)) throw new Error('ARM_PROFIT_INVALID');
  if (!(protectedPnl >= 0)) throw new Error('PROTECTED_PROFIT_INVALID');
  if (!(protectedPnl < arm)) throw new Error('PROTECTED_PROFIT_MUST_BE_BELOW_ARM');

  const floor = priceAtLeastLinearPnl({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    pnlUsd: protectedPnl,
    priceFilter,
  });

  return {
    version: 2,
    symbol: live.symbol,
    direction: live.direction,
    quantity: live.quantity,
    entryPrice: live.entryPrice,
    armProfitUsd: arm,
    protectedProfitUsd: protectedPnl,
    triggerPrice: floor.price,
    limitPrice: floor.price,
    actualProtectedProfitUsd: floor.actualPnlUsd,
    tickSize: floor.tickSize,
    grossPricePnlOnly: true,
  };
}

export function buildEmergencyMaxLossLevel({
  position,
  maxLossUsd,
  priceFilter,
  hardMaxLossUsd = REAL_RISK_LIMITS.maxLossUsd,
} = {}) {
  const live = positionShape(position);
  const loss = n(maxLossUsd);
  const hardLoss = n(hardMaxLossUsd);
  if (!(loss > 0)) throw new Error('MAX_LOSS_INVALID');
  if (!(hardLoss > 0) || loss > hardLoss + 1e-9) throw new Error('MAX_LOSS_EXCEEDS_SERVER_LIMIT');

  const filter = normalizePriceFilter(priceFilter);
  const rawMaxLoss = priceForLinearPnl({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    pnlUsd: -loss,
  });
  const triggerPrice = enforcePriceBounds(
    roundDirectional(rawMaxLoss, live.direction, filter.tickSize),
    filter
  );
  const actualPnlUsd = pnlAtLinearPrice({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    price: triggerPrice,
  });
  const actualMaxLossUsd = Math.max(0, -actualPnlUsd);

  if (live.direction === 'LONG' && !(triggerPrice < live.entryPrice)) throw new Error('LONG_MAX_LOSS_NOT_BELOW_ENTRY');
  if (live.direction === 'SHORT' && !(triggerPrice > live.entryPrice)) throw new Error('SHORT_MAX_LOSS_NOT_ABOVE_ENTRY');
  if (actualMaxLossUsd > hardLoss + 1e-8) throw new Error('MAX_LOSS_EXCEEDS_SERVER_LIMIT');

  return {
    version: 1,
    symbol: live.symbol,
    direction: live.direction,
    quantity: live.quantity,
    entryPrice: live.entryPrice,
    maxLossUsd: loss,
    triggerPrice,
    actualMaxLossUsd,
    tickSize: filter.tickSize,
    grossPricePnlOnly: true,
  };
}

export function buildRealProtectionLevels({
  position,
  targetProfitUsd,
  maxLossUsd,
  priceFilter,
  hardMaxLossUsd = REAL_RISK_LIMITS.maxLossUsd,
} = {}) {
  const live = positionShape(position);
  const target = n(targetProfitUsd);
  const loss = n(maxLossUsd);
  const hardLoss = n(hardMaxLossUsd);
  if (!(target > 0)) throw new Error('TARGET_PROFIT_INVALID');
  if (!(loss > 0)) throw new Error('MAX_LOSS_INVALID');
  if (!(hardLoss > 0) || loss > hardLoss + 1e-9) throw new Error('MAX_LOSS_EXCEEDS_SERVER_LIMIT');

  const filter = normalizePriceFilter(priceFilter);
  const rawTarget = priceForLinearPnl({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    pnlUsd: target,
  });
  const rawMaxLoss = priceForLinearPnl({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    pnlUsd: -loss,
  });

  const targetLevel = priceAtLeastLinearPnl({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    pnlUsd: target,
    priceFilter: filter,
  });
  const targetPrice = targetLevel.price;
  const maxLossTriggerPrice = enforcePriceBounds(
    roundDirectional(rawMaxLoss, live.direction, filter.tickSize),
    filter
  );

  const actualTargetProfitUsd = pnlAtLinearPrice({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    price: targetPrice,
  });
  const actualStopPnlUsd = pnlAtLinearPrice({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    price: maxLossTriggerPrice,
  });
  const actualMaxLossUsd = Math.max(0, -actualStopPnlUsd);

  if (live.direction === 'LONG') {
    if (!(targetPrice > live.entryPrice)) throw new Error('LONG_TARGET_NOT_ABOVE_ENTRY');
    if (!(maxLossTriggerPrice < live.entryPrice)) throw new Error('LONG_MAX_LOSS_NOT_BELOW_ENTRY');
  } else {
    if (!(targetPrice < live.entryPrice)) throw new Error('SHORT_TARGET_NOT_BELOW_ENTRY');
    if (!(maxLossTriggerPrice > live.entryPrice)) throw new Error('SHORT_MAX_LOSS_NOT_ABOVE_ENTRY');
  }
  if (actualMaxLossUsd > hardLoss + 1e-8) throw new Error('MAX_LOSS_EXCEEDS_SERVER_LIMIT');

  return {
    version: 1,
    symbol: live.symbol,
    direction: live.direction,
    quantity: live.quantity,
    entryPrice: live.entryPrice,
    targetProfitUsd: target,
    targetPrice,
    actualTargetProfitUsd,
    maxLossUsd: loss,
    maxLossTriggerPrice,
    actualMaxLossUsd,
    tickSize: filter.tickSize,
    grossPricePnlOnly: true,
  };
}

export function validateMaxLossTrigger({
  position,
  triggerPrice,
  hardMaxLossUsd = REAL_RISK_LIMITS.maxLossUsd,
} = {}) {
  const live = positionShape(position);
  const trigger = n(triggerPrice);
  const hardLoss = n(hardMaxLossUsd);
  if (!(trigger > 0)) throw new Error('TRIGGER_PRICE_INVALID');
  if (!(hardLoss > 0)) throw new Error('MAX_LOSS_LIMIT_INVALID');

  const pnlUsd = pnlAtLinearPrice({
    entryPrice: live.entryPrice,
    quantity: live.quantity,
    direction: live.direction,
    price: trigger,
  });
  const impliedLossUsd = Math.max(0, -pnlUsd);

  if (live.direction === 'LONG' && !(trigger < live.entryPrice)) {
    throw new Error('LONG_MAX_LOSS_TRIGGER_NOT_BELOW_ENTRY');
  }
  if (live.direction === 'SHORT' && !(trigger > live.entryPrice)) {
    throw new Error('SHORT_MAX_LOSS_TRIGGER_NOT_ABOVE_ENTRY');
  }
  if (impliedLossUsd > hardLoss + 1e-8) {
    const e = new Error('MAX_LOSS_EXCEEDS_SERVER_LIMIT');
    e.impliedLossUsd = impliedLossUsd;
    e.hardMaxLossUsd = hardLoss;
    throw e;
  }

  return {
    direction: live.direction,
    quantity: live.quantity,
    entryPrice: live.entryPrice,
    triggerPrice: trigger,
    impliedLossUsd,
    hardMaxLossUsd: hardLoss,
    grossPricePnlOnly: true,
  };
}
