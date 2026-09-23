const TERMINAL_STANDARD = new Set(['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED']);
const RETRYABLE_TERMINAL = new Set(['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED']);

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function directionOfPosition(position) {
  const side = String(position?.positionSide || 'BOTH').toUpperCase();
  if (side === 'LONG' || side === 'SHORT') return side;
  return n(position?.positionAmount ?? position?.positionAmt) < 0 ? 'SHORT' : 'LONG';
}

export function streamPositionQuantity(state, symbol, direction) {
  const sym = String(symbol || '').toUpperCase();
  const dir = String(direction || '').toUpperCase();
  for (const position of Object.values(state?.positions || {})) {
    if (String(position?.symbol || '').toUpperCase() !== sym) continue;
    if (directionOfPosition(position) !== dir) continue;
    return Math.abs(n(position?.positionAmount ?? position?.positionAmt));
  }
  return 0;
}

export function streamOrderByClientId(state, clientOrderId) {
  const wanted = String(clientOrderId || '');
  if (!wanted) return null;
  for (const order of Object.values(state?.standardOrders || {})) {
    if (String(order?.clientOrderId || '') === wanted) return order;
  }
  return null;
}

export function evaluateFullProtectiveClose({
  state,
  symbol,
  direction,
  beforeQuantity,
  clientOrderId,
  epsilon = 1e-12,
}) {
  const before = Math.max(0, n(beforeQuantity));
  if (!(before > 0)) throw new Error('CLOSE_QUANTITY_INVALID');
  const afterQuantity = streamPositionQuantity(state, symbol, direction);
  const order = streamOrderByClientId(state, clientOrderId);
  const status = String(order?.status || '').toUpperCase();
  const terminalSeen = TERMINAL_STANDARD.has(status);
  const progressed = afterQuantity < before - epsilon;
  const confirmed = afterQuantity <= epsilon;
  const streamReady = Boolean(
    state &&
    state.connected === true &&
    state.needsReconciliation === false &&
    state.failClosed === false
  );
  const inconsistentFilled = status === 'FILLED' && !confirmed;
  const safeToRetry = Boolean(
    !confirmed &&
    streamReady &&
    terminalSeen &&
    !inconsistentFilled &&
    (progressed || RETRYABLE_TERMINAL.has(status))
  );
  return {
    confirmed,
    progressed,
    safeToRetry,
    terminalSeen,
    inconsistentFilled,
    streamReady,
    beforeQuantity: before,
    afterQuantity,
    clientOrderId: String(clientOrderId || ''),
    orderStatus: status,
  };
}

export const PROTECTIVE_CLOSE_ATTEMPTS = Object.freeze([
  Object.freeze({ attempt:0, exitMode:'PROTECTIVE_IOC', priceMatch:'OPPONENT' }),
  Object.freeze({ attempt:1, exitMode:'PROTECTIVE_IOC', priceMatch:'OPPONENT_5' }),
  Object.freeze({ attempt:2, exitMode:'PROTECTIVE_IOC', priceMatch:'OPPONENT_10' }),
  Object.freeze({ attempt:3, exitMode:'MARKET_LAST_RESORT', priceMatch:'' }),
]);
