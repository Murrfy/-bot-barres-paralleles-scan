import { extractPriceFilter, priceAtLeastLinearPnl } from './real-protection-levels.mjs';

function n(value, fallback = NaN) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}
function bool(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}
function managedExitId(value) {
  return /^zth-EXI-[A-Za-z0-9._:-]+$/.test(String(value || ''));
}
function positionShape(position = {}) {
  const symbol = String(position?.symbol || '').toUpperCase();
  const side = String(position?.positionSide || 'BOTH').toUpperCase();
  const amount = n(position?.positionAmt ?? position?.quantity);
  const entryPrice = n(position?.entryPrice);
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('SYMBOL_INVALID');
  if (side !== 'BOTH') throw new Error('HEDGE_MODE_UNSUPPORTED');
  if (!Number.isFinite(amount) || amount === 0) throw new Error('POSITION_AMOUNT_INVALID');
  if (!(entryPrice > 0)) throw new Error('ENTRY_PRICE_INVALID');
  return {
    symbol,
    direction: amount > 0 ? 'LONG' : 'SHORT',
    quantity: Math.abs(amount),
    entryPrice,
    lifecycleAt: Math.max(0, Math.floor(n(
      position?.lifecycleAt ?? position?.positionLifecycleAt ?? position?.updateTime, 0
    ))),
  };
}
function exitCandidates(orders, live) {
  const expectedSide = live.direction === 'LONG' ? 'SELL' : 'BUY';
  return (Array.isArray(orders) ? orders : []).filter(order =>
    String(order?.orderClass || 'STANDARD').toUpperCase() === 'STANDARD' &&
    String(order?.symbol || '').toUpperCase() === live.symbol &&
    String(order?.side || '').toUpperCase() === expectedSide &&
    String(order?.positionSide || 'BOTH').toUpperCase() === 'BOTH' &&
    String(order?.type || '').toUpperCase() === 'LIMIT' &&
    bool(order?.reduceOnly)
  );
}
function exactPriceStatus(price, direction, entryPrice, priceFilter) {
  const filter = extractPriceFilter(priceFilter);
  const tick = n(filter?.tickSize);
  const min = n(filter?.minPrice, 0);
  const max = n(filter?.maxPrice, 0);
  const value = n(price);
  if (!(tick > 0)) return { ok:false, reason:'PRICE_TICK_REQUIRED' };
  if (!(value > 0)) return { ok:false, reason:'EXACT_SALE_PRICE_INVALID' };
  if (min > 0 && value < min) return { ok:false, reason:'PRICE_BELOW_EXCHANGE_MIN' };
  if (max > 0 && value > max) return { ok:false, reason:'PRICE_ABOVE_EXCHANGE_MAX' };
  const units = value / tick;
  if (Math.abs(units - Math.round(units)) > 1e-8) return { ok:false, reason:'EXACT_SALE_PRICE_NOT_ON_TICK' };
  if (direction === 'LONG' && !(value > entryPrice)) return { ok:false, reason:'LONG_TARGET_NOT_ABOVE_ENTRY' };
  if (direction === 'SHORT' && !(value < entryPrice)) return { ok:false, reason:'SHORT_TARGET_NOT_BELOW_ENTRY' };
  return { ok:true, price:value };
}

export function planAutomaticTargetExit({
  position,
  currentOrders = [],
  tokenSettings = {},
  settings = {},
  priceFilter,
  maxLossConfirmed = false,
} = {}) {
  const live = positionShape(position);
  if (maxLossConfirmed !== true) {
    return { action:'BLOCK', reason:'MAX_LOSS_NOT_CONFIRMED', live };
  }

  const candidates = exitCandidates(currentOrders, live);
  if (candidates.length > 1) {
    return { action:'BLOCK', reason:'MULTIPLE_EXIT_LIMITS', live, candidates };
  }
  if (candidates.length === 1) {
    const existing = candidates[0];
    if (!managedExitId(existing?.clientOrderId)) {
      return { action:'BLOCK', reason:'EXTERNAL_EXIT_LIMIT_PRESENT', live, existing };
    }
    const valid = String(existing?.timeInForce || '').toUpperCase() === 'GTC' &&
      n(existing?.price) > 0 &&
      n(existing?.origQty) > 0 &&
      Math.abs(n(existing?.origQty) - n(existing?.executedQty, 0) - live.quantity) <= Math.max(1e-9, live.quantity * 1e-10);
    if (!valid) {
      return { action:'BLOCK', reason:'MANAGED_EXIT_IDENTITY_INVALID', live, existing };
    }
    return { action:'NONE', reason:'MANAGED_TARGET_ALREADY_OPEN', live, existing };
  }

  const perToken = tokenSettings && typeof tokenSettings === 'object'
    ? (tokenSettings[live.symbol] && typeof tokenSettings[live.symbol] === 'object' ? tokenSettings[live.symbol] : {})
    : {};
  const global = settings && typeof settings === 'object' ? settings : {};
  const exactEnabled = perToken.exactSaleEnabled === true;
  const exactSale = n(perToken.exactSalePrice, 0);

  if (exactEnabled) {
    const checked = exactPriceStatus(exactSale, live.direction, live.entryPrice, priceFilter);
    if (!checked.ok) return { action:'BLOCK', reason:checked.reason, live };
    return {
      action:'PLACE',
      reason:'EXACT_SALE_TARGET_REQUIRED',
      live,
      targetPrice:checked.price,
      targetSource:'EXACT_SALE',
      requestedTargetProfitUsd:null,
    };
  }

  const targetProfitUsd = n(perToken.targetProfit, n(global.targetProfit));
  if (!(targetProfitUsd > 0)) {
    return { action:'BLOCK', reason:'TARGET_PROFIT_INVALID', live };
  }
  let level;
  try {
    level = priceAtLeastLinearPnl({
      entryPrice:live.entryPrice,
      quantity:live.quantity,
      direction:live.direction,
      pnlUsd:targetProfitUsd,
      priceFilter,
    });
  } catch (error) {
    return { action:'BLOCK', reason:String(error?.message || 'TARGET_PRICE_INVALID'), live };
  }
  return {
    action:'PLACE',
    reason:'CALCULATED_TARGET_REQUIRED',
    live,
    targetPrice:level.price,
    targetSource:'TARGET_PROFIT',
    requestedTargetProfitUsd:targetProfitUsd,
    actualTargetProfitUsd:level.actualPnlUsd,
  };
}
