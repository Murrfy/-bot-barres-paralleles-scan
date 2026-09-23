const CLOSE_MODES = new Set(['PROTECTIVE_IOC','MARKET_LAST_RESORT']);

function number(value) {
  const x = Number(value);
  return Number.isFinite(x) ? x : NaN;
}

function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('SYMBOL_INVALID');
  return symbol;
}

export function masterExecutionEligible(state = {}) {
  const mode = String(state.mode || '').toUpperCase();
  return Boolean(
    state.role === 'master' &&
    state.hidden !== true &&
    state.leaseActive === true &&
    state.realExecutionArmed === true &&
    state.userStreamReady === true &&
    (mode === 'RUNNING' || mode === 'PAUSE_PENDING')
  );
}

export function buildMasterCommandDispatch(command) {
  if (!command || typeof command !== 'object') throw new Error('COMMAND_INVALID');
  const type = String(command.type || '').toUpperCase();
  if (!['EXEC_UPDATE_EXIT','EXEC_UPDATE_PROTECTION','EXEC_CLOSE_POSITION','EXEC_CANCEL_ENTRY'].includes(type)) {
    return { supported:false, reason:'MASTER_COMMAND_NOT_IMPLEMENTED', type };
  }

  const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
  const symbol = cleanSymbol(payload.symbol);

  if (type === 'EXEC_UPDATE_EXIT') {
    const direction = String(payload.direction || '').toUpperCase();
    if (!['LONG','SHORT'].includes(direction)) throw new Error('DIRECTION_INVALID');
    const quantity = number(payload.quantity);
    const targetPrice = number(payload.targetPrice);
    const clientOrderId = String(payload.clientOrderId || '');
    if (!(quantity > 0)) throw new Error('QUANTITY_INVALID');
    if (!(targetPrice > 0)) throw new Error('TARGET_PRICE_INVALID');
    if (clientOrderId && clientOrderId.length > 36) throw new Error('CLIENT_ORDER_ID_INVALID');
    return {
      supported:true,
      type,
      endpoint:'/api/binance-protective-mutate',
      body:{
        type,
        commandId:String(command.id || ''),
        symbol,
        direction,
        quantity,
        targetPrice,
        clientOrderId,
      },
    };
  }

  if (type === 'EXEC_UPDATE_PROTECTION') {
    const direction = String(payload.direction || '').toUpperCase();
    if (!['LONG','SHORT'].includes(direction)) throw new Error('DIRECTION_INVALID');
    const quantity = number(payload.quantity);
    const triggerPrice = number(payload.triggerPrice);
    const previousClientAlgoId = String(payload.previousClientAlgoId || '');
    if (!(quantity > 0)) throw new Error('QUANTITY_INVALID');
    if (!(triggerPrice > 0)) throw new Error('TRIGGER_PRICE_INVALID');
    if (previousClientAlgoId && previousClientAlgoId.length > 36) throw new Error('CLIENT_ALGO_ID_INVALID');
    return {
      supported:true,
      type,
      endpoint:'/api/binance-protective-mutate',
      body:{
        type,
        commandId:String(command.id || ''),
        symbol,
        direction,
        quantity,
        triggerPrice,
        previousClientAlgoId,
      },
    };
  }

  if (type === 'EXEC_CANCEL_ENTRY') {
    const clientOrderId = String(payload.clientOrderId || '');
    if (!clientOrderId || clientOrderId.length > 36) throw new Error('CLIENT_ORDER_ID_INVALID');
    return {
      supported:true,
      type,
      endpoint:'/api/binance-protective-execute',
      body:{
        type,
        commandId:String(command.id || ''),
        symbol,
        clientOrderId,
      },
    };
  }

  const direction = String(payload.direction || '').toUpperCase();
  if (!['LONG','SHORT'].includes(direction)) throw new Error('DIRECTION_INVALID');

  const quantity = number(payload.quantity);
  if (!(quantity > 0)) throw new Error('QUANTITY_INVALID');
  if (payload.closeAll !== true) throw new Error('CLOSE_ALL_REQUIRED');

  const exitMode = String(payload.exitMode || 'PROTECTIVE_IOC').toUpperCase();
  if (!CLOSE_MODES.has(exitMode)) throw new Error('EXIT_MODE_INVALID');

  const attemptRaw = Number(payload.attempt || 0);
  const attempt = Math.max(0, Math.min(20, Number.isInteger(attemptRaw) ? attemptRaw : 0));

  return {
    supported:true,
    type,
    endpoint:'/api/binance-protective-execute',
    body:{
      type,
      commandId:String(command.id || ''),
      symbol,
      direction,
      quantity,
      closeAll:true,
      exitMode,
      attempt,
    },
  };
}
