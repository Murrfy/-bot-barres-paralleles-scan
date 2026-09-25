function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('SYMBOL_INVALID');
  return symbol;
}

function safeIdPart(value, max = 28) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .slice(0, max);
}

function compactNumber(value) {
  const n = num(value);
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toPrecision(12)));
}

export function buildControllerMarketEntryCommand(symbol, risk = {}, requestedAt = Date.now()) {
  const clean = cleanSymbol(symbol);
  const margin = num(risk?.margin);
  const leverage = num(risk?.leverage);
  const maxLoss = num(risk?.maxLoss);
  const stamp = Math.max(1, Math.floor(num(requestedAt)));
  if (!(margin > 0)) throw new Error('MARGIN_INVALID');
  if (!(leverage > 0)) throw new Error('LEVERAGE_INVALID');
  if (!(maxLoss > 0)) throw new Error('MAX_LOSS_INVALID');
  const clientCommandId = `realmarket:${clean}:${stamp}`.slice(0,128);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientCommandId)) throw new Error('CLIENT_COMMAND_ID_INVALID');
  return {
    type:'EXEC_OPEN_MARKET_POSITION',
    clientCommandId,
    payload:{
      symbol:clean,
      side:'BUY',
      orderType:'MARKET',
      margin,
      leverage,
      maxLoss,
      requestedAt:stamp,
    },
  };
}

export function realPositionKey(position) {
  const symbol = cleanSymbol(position?.symbol);
  const side = String(position?.positionSide || 'BOTH').toUpperCase();
  const amt = compactNumber(position?.positionAmt);
  return `${symbol}:${safeIdPart(side,8)}:${safeIdPart(amt,24)}`;
}

export function buildControllerRealCloseCommand(position) {
  const symbol = cleanSymbol(position?.symbol);
  const positionSide = String(position?.positionSide || 'BOTH').toUpperCase();
  if (positionSide !== 'BOTH') throw new Error('HEDGE_MODE_UNSUPPORTED');

  const amount = num(position?.positionAmt);
  if (!Number.isFinite(amount) || amount === 0) throw new Error('POSITION_AMOUNT_INVALID');

  const direction = amount > 0 ? 'LONG' : 'SHORT';
  const quantity = Math.abs(amount);
  const entry = compactNumber(position?.entryPrice);
  const stamp = Math.max(0, Math.floor(num(position?.updateTime) || 0));
  const amountPart = safeIdPart(compactNumber(quantity),24);
  const entryPart = safeIdPart(entry || '0',24);
  const rawId = `realclose:${symbol}:${direction}:${amountPart}:${entryPart}:${stamp}`;
  const clientCommandId = rawId.slice(0,128);

  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientCommandId)) throw new Error('CLIENT_COMMAND_ID_INVALID');

  return {
    type: 'EXEC_CLOSE_POSITION',
    clientCommandId,
    payload: {
      symbol,
      direction,
      quantity,
      closeAll: true,
      exitMode: 'PROTECTIVE_IOC',
      attempt: 0,
    },
  };
}


export function realEntryOrderKey(order) {
  const symbol = cleanSymbol(order?.symbol);
  const clientOrderId = String(order?.clientOrderId || '');
  if (!clientOrderId || clientOrderId.length > 36) throw new Error('CLIENT_ORDER_ID_INVALID');
  return `${symbol}:entry:${safeIdPart(clientOrderId,36)}`;
}

export function buildControllerCancelEntryCommand(order) {
  const symbol = cleanSymbol(order?.symbol);
  const clientOrderId = String(order?.clientOrderId || '');
  if (!clientOrderId || clientOrderId.length > 36) throw new Error('CLIENT_ORDER_ID_INVALID');
  if (order?.reduceOnly === true || order?.reduceOnly === 'true') throw new Error('CANCEL_TARGET_IS_REDUCE_ONLY');
  if (String(order?.positionSide || 'BOTH').toUpperCase() !== 'BOTH') throw new Error('HEDGE_MODE_UNSUPPORTED');

  const stamp = Math.max(0, Math.floor(num(order?.updateTime) || 0));
  const rawId = `realcancel:${symbol}:${safeIdPart(clientOrderId,36)}:${stamp}`;
  const clientCommandId = rawId.slice(0,128);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientCommandId)) throw new Error('CLIENT_COMMAND_ID_INVALID');

  return {
    type:'EXEC_CANCEL_ENTRY',
    clientCommandId,
    payload:{ symbol, clientOrderId },
  };
}


function managedZenithId(value, code) {
  const id = String(value || '');
  if (!id) return '';
  if (id.length > 36 || !/^zth-[A-Za-z0-9._:-]+$/.test(id)) throw new Error(code);
  return id;
}

function livePosition(position) {
  const symbol = cleanSymbol(position?.symbol);
  const positionSide = String(position?.positionSide || 'BOTH').toUpperCase();
  if (positionSide !== 'BOTH') throw new Error('HEDGE_MODE_UNSUPPORTED');
  const amount = num(position?.positionAmt);
  if (!Number.isFinite(amount) || amount === 0) throw new Error('POSITION_AMOUNT_INVALID');
  return {
    symbol,
    direction: amount > 0 ? 'LONG' : 'SHORT',
    quantity: Math.abs(amount),
    entryPrice: num(position?.entryPrice),
    updateTime: Math.max(0, Math.floor(num(position?.updateTime) || 0)),
  };
}

