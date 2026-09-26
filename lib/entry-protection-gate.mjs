import { REAL_RISK_LIMITS } from './risk-policy.mjs';
import { isLimitIocMaxLossOrder } from './maxloss-order-shape.mjs';
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
    if (!isLimitIocMaxLossOrder(order,{
      symbol:sym,side:protectiveSide,positionSide:'BOTH',quantity:qty,
    })) continue;

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
        priceMatch: 'OPPONENT',
        quantity: qty,
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
