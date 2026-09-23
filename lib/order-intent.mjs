import crypto from 'node:crypto';

export const BINANCE_ORDER_ENDPOINT = '/fapi/v1/order';
export const CLIENT_ORDER_ID_MAX_LENGTH = 36;
export const ENTRY_PREFLIGHT_MAX_AGE_MS = 5000;

function num(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function positive(value, code) {
  const x = num(value);
  if (!(x > 0)) throw new Error(code);
  return x;
}

function symbolText(value) {
  const symbol = String(value || '').toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('SYMBOL_INVALID');
  return symbol;
}

function commandText(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(id)) throw new Error('COMMAND_ID_INVALID');
  return id;
}

export function deterministicClientOrderId({ commandId, symbol, leg, attempt = 0 }) {
  const id = commandText(commandId);
  const sym = symbolText(symbol);
  const normalizedLeg = String(leg || '').toUpperCase();
  if (!/^[A-Z0-9_]{2,32}$/.test(normalizedLeg)) throw new Error('ORDER_LEG_INVALID');
  const n = Math.max(0, Math.floor(num(attempt)));
  const digest = crypto
    .createHash('sha256')
    .update(`zenith:v1|${id}|${sym}|${normalizedLeg}|${n}`)
    .digest('hex')
    .slice(0, 24);
  const prefix = normalizedLeg.replace(/[^A-Z0-9]/g, '').slice(0, 3).padEnd(3, 'X');
  const value = `zth-${prefix}-${digest}`;
  if (value.length > CLIENT_ORDER_ID_MAX_LENGTH) throw new Error('CLIENT_ORDER_ID_TOO_LONG');
  return value;
}

function verifiedRiskSnapshot(riskSnapshot, symbol, now = Date.now()) {
  if (!riskSnapshot || riskSnapshot.ready !== true) throw new Error('ENTRY_PREFLIGHT_NOT_READY');
  const observedAt = num(riskSnapshot.observedAt);
  const ageMs = now - observedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ENTRY_PREFLIGHT_MAX_AGE_MS) {
    throw new Error('ENTRY_PREFLIGHT_STALE');
  }
  const normalized = riskSnapshot.normalized || {};
  if (symbolText(normalized.symbol) !== symbol) throw new Error('ENTRY_PREFLIGHT_SYMBOL_MISMATCH');
  if (String(normalized.positionMode || '') !== 'ONE_WAY') throw new Error('POSITION_MODE_NOT_ONE_WAY');
  if (String(normalized.marginType || '') !== 'ISOLATED') throw new Error('MARGIN_TYPE_NOT_ISOLATED');
  const leverage = positive(normalized.leverage, 'LEVERAGE_INVALID');
  if (leverage > 10) throw new Error('LEVERAGE_OVER_SERVER_CAP');
  const quantity = positive(normalized.quantity, 'QUANTITY_INVALID');
  return { normalized, quantity, leverage, observedAt, ageMs };
}

export function buildEntryOrderPlan({ command, riskSnapshot, now = Date.now() }) {
  const commandId = commandText(command?.id);
  const symbol = symbolText(command?.symbol);
  const side = String(command?.side || '').toUpperCase();
  if (!['BUY','SELL'].includes(side)) throw new Error('SIDE_INVALID');

  const type = String(command?.orderType || '').toUpperCase();
  if (!['LIMIT','MARKET'].includes(type)) throw new Error('ENTRY_ORDER_TYPE_INVALID');

  const risk = verifiedRiskSnapshot(riskSnapshot, symbol, now);
  const params = {
    symbol,
    side,
    positionSide: 'BOTH',
    type,
    quantity: String(risk.quantity),
    reduceOnly: 'false',
    newClientOrderId: deterministicClientOrderId({ commandId, symbol, leg: 'ENTRY' }),
  };

  if (type === 'LIMIT') {
    params.timeInForce = 'GTC';
    params.price = String(positive(command?.limitPrice, 'LIMIT_PRICE_INVALID'));
  }

  return {
    version: 1,
    writeAllowed: false,
    endpoint: BINANCE_ORDER_ENDPOINT,
    method: 'POST',
    commandId,
    preflightObservedAt: risk.observedAt,
    params,
  };
}

export function buildExitOrderPlan({
  commandId,
  symbol,
  direction,
  quantity,
  exitMode,
  targetPrice = 0,
  attempt = 0,
  priceMatch = 'OPPONENT',
}) {
  const id = commandText(commandId);
  const sym = symbolText(symbol);
  const dir = String(direction || '').toUpperCase();
  if (!['LONG','SHORT'].includes(dir)) throw new Error('POSITION_DIRECTION_INVALID');
  const qty = positive(quantity, 'QUANTITY_INVALID');
  const mode = String(exitMode || '').toUpperCase();
  const side = dir === 'LONG' ? 'SELL' : 'BUY';

  const params = {
    symbol: sym,
    side,
    positionSide: 'BOTH',
    quantity: String(qty),
    reduceOnly: 'true',
  };

  if (mode === 'NORMAL_LIMIT') {
    params.type = 'LIMIT';
    params.timeInForce = 'GTC';
    params.price = String(positive(targetPrice, 'LIMIT_PRICE_INVALID'));
    params.newClientOrderId = deterministicClientOrderId({ commandId:id, symbol:sym, leg:'EXIT_LIMIT', attempt });
  } else if (mode === 'PROTECTIVE_IOC') {
    const match = String(priceMatch || 'OPPONENT').toUpperCase();
    if (!['OPPONENT','OPPONENT_5','OPPONENT_10','OPPONENT_20'].includes(match)) {
      throw new Error('PRICE_MATCH_INVALID');
    }
    params.type = 'LIMIT';
    params.timeInForce = 'IOC';
    params.priceMatch = match;
    params.newClientOrderId = deterministicClientOrderId({ commandId:id, symbol:sym, leg:'EXIT_PROTECT', attempt });
  } else if (mode === 'MARKET_LAST_RESORT') {
    params.type = 'MARKET';
    params.newClientOrderId = deterministicClientOrderId({ commandId:id, symbol:sym, leg:'EXIT_MARKET', attempt });
  } else {
    throw new Error('EXIT_MODE_INVALID');
  }

  if (params.price && params.priceMatch) throw new Error('PRICE_AND_PRICE_MATCH_MUTUALLY_EXCLUSIVE');

  return {
    version: 1,
    writeAllowed: false,
    endpoint: BINANCE_ORDER_ENDPOINT,
    method: 'POST',
    commandId: id,
    params,
  };
}