function updateCommandId(kind, live, priceValue, previousId = '') {
  const pricePart = safeIdPart(compactNumber(priceValue), 28);
  const qtyPart = safeIdPart(compactNumber(live.quantity), 24);
  const previousPart = safeIdPart(previousId || 'none', 20);
  const raw = `real${kind}:${live.symbol}:${live.direction}:${qtyPart}:${pricePart}:${previousPart}:${live.updateTime}`;
  const id = raw.slice(0, 128);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(id)) throw new Error('CLIENT_COMMAND_ID_INVALID');
  return id;
}

export function buildControllerUpdateExitCommand(position, targetPrice, previousClientOrderId = '', activeConfig = null, configDigest = '') {
  const live = livePosition(position);
  const target = num(targetPrice);
  if (!(target > 0)) throw new Error('TARGET_PRICE_INVALID');
  if (live.direction === 'LONG' && !(target > live.entryPrice)) throw new Error('LONG_TARGET_MUST_BE_ABOVE_ENTRY');
  if (live.direction === 'SHORT' && !(target < live.entryPrice)) throw new Error('SHORT_TARGET_MUST_BE_BELOW_ENTRY');
  const previous = managedZenithId(previousClientOrderId, 'PREVIOUS_EXIT_ID_INVALID');
  const baseCommandId = updateCommandId('exit', live, target, previous);
  const digest = safeIdPart(configDigest, 20);
  return {
    type: 'EXEC_UPDATE_EXIT',
    clientCommandId: digest ? (baseCommandId + ':' + digest).slice(0,128) : baseCommandId,
    payload: {
      symbol: live.symbol,
      direction: live.direction,
      quantity: live.quantity,
      targetPrice: target,
      ...(previous ? { previousClientOrderId: previous } : {}),
      ...(activeConfig && typeof activeConfig === 'object' ? { activeConfig } : {}),
    },
  };
}

export function buildControllerActiveConfigCommand(position, activeConfig, configDigest = '') {
  const live = livePosition(position);
  if (!activeConfig || typeof activeConfig !== 'object' || Array.isArray(activeConfig)) {
    throw new Error('ACTIVE_CONFIG_REQUIRED');
  }
  const digest = safeIdPart(configDigest, 28);
  if (!digest) throw new Error('ACTIVE_CONFIG_DIGEST_REQUIRED');
  const qtyPart = safeIdPart(compactNumber(live.quantity),24);
  const rawId = `realconfig:${live.symbol}:${live.direction}:${qtyPart}:${digest}:${live.updateTime}`;
  const clientCommandId = rawId.slice(0,128);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientCommandId)) throw new Error('CLIENT_COMMAND_ID_INVALID');
  return {
    type:'EXEC_UPDATE_ACTIVE_CONFIG',
    clientCommandId,
    payload:{
      symbol:live.symbol,
      direction:live.direction,
      quantity:live.quantity,
      activeConfig,
    },
  };
}

export function buildControllerUpdateProtectionCommand(
  position,
  triggerPrice,
  protectionKind = 'PROGRESSIVE',
  previousClientAlgoId = '',
  maxLossUsd = NaN
) {
  const live = livePosition(position);
  const trigger = num(triggerPrice);
  if (!(trigger > 0)) throw new Error('TRIGGER_PRICE_INVALID');
  const kind = String(protectionKind || '').toUpperCase();
  if (!['PROGRESSIVE', 'MAX_LOSS'].includes(kind)) throw new Error('PROTECTION_KIND_INVALID');

  if (kind === 'PROGRESSIVE') {
    if (live.direction === 'LONG' && trigger < live.entryPrice) throw new Error('LONG_PROGRESSIVE_TRIGGER_BELOW_ENTRY');
    if (live.direction === 'SHORT' && trigger > live.entryPrice) throw new Error('SHORT_PROGRESSIVE_TRIGGER_ABOVE_ENTRY');
  } else {
    if (live.direction === 'LONG' && !(trigger < live.entryPrice)) throw new Error('LONG_MAX_LOSS_TRIGGER_NOT_BELOW_ENTRY');
    if (live.direction === 'SHORT' && !(trigger > live.entryPrice)) throw new Error('SHORT_MAX_LOSS_TRIGGER_NOT_ABOVE_ENTRY');
  }

  const previous = managedZenithId(previousClientAlgoId, 'PREVIOUS_PROTECTION_ID_INVALID');
  const requestedMaxLoss = num(maxLossUsd);
  if (kind === 'MAX_LOSS' && Number.isFinite(requestedMaxLoss) &&
      !(requestedMaxLoss >= 2 && requestedMaxLoss <= 400)) {
    throw new Error('MAX_LOSS_USD_INVALID');
  }
  const baseCommandId = updateCommandId(kind === 'MAX_LOSS' ? 'maxloss' : 'protect', live, trigger, previous);
  const clientCommandId = kind === 'MAX_LOSS' && Number.isFinite(requestedMaxLoss)
    ? (baseCommandId + ':' + safeIdPart(compactNumber(requestedMaxLoss), 16)).slice(0, 128)
    : baseCommandId;
  return {
    type: 'EXEC_UPDATE_PROTECTION',
    clientCommandId,
    payload: {
      symbol: live.symbol,
      direction: live.direction,
      quantity: live.quantity,
      triggerPrice: trigger,
      ...(kind === 'PROGRESSIVE' ? { limitPrice: trigger } : {}),
      protectionKind: kind,
      ...(kind === 'MAX_LOSS' && Number.isFinite(requestedMaxLoss) ? { maxLossUsd: requestedMaxLoss } : {}),
      ...(previous ? { previousClientAlgoId: previous } : {}),
    },
  };
}
