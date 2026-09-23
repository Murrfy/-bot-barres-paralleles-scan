import { createUserStreamState } from './user-stream-state.mjs';

function clone(v){return JSON.parse(JSON.stringify(v))}
function posKey(p){
  const symbol=String(p?.symbol||'').toUpperCase();
  const side=String(p?.positionSide||'BOTH').toUpperCase();
  return symbol?`${symbol}:${side}`:'';
}
function orderKey(o){
  const symbol=String(o?.symbol||'').toUpperCase();
  const client=String(o?.clientOrderId||'');
  const id=String(o?.orderId||'');
  return client?`${symbol}:client:${client}`:id?`${symbol}:id:${id}`:'';
}
function algoKey(o){
  const symbol=String(o?.symbol||'').toUpperCase();
  const id=String(o?.algoId||'');
  const client=String(o?.clientAlgoId||'');
  return id?`${symbol}:algo:${id}`:client?`${symbol}:algo-client:${client}`:'';
}

export function seedUserStreamStateFromRuntimeSnapshot(snapshot,{connectionId='',connectedAt=Date.now()}={}){
  if(!snapshot||!Array.isArray(snapshot.positions)||!Array.isArray(snapshot.standardOrders)||!Array.isArray(snapshot.algoOrders)){
    throw new Error('RUNTIME_SEED_INVALID');
  }
  const state=createUserStreamState();
  state.connected=true;
  state.connectionId=String(connectionId||'');
  state.connectedAt=Number(connectedAt)||Date.now();
  state.lastEventAt=Number(snapshot.observedAt||0);
  state.needsReconciliation=true;
  state.failClosed=true;
  state.failReasons=['RECONCILIATION_REQUIRED_AFTER_SEED'];

  state.positions={};
  for(const p of snapshot.positions){
    const key=posKey(p);if(!key)throw new Error('RUNTIME_SEED_POSITION_INVALID');
    state.positions[key]={
      symbol:String(p.symbol||'').toUpperCase(),
      positionSide:String(p.positionSide||'BOTH').toUpperCase(),
      positionAmount:String(p.positionAmt??''),
      entryPrice:String(p.entryPrice??''),
      breakEvenPrice:String(p.breakEvenPrice??''),
      unrealizedPnl:String(p.unrealizedProfit??''),
      marginType:String(p.marginType||''),
      isolatedWallet:String(p.isolatedMargin??''),
      eventTime:Number(snapshot.observedAt||0),
      transactionTime:Number(snapshot.serverTime||0),
      seeded:true,
    };
  }

  state.standardOrders={};
  for(const o of snapshot.standardOrders){
    const key=orderKey(o);if(!key)throw new Error('RUNTIME_SEED_ORDER_INVALID');
    state.standardOrders[key]={
      symbol:String(o.symbol||'').toUpperCase(),
      clientOrderId:String(o.clientOrderId||''),
      orderId:String(o.orderId||''),
      side:String(o.side||'').toUpperCase(),
      type:String(o.type||'').toUpperCase(),
      timeInForce:String(o.timeInForce||''),
      originalQuantity:String(o.origQty??''),
      originalPrice:String(o.price??''),
      stopPrice:String(o.stopPrice??''),
      executionType:'SEED',
      status:String(o.status||'').toUpperCase(),
      cumulativeFilledQuantity:String(o.executedQty??''),
      reduceOnly:o.reduceOnly===true,
      closePosition:o.closePosition===true,
      positionSide:String(o.positionSide||'BOTH').toUpperCase(),
      workingType:String(o.workingType||''),
      eventTime:Number(snapshot.observedAt||0),
      transactionTime:Number(snapshot.serverTime||0),
      terminal:false,
      seeded:true,
    };
  }

  state.algoOrders={};
  for(const o of snapshot.algoOrders){
    const key=algoKey(o);if(!key)throw new Error('RUNTIME_SEED_ALGO_INVALID');
    state.algoOrders[key]={
      symbol:String(o.symbol||'').toUpperCase(),
      algoId:String(o.algoId||''),
      clientAlgoId:String(o.clientAlgoId||''),
      status:String(o.status||'').toUpperCase(),
      orderType:String(o.type||'').toUpperCase(),
      side:String(o.side||'').toUpperCase(),
      positionSide:String(o.positionSide||'BOTH').toUpperCase(),
      triggerPrice:String(o.triggerPrice??o.stopPrice??''),
      reduceOnly:o.reduceOnly===true,
      closePosition:o.closePosition===true,
      timeInForce:String(o.timeInForce||''),
      workingType:String(o.workingType||''),
      activated:false,
      eventTime:Number(snapshot.observedAt||0),
      transactionTime:Number(snapshot.serverTime||0),
      raw:clone(o),
      seeded:true,
    };
  }
  return state;
}
