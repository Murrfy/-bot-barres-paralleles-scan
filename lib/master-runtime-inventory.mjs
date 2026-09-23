function bool(value) {
  return value === true || value === 'true';
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

const TERMINAL_ALGO = new Set(['CANCELED','TRIGGERED','FINISHED','REJECTED','EXPIRED']);

export function runtimeInventoryFromUserStream(state, executionMode = 'SIMULATION') {
  const positions = values(state?.positions)
    .filter(p => p && p.symbol && Number(p.positionAmount) !== 0)
    .map(p => ({
      symbol: String(p.symbol || '').toUpperCase(),
      positionSide: String(p.positionSide || 'BOTH').toUpperCase(),
      positionAmt: String(p.positionAmount ?? ''),
      quantity: Math.abs(Number(p.positionAmount || 0)),
      entryPrice: Number(p.entryPrice || 0),
      breakEvenPrice: Number(p.breakEvenPrice || 0),
      unrealizedProfit: Number(p.unrealizedPnl || 0),
      marginType: String(p.marginType || ''),
      isolatedMargin: Number(p.isolatedWallet || 0),
      updateTime: Number(p.eventTime || 0),
    }));

  const standardOrders = values(state?.standardOrders)
    .filter(o => o && o.symbol && o.terminal !== true)
    .map(o => ({
      orderClass: 'STANDARD',
      symbol: String(o.symbol || '').toUpperCase(),
      orderId: String(o.orderId ?? ''),
      clientOrderId: String(o.clientOrderId ?? ''),
      side: String(o.side || '').toUpperCase(),
      positionSide: String(o.positionSide || 'BOTH').toUpperCase(),
      type: String(o.type || '').toUpperCase(),
      status: String(o.status || '').toUpperCase(),
      origQty: String(o.originalQuantity ?? ''),
      executedQty: String(o.cumulativeFilledQuantity ?? ''),
      price: String(o.originalPrice ?? ''),
      stopPrice: String(o.stopPrice ?? ''),
      reduceOnly: bool(o.reduceOnly),
      closePosition: bool(o.closePosition),
      timeInForce: String(o.timeInForce || ''),
      workingType: String(o.workingType || ''),
      priceMatch: String(o.priceMatch || o.raw?.pm || o.raw?.priceMatch || ''),
      updateTime: Number(o.eventTime || 0),
    }));

  const algoOrders = values(state?.algoOrders)
    .filter(o => o && o.symbol && !TERMINAL_ALGO.has(String(o.status || '').toUpperCase()))
    .map(o => ({
      orderClass: 'ALGO',
      symbol: String(o.symbol || '').toUpperCase(),
      algoId: String(o.algoId ?? ''),
      clientAlgoId: String(o.clientAlgoId ?? ''),
      side: String(o.side || '').toUpperCase(),
      positionSide: String(o.positionSide || 'BOTH').toUpperCase(),
      type: String(o.orderType || '').toUpperCase(),
      status: String(o.status || '').toUpperCase(),
      origQty: String(o.raw?.q ?? o.raw?.quantity ?? ''),
      executedQty: '',
      price: String(o.price ?? o.raw?.p ?? o.raw?.price ?? ''),
      stopPrice: String(o.triggerPrice ?? ''),
      triggerPrice: String(o.triggerPrice ?? ''),
      reduceOnly: bool(o.reduceOnly),
      closePosition: bool(o.closePosition),
      timeInForce: String(o.timeInForce || ''),
      workingType: String(o.workingType || ''),
      updateTime: Number(o.eventTime || 0),
    }));

  const orders = [...standardOrders, ...algoOrders];
  const ready = streamReady(state);
  const mode = String(executionMode || 'SIMULATION').toUpperCase() === 'REAL' ? 'REAL' : 'SIMULATION';

  return {
    executionMode: mode,
    mode,
    openPositions: positions,
    activePositions: positions.length,
    openOrders: orders,
    openOrderCount: orders.length,
    binancePositions: positions,
    binanceOrders: orders,
    userStream: {
      connected: state?.connected === true,
      ready,
      failClosed: state?.failClosed !== false,
      needsReconciliation: state?.needsReconciliation !== false,
      failReasons: Array.isArray(state?.failReasons) ? [...state.failReasons] : ['STREAM_STATE_MISSING'],
      connectionId: String(state?.connectionId || ''),
    },
  };
}
