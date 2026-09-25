export const REAL_RISK_LIMITS = Object.freeze({
  maxActivePositions: 3,
  maxLeverage: 10,
  maxMarginUsdt: 1000,
  maxNotionalUsdt: 10000,
  maxLossUsd: 400,
});

function num(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function decimals(step) {
  const text = String(step || '');
  if (!text.includes('.')) return 0;
  return Math.min(12, text.split('.')[1].replace(/0+$/,'').length);
}

function floorStep(value, step) {
  const v = num(value);
  const s = num(step);
  if (!(s > 0)) return v;
  return Number((Math.floor((v + s * 1e-10) / s) * s).toFixed(decimals(s)));
}

function filterMap(symbolInfo) {
  const out = {};
  for (const filter of Array.isArray(symbolInfo?.filters) ? symbolInfo.filters : []) {
    if (filter?.filterType) out[filter.filterType] = filter;
  }
  return out;
}

function alignedToStep(value, step) {
  const v = num(value, NaN);
  const s = num(step, NaN);
  if (!Number.isFinite(v) || !Number.isFinite(s) || !(s > 0)) return true;
  const units = v / s;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

function isProtectiveOrder(order) {
  return order?.reduceOnly === true || order?.reduceOnly === 'true' ||
    order?.closePosition === true || order?.closePosition === 'true';
}

function activePositionCount(positions) {
  return (Array.isArray(positions) ? positions : []).filter(p => Math.abs(num(p?.positionAmt)) > 0).length;
}

function bracketForNotional(bracketInfo, notional) {
  const rows = Array.isArray(bracketInfo?.brackets) ? bracketInfo.brackets : [];
  return rows.find(b => {
    const floor = num(b?.notionalFloor, 0);
    const cap = num(b?.notionalCap, Infinity);
    return notional >= floor && notional < cap;
  }) || null;
}

export function evaluateEntryRisk(input = {}) {
  const limits = REAL_RISK_LIMITS;
  const reasons = [];
  const symbol = String(input.symbol || '').toUpperCase();
  const margin = num(input.margin);
  const leverage = num(input.leverage);
  const maxLoss = num(input.maxLoss);
  const referencePrice = num(input.referencePrice);
  const notional = margin * leverage;
  const symbolInfo = input.symbolInfo || null;
  const symbolConfig = input.symbolConfig || null;
  const bracketInfo = input.bracketInfo || null;
  const positions = Array.isArray(input.positions) ? input.positions : [];
  const standardOrders = Array.isArray(input.standardOrders) ? input.standardOrders : [];
  const algoOrders = Array.isArray(input.algoOrders) ? input.algoOrders : [];
  const availableBalanceUsdt = num(input.availableBalanceUsdt, -1);
  const dualSidePosition = input.dualSidePosition === true;

  if (!/^[A-Z0-9]{3,30}$/.test(symbol) || !(margin > 0) || !(leverage > 0) || !(maxLoss > 0)) {
    reasons.push('REQUEST_INVALID');
  }
  if (leverage > limits.maxLeverage) reasons.push('LEVERAGE_OVER_SERVER_CAP');
  if (margin > limits.maxMarginUsdt) reasons.push('MARGIN_OVER_SERVER_CAP');
  if (notional > limits.maxNotionalUsdt) reasons.push('NOTIONAL_OVER_SERVER_CAP');
  if (maxLoss > limits.maxLossUsd) reasons.push('MAX_LOSS_OVER_SERVER_CAP');
  if (maxLoss > margin) reasons.push('MAX_LOSS_EXCEEDS_MARGIN');

  if (!symbolInfo || symbolInfo.status !== 'TRADING') reasons.push('SYMBOL_NOT_TRADING');
  if (symbolInfo && (symbolInfo.quoteAsset !== 'USDT' || !['PERPETUAL','TRADIFI_PERPETUAL'].includes(String(symbolInfo.contractType || '')))) {
    reasons.push('SYMBOL_NOT_USDT_PERPETUAL');
  }

  if (dualSidePosition) reasons.push('POSITION_MODE_HEDGE_UNSUPPORTED');

  const accountMaxNotionalValue = num(symbolConfig?.maxNotionalValue);
  if (!symbolConfig) {
    reasons.push('ACCOUNT_SYMBOL_CONFIG_MISSING');
  } else {
    if (String(symbolConfig.marginType || '').toUpperCase() !== 'ISOLATED') reasons.push('MARGIN_TYPE_NOT_ISOLATED');
    if (num(symbolConfig.leverage) !== leverage) reasons.push('ACCOUNT_LEVERAGE_MISMATCH');
    if (accountMaxNotionalValue > 0 && notional > accountMaxNotionalValue) reasons.push('ACCOUNT_MAX_NOTIONAL_EXCEEDED');
  }

  const activeCount = activePositionCount(positions);
  const activeSymbols = new Set(
    positions
      .filter(p => Math.abs(num(p?.positionAmt)) > 0)
      .map(p => String(p?.symbol || '').toUpperCase())
      .filter(Boolean)
  );
  const allOrders = [...standardOrders, ...algoOrders];
  const pendingEntryOrders = allOrders.filter(o => !isProtectiveOrder(o));
  const pendingEntrySymbols = new Set(
    pendingEntryOrders
      .map(o => String(o?.symbol || '').toUpperCase())
      .filter(Boolean)
  );
  const occupiedSymbols = new Set([...activeSymbols, ...pendingEntrySymbols]);
  if (occupiedSymbols.size >= limits.maxActivePositions) reasons.push('MAX_ACTIVE_POSITIONS_REACHED');
  if (activeSymbols.has(symbol)) {
    reasons.push('SYMBOL_POSITION_ALREADY_OPEN');
  }
  const sameSymbolOrders = allOrders
    .filter(o => String(o?.symbol || '').toUpperCase() === symbol);
  const blockingEntryOrders = sameSymbolOrders.filter(o => !isProtectiveOrder(o));
  if (blockingEntryOrders.length) reasons.push('SYMBOL_ORDER_ALREADY_OPEN');

  if (!(availableBalanceUsdt >= margin)) reasons.push('AVAILABLE_BALANCE_INSUFFICIENT');
  if (!(referencePrice > 0)) reasons.push('PRICE_UNAVAILABLE');

  const filters = filterMap(symbolInfo);
  const priceFilter = filters.PRICE_FILTER || {};
  const tickSize = num(priceFilter.tickSize);
  const minPrice = num(priceFilter.minPrice);
  const maxPrice = num(priceFilter.maxPrice);
  if (referencePrice > 0) {
    if (minPrice > 0 && referencePrice < minPrice) reasons.push('PRICE_BELOW_EXCHANGE_MIN');
    if (maxPrice > 0 && referencePrice > maxPrice) reasons.push('PRICE_ABOVE_EXCHANGE_MAX');
    if (tickSize > 0 && !alignedToStep(referencePrice, tickSize)) reasons.push('PRICE_NOT_TICK_ALIGNED');
  }

  const lot = filters.LOT_SIZE || {};
  const step = num(lot.stepSize);
  const minQty = num(lot.minQty);
  const maxQty = num(lot.maxQty);
  const quantity = referencePrice > 0 ? floorStep(notional / referencePrice, step) : 0;
  if (!(quantity > 0)) reasons.push('QUANTITY_INVALID');
  if (minQty > 0 && quantity < minQty) reasons.push('QUANTITY_BELOW_MIN');
  if (maxQty > 0 && quantity > maxQty) reasons.push('QUANTITY_ABOVE_MAX');

  const minNotional = Math.max(
    num(filters.MIN_NOTIONAL?.notional, num(filters.MIN_NOTIONAL?.minNotional)),
    num(filters.NOTIONAL?.minNotional)
  );
  const maxNotional = num(filters.NOTIONAL?.maxNotional);
  const effectiveNotional = quantity * referencePrice;
  if (minNotional > 0 && effectiveNotional + 1e-9 < minNotional) reasons.push('NOTIONAL_BELOW_EXCHANGE_MIN');
  if (maxNotional > 0 && effectiveNotional - 1e-9 > maxNotional) reasons.push('NOTIONAL_ABOVE_EXCHANGE_MAX');

  const bracket = bracketForNotional(bracketInfo, effectiveNotional > 0 ? effectiveNotional : notional);
  if (!bracket) {
    reasons.push('LEVERAGE_BRACKET_UNAVAILABLE');
  } else if (leverage > num(bracket.initialLeverage)) {
    reasons.push('LEVERAGE_BRACKET_EXCEEDED');
  }

  return {
    ready: reasons.length === 0,
    reasons,
    limits,
    normalized: {
      symbol,
      margin,
      leverage,
      maxLoss,
      requestedNotional: notional,
      referencePrice,
      quantity,
      effectiveNotional,
      activePositions: activeCount,
      pendingEntrySymbols: pendingEntrySymbols.size,
      occupiedPositionSlots: occupiedSymbols.size,
      positionMode: dualSidePosition ? 'HEDGE' : 'ONE_WAY',
      marginType: String(symbolConfig?.marginType || '').toUpperCase(),
      accountLeverage: num(symbolConfig?.leverage),
      accountMaxNotionalValue,
      availableBalanceUsdt,
      priceTickSize: tickSize,
      minPrice,
      maxPrice,
      quantityStep: step,
      minQuantity: minQty,
      maxQuantity: maxQty,
      exchangeMinNotional: minNotional,
      exchangeMaxNotional: maxNotional,
      protectiveOrdersPresent: sameSymbolOrders.length - blockingEntryOrders.length,
      leverageBracket: bracket ? {
        bracket: num(bracket.bracket),
        initialLeverage: num(bracket.initialLeverage),
        notionalFloor: num(bracket.notionalFloor),
        notionalCap: num(bracket.notionalCap),
      } : null,
    },
  };
}
