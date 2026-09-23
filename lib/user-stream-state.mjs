function num(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function orderKey(order) {
  const client = String(order?.c ?? order?.clientOrderId ?? '');
  const id = String(order?.i ?? order?.orderId ?? '');
  const symbol = String(order?.s ?? order?.symbol ?? '').toUpperCase();
  return client ? `${symbol}:client:${client}` : id ? `${symbol}:id:${id}` : '';
}

function algoKey(order) {
  const symbol = String(order?.s ?? order?.symbol ?? '').toUpperCase();
  const algoId = String(order?.ai ?? order?.algoId ?? order?.i ?? '');
  const clientAlgoId = String(order?.ca ?? order?.clientAlgoId ?? order?.c ?? '');
  return algoId ? `${symbol}:algo:${algoId}` :
    clientAlgoId ? `${symbol}:algo-client:${clientAlgoId}` : '';
}

function positionKey(position) {
  const symbol = String(position?.s ?? position?.symbol ?? '').toUpperCase();
  const side = String(position?.ps ?? position?.positionSide ?? 'BOTH').toUpperCase();
  return symbol ? `${symbol}:${side || 'BOTH'}` : '';
}

function terminalOrderStatus(status) {
  return ['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(String(status || '').toUpperCase());
}

export function createUserStreamState() {
  return {
    version: 1,
    connected: false,
    connectionId: '',
    connectedAt: 0,
    disconnectedAt: 0,
    lastEventAt: 0,
    lastEventTimeByType: {},
    needsReconciliation: true,
    reconciledAt: 0,
    reconciliationRuntimeHash: '',
    failClosed: true,
    failReasons: ['STREAM_NOT_CONNECTED'],
    standardOrders: {},
    algoOrders: {},
    positions: {},
    balances: {},
  };
}

function withReason(state, reason) {
  const reasons = new Set(Array.isArray(state.failReasons) ? state.failReasons : []);
  reasons.add(reason);
  state.failReasons = [...reasons];
  state.failClosed = true;
}

function clearReason(state, reason) {
  state.failReasons = (Array.isArray(state.failReasons) ? state.failReasons : []).filter(x => x !== reason);
  state.failClosed = state.failReasons.length > 0 || state.needsReconciliation === true || state.connected !== true;
}

export function markUserStreamConnected(inputState, { connectionId, at = Date.now() } = {}) {
  const state = clone(inputState || createUserStreamState());
  state.connected = true;
  state.connectionId = String(connectionId || '');
  state.connectedAt = num(at);
  state.disconnectedAt = 0;
  state.needsReconciliation = true;
  withReason(state, 'RECONCILIATION_REQUIRED_AFTER_CONNECT');
  clearReason(state, 'STREAM_NOT_CONNECTED');
  clearReason(state, 'STREAM_DISCONNECTED');
  return state;
}

export function markUserStreamDisconnected(inputState, { at = Date.now(), reason = 'STREAM_DISCONNECTED' } = {}) {
  const state = clone(inputState || createUserStreamState());
  state.connected = false;
  state.disconnectedAt = num(at);
  state.needsReconciliation = true;
  withReason(state, String(reason || 'STREAM_DISCONNECTED'));
  return state;
}

export function markUserStreamReconciled(inputState, { observedAt, runtimeHash } = {}) {
  const state = clone(inputState || createUserStreamState());
  const at = num(observedAt);
  if (state.connected !== true) throw new Error('STREAM_NOT_CONNECTED');
  if (!(at >= num(state.connectedAt))) throw new Error('RECONCILIATION_PREDATES_CONNECTION');
  if (!runtimeHash) throw new Error('RECONCILIATION_RUNTIME_HASH_REQUIRED');
  state.needsReconciliation = false;
  state.reconciledAt = at;
  state.reconciliationRuntimeHash = String(runtimeHash);
  clearReason(state, 'RECONCILIATION_REQUIRED_AFTER_CONNECT');
  clearReason(state, 'LISTEN_KEY_EXPIRED');
  state.failClosed = state.failReasons.length > 0 || state.connected !== true;
  return state;
}

export function applyUserDataEvent(inputState, event) {
  const state = clone(inputState || createUserStreamState());
  if (!event || typeof event !== 'object') {
    withReason(state, 'STREAM_EVENT_INVALID');
    return { state, applied: false, reason: 'STREAM_EVENT_INVALID' };
  }

  const type = String(event.e || '');
  const eventTime = num(event.E);
  if (!type || !(eventTime > 0)) {
    withReason(state, 'STREAM_EVENT_INVALID');
    return { state, applied: false, reason: 'STREAM_EVENT_INVALID' };
  }

  const lastForType = num(state.lastEventTimeByType?.[type]);
  if (lastForType > 0 && eventTime < lastForType) {
    withReason(state, 'STREAM_EVENT_OUT_OF_ORDER');
    return { state, applied: false, reason: 'STREAM_EVENT_OUT_OF_ORDER' };
  }
  if (lastForType > 0 && eventTime === lastForType) {
    return { state, applied: false, duplicate: true, reason: 'STREAM_EVENT_DUPLICATE' };
  }

  state.lastEventTimeByType = { ...(state.lastEventTimeByType || {}), [type]: eventTime };
  state.lastEventAt = Math.max(num(state.lastEventAt), eventTime);

  if (type === 'listenKeyExpired') {
    state.connected = false;
    state.needsReconciliation = true;
    withReason(state, 'LISTEN_KEY_EXPIRED');
    return { state, applied: true, reason: 'LISTEN_KEY_EXPIRED' };
  }

  if (type === 'ORDER_TRADE_UPDATE') {
    const o = event.o || {};
    const key = orderKey(o);
    if (!key) {
      withReason(state, 'ORDER_EVENT_IDENTITY_INVALID');
      return { state, applied: false, reason: 'ORDER_EVENT_IDENTITY_INVALID' };
    }
    const normalized = {
      symbol: String(o.s || '').toUpperCase(),
      clientOrderId: String(o.c || ''),
      orderId: String(o.i ?? ''),
      side: String(o.S || ''),
      type: String(o.o || ''),
      timeInForce: String(o.f || ''),
      originalQuantity: String(o.q ?? ''),
      originalPrice: String(o.p ?? ''),
      averagePrice: String(o.ap ?? ''),
      executionType: String(o.x || ''),
      status: String(o.X || ''),
      lastFilledQuantity: String(o.l ?? ''),
      cumulativeFilledQuantity: String(o.z ?? ''),
      lastFilledPrice: String(o.L ?? ''),
      tradeId: String(o.t ?? ''),
      realizedProfit: String(o.rp ?? ''),
      commissionAsset: String(o.N || ''),
      commission: String(o.n ?? ''),
      reduceOnly: o.R === true,
      positionSide: String(o.ps || ''),
      priceMatch: String(o.pm || ''),
      expiryReason: String(o.er ?? ''),
      eventTime,
      transactionTime: num(event.T),
      orderTradeTime: num(o.T),
      terminal: terminalOrderStatus(o.X),
    };
    state.standardOrders = { ...(state.standardOrders || {}), [key]: normalized };
    return { state, applied: true, kind: 'ORDER', key, terminal: normalized.terminal };
  }

  if (type === 'ALGO_UPDATE') {
    const o = event.o || {};
    const key = algoKey(o);
    if (!key) {
      withReason(state, 'ALGO_EVENT_IDENTITY_INVALID');
      return { state, applied: false, reason: 'ALGO_EVENT_IDENTITY_INVALID' };
    }
    const normalized = {
      symbol: String(o.s ?? o.symbol ?? '').toUpperCase(),
      algoId: String(o.ai ?? o.algoId ?? o.i ?? ''),
      clientAlgoId: String(o.ca ?? o.clientAlgoId ?? o.c ?? ''),
      status: String(o.X ?? o.algoStatus ?? ''),
      orderType: String(o.o ?? o.orderType ?? ''),
      side: String(o.S ?? o.side ?? ''),
      positionSide: String(o.ps ?? o.positionSide ?? ''),
      triggerPrice: String(o.sp ?? o.triggerPrice ?? ''),
      activated: o.ia === true,
      eventTime,
      transactionTime: num(event.T),
      raw: o,
    };
    state.algoOrders = { ...(state.algoOrders || {}), [key]: normalized };
    return { state, applied: true, kind: 'ALGO', key };
  }

  if (type === 'ACCOUNT_UPDATE') {
    const a = event.a || {};
    const nextBalances = { ...(state.balances || {}) };
    for (const b of Array.isArray(a.B) ? a.B : []) {
      const asset = String(b.a || '').toUpperCase();
      if (!asset) continue;
      nextBalances[asset] = {
        walletBalance: String(b.wb ?? ''),
        crossWalletBalance: String(b.cw ?? ''),
        balanceChange: String(b.bc ?? ''),
        eventTime,
      };
    }
    state.balances = nextBalances;

    const nextPositions = { ...(state.positions || {}) };
    for (const p of Array.isArray(a.P) ? a.P : []) {
      const key = positionKey(p);
      if (!key) continue;
      const amount = num(p.pa);
      if (amount === 0) {
        delete nextPositions[key];
        continue;
      }
      nextPositions[key] = {
        symbol: String(p.s || '').toUpperCase(),
        positionSide: String(p.ps || 'BOTH'),
        positionAmount: String(p.pa ?? ''),
        entryPrice: String(p.ep ?? ''),
        breakEvenPrice: String(p.bep ?? ''),
        unrealizedPnl: String(p.up ?? ''),
        marginType: String(p.mt || ''),
        isolatedWallet: String(p.iw ?? ''),
        eventReason: String(a.m || ''),
        eventTime,
        transactionTime: num(event.T),
      };
    }
    state.positions = nextPositions;
    return { state, applied: true, kind: 'ACCOUNT' };
  }

  return { state, applied: true, kind: 'IGNORED', ignoredType: type };
}

export function userStreamReady(state) {
  return Boolean(
    state &&
    state.connected === true &&
    state.needsReconciliation === false &&
    state.failClosed === false
  );
}
