function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function values(object) {
  return object && typeof object === 'object' ? Object.values(object) : [];
}

function streamReady(state) {
  return Boolean(
    state &&
    state.connected === true &&
    state.needsReconciliation === false &&
    state.failClosed === false
  );
}

function sameNumber(a, b) {
  const aa = n(a, NaN), bb = n(b, NaN);
  if (!Number.isFinite(aa) || !Number.isFinite(bb)) return false;
  return Math.abs(aa - bb) <= Math.max(1e-9, Math.abs(bb) * 1e-10);
}

function positionFor(state, symbol) {
  return values(state?.positions).find(p =>
    String(p?.symbol || '').toUpperCase() === symbol &&
    String(p?.positionSide || 'BOTH').toUpperCase() === 'BOTH'
  ) || null;
}

export function evaluateEntryOpenConfirmation({
  state,
  symbol,
  side,
  quantity,
  limitPrice,
  clientOrderId,
  protectionReady = false,
} = {}) {
  const sym = String(symbol || '').toUpperCase();
  const entrySide = String(side || '').toUpperCase();
  const cid = String(clientOrderId || '');
  const expectedQty = n(quantity, NaN);
  const expectedPrice = n(limitPrice, NaN);
  const ready = streamReady(state);

  if (!/^[A-Z0-9]{3,30}$/.test(sym) ||
      !['BUY','SELL'].includes(entrySide) ||
      !(expectedQty > 0) ||
      !(expectedPrice > 0) ||
      !cid) {
    return { confirmed:false, safeToAck:false, streamReady:ready, reason:'ENTRY_CONFIRMATION_INPUT_INVALID' };
  }

  const order = values(state?.standardOrders).find(o =>
    String(o?.symbol || '').toUpperCase() === sym &&
    String(o?.clientOrderId || '') === cid
  ) || null;

  if (!order) {
    return { confirmed:false, safeToAck:false, streamReady:ready, reason:'ENTRY_ORDER_NOT_SEEN' };
  }

  if (order.reduceOnly === true ||
      String(order?.positionSide || 'BOTH').toUpperCase() !== 'BOTH' ||
      String(order?.side || '').toUpperCase() !== entrySide ||
      String(order?.type || '').toUpperCase() !== 'LIMIT' ||
      String(order?.timeInForce || '').toUpperCase() !== 'GTC' ||
      !sameNumber(order?.originalQuantity, expectedQty) ||
      !sameNumber(order?.originalPrice, expectedPrice)) {
    return {
      confirmed:false,
      safeToAck:false,
      streamReady:ready,
      reason:'ENTRY_ORDER_IDENTITY_MISMATCH',
      order,
    };
  }

  const status = String(order?.status || '').toUpperCase();
  const executedQty = Math.max(0, n(order?.cumulativeFilledQuantity));
  const position = positionFor(state, sym);
  const signedPosition = n(position?.positionAmount);
  const positionDirectionOk = entrySide === 'BUY' ? signedPosition > 0 : signedPosition < 0;
  const positionQty = Math.abs(signedPosition);

  const terminalFailure = ['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status);
  if (terminalFailure && executedQty <= 0) {
    return {
      confirmed:false,
      safeToAck:false,
      streamReady:ready,
      terminal:true,
      reason:'ENTRY_ORDER_TERMINAL_UNFILLED',
      status,
      executedQty,
      order,
    };
  }

  if (executedQty > 0 && (!positionDirectionOk || positionQty + 1e-12 < executedQty)) {
    return {
      confirmed:false,
      safeToAck:false,
      streamReady:ready,
      reason:'ENTRY_FILL_POSITION_MISMATCH',
      status,
      executedQty,
      positionQty,
      order,
      position,
    };
  }

  const accepted = ['NEW','PARTIALLY_FILLED','FILLED'].includes(status) ||
    (terminalFailure && executedQty > 0);
  if (!accepted) {
    return {
      confirmed:false,
      safeToAck:false,
      streamReady:ready,
      reason:'ENTRY_ORDER_STATUS_UNSUPPORTED',
      status,
      executedQty,
      order,
    };
  }

  if (!protectionReady) {
    return {
      confirmed:true,
      safeToAck:false,
      streamReady:ready,
      requiresProtection:true,
      reason:'ENTRY_PROTECTION_CONFIRMATION_REQUIRED',
      status,
      executedQty,
      positionQty,
      order,
      position,
    };
  }

  return {
    confirmed:true,
    safeToAck:ready,
    streamReady:ready,
    requiresProtection:false,
    reason:ready ? 'ENTRY_CONFIRMED' : 'USER_STREAM_NOT_READY',
    status,
    executedQty,
    positionQty,
    order,
    position,
  };
}
