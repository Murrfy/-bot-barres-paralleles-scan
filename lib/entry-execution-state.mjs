function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('SYMBOL_INVALID');
  return symbol;
}

function cleanSide(value) {
  const side = String(value || '').trim().toUpperCase();
  if (!['BUY','SELL'].includes(side)) throw new Error('SIDE_INVALID');
  return side;
}

function streamReady(state) {
  return Boolean(
    state &&
    state.connected === true &&
    state.needsReconciliation === false &&
    state.failClosed === false
  );
}

function standardOrders(state) {
  return state?.standardOrders && typeof state.standardOrders === 'object'
    ? Object.values(state.standardOrders)
    : [];
}

function positions(state) {
  return state?.positions && typeof state.positions === 'object'
    ? Object.values(state.positions)
    : [];
}

export function streamEntryOrder(state, symbol, clientOrderId) {
  const sym = cleanSymbol(symbol);
  const cid = String(clientOrderId || '');
  if (!cid || cid.length > 36) throw new Error('CLIENT_ORDER_ID_INVALID');
  return standardOrders(state).find(order =>
    String(order?.symbol || '').toUpperCase() === sym &&
    String(order?.clientOrderId || '') === cid
  ) || null;
}

export function streamEntryPositionQuantity(state, symbol, side) {
  const sym = cleanSymbol(symbol);
  const dir = cleanSide(side) === 'BUY' ? 'LONG' : 'SHORT';
  let quantity = 0;
  for (const position of positions(state)) {
    if (String(position?.symbol || '').toUpperCase() !== sym) continue;
    const positionSide = String(position?.positionSide || 'BOTH').toUpperCase();
    const amount = num(position?.positionAmount);
    const actualDirection = positionSide === 'LONG' || positionSide === 'SHORT'
      ? positionSide
      : amount < 0 ? 'SHORT' : 'LONG';
    if (actualDirection === dir) quantity = Math.max(quantity, Math.abs(amount));
  }
  return quantity;
}

export function evaluateEntryAcceptance({
  state,
  symbol,
  side,
  clientOrderId,
  plannedQuantity,
} = {}) {
  const sym = cleanSymbol(symbol);
  const orderSide = cleanSide(side);
  const cid = String(clientOrderId || '');
  const planned = num(plannedQuantity);
  if (!cid || cid.length > 36) throw new Error('CLIENT_ORDER_ID_INVALID');
  if (!(planned > 0)) throw new Error('PLANNED_QUANTITY_INVALID');

  const ready = streamReady(state);
  const order = streamEntryOrder(state, sym, cid);
  const positionQuantity = streamEntryPositionQuantity(state, sym, orderSide);
  const reasons = [];

  if (!ready) reasons.push('USER_STREAM_NOT_READY');

  if (order) {
    if (String(order.side || '').toUpperCase() !== orderSide) reasons.push('ENTRY_ORDER_SIDE_MISMATCH');
    if (String(order.positionSide || 'BOTH').toUpperCase() !== 'BOTH') reasons.push('ENTRY_ORDER_HEDGE_MODE');
    if (order.reduceOnly === true) reasons.push('ENTRY_ORDER_REDUCE_ONLY');
    const originalQuantity = num(order.originalQuantity);
    if (!(originalQuantity > 0) || Math.abs(originalQuantity - planned) > 1e-12) {
      reasons.push('ENTRY_ORDER_QUANTITY_MISMATCH');
    }
  }

  if (positionQuantity > planned + 1e-12) reasons.push('ENTRY_POSITION_EXCEEDS_PLAN');

  const orderStatus = String(order?.status || '').toUpperCase();
  const terminalRejected = ['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(orderStatus) &&
    positionQuantity <= 1e-12;
  if (terminalRejected) reasons.push('ENTRY_ORDER_TERMINAL_UNFILLED');

  const accepted = Boolean(
    ready &&
    reasons.length === 0 &&
    (order || positionQuantity > 1e-12)
  );

  return {
    accepted,
    streamReady: ready,
    orderSeen: Boolean(order),
    orderStatus,
    positionQuantity,
    partialFill: Boolean(order && positionQuantity > 1e-12 && positionQuantity + 1e-12 < planned),
    fullyFilled: positionQuantity + 1e-12 >= planned,
    reasons,
  };
}
