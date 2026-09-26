import { REAL_RISK_LIMITS } from './risk-policy.mjs';
function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function bool(value) {
  return value === true || value === 'true';
}

function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('SYMBOL_INVALID');
  return symbol;
}

export function findCoveringEntryProtection(runtimeState, {
  symbol,
  side,
  quantity,
  limitPrice,
} = {}) {
  const sym = cleanSymbol(symbol);
  const entrySide = String(side || '').toUpperCase();
  if (!['BUY','SELL'].includes(entrySide)) throw new Error('SIDE_INVALID');
  const qty = n(quantity, NaN);
  const price = n(limitPrice, NaN);
  if (!(qty > 0)) throw new Error('QUANTITY_INVALID');
  if (!(price > 0)) throw new Error('LIMIT_PRICE_INVALID');

  const orders = Array.isArray(runtimeState?.data?.binanceOrders)
    ? runtimeState.data.binanceOrders
    : [];
  const protectiveSide = entrySide === 'BUY' ? 'SELL' : 'BUY';

  for (const order of orders) {
    if (String(order?.symbol || '').toUpperCase() !== sym) continue;
    if (String(order?.side || '').toUpperCase() !== protectiveSide) continue;
    if (String(order?.positionSide || 'BOTH').toUpperCase() !== 'BOTH') continue;
    if (String(order?.type || '').toUpperCase() !== 'STOP') continue;
    if (String(order?.timeInForce || '').toUpperCase() !== 'IOC') continue;
    if (!bool(order?.reduceOnly)) continue;
    if (bool(order?.closePosition)) continue;
    if (Math.abs(n(order?.origQty ?? order?.quantity, NaN) - qty) > 1e-12) continue;
    if (String(order?.priceMatch || '').toUpperCase() !== 'OPPONENT') continue;
    if (!/^zth-MAX-[A-Za-z0-9._:-]+$/.test(String(order?.clientAlgoId || ''))) continue;

    const trigger = n(order?.triggerPrice ?? order?.stopPrice, NaN);
    if (!(trigger > 0)) continue;
    if (entrySide === 'BUY' && !(trigger < price)) continue;
    if (entrySide === 'SELL' && !(trigger > price)) continue;
    const impliedLossUsd = entrySide === 'BUY'
      ? (price - trigger) * qty
      : (trigger - price) * qty;
    if (!(impliedLossUsd >= 0) || impliedLossUsd > REAL_RISK_LIMITS.maxLossUsd + 1e-8) continue;

    return {
      ready: true,
      order: {
        orderClass: String(order?.orderClass || ''),
        symbol: sym,
        side: protectiveSide,
        positionSide: 'BOTH',
        type: 'STOP',
        timeInForce: 'IOC',
        closePosition: false,
        reduceOnly: true,
        quantity: qty,
        priceMatch: 'OPPONENT',
        triggerPrice: trigger,
        clientOrderId: String(order?.clientOrderId || ''),
        clientAlgoId: String(order?.clientAlgoId || ''),
        orderId: String(order?.orderId || ''),
        algoId: String(order?.algoId || ''),
      },
    };
  }

  return { ready: false, reason: 'ENTRY_PROTECTION_NOT_ARMED', order: null };
}
