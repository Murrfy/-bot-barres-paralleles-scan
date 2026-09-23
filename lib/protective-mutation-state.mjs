import { deterministicClientOrderId } from './order-intent.mjs';

const TERMINAL_STANDARD=new Set(['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED']);
const TERMINAL_ALGO=new Set(['CANCELED','TRIGGERED','FINISHED','REJECTED','EXPIRED']);

function n(value,fallback=0){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function bool(value){return value===true||value==='true'}
function cleanSymbol(value){
  const symbol=String(value||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))throw new Error('SYMBOL_INVALID');
  return symbol;
}
function cleanDirection(value){
  const d=String(value||'').toUpperCase();
  if(!['LONG','SHORT'].includes(d))throw new Error('DIRECTION_INVALID');
  return d;
}
function oppositeSide(direction){return cleanDirection(direction)==='LONG'?'SELL':'BUY'}
function nearly(a,b){const aa=n(a,NaN),bb=n(b,NaN);return Number.isFinite(aa)&&Number.isFinite(bb)&&Math.abs(aa-bb)<=Math.max(1e-12,Math.abs(bb)*1e-10)}

function activeStandardFromStream(state){
  return Object.values(state?.standardOrders||{}).filter(o=>o&&!TERMINAL_STANDARD.has(String(o.status||'').toUpperCase())).map(o=>({
    orderClass:'STANDARD',
    symbol:String(o.symbol||'').toUpperCase(),
    orderId:String(o.orderId??''),
    clientOrderId:String(o.clientOrderId??''),
    side:String(o.side||'').toUpperCase(),
    positionSide:String(o.positionSide||'BOTH').toUpperCase(),
    type:String(o.type||'').toUpperCase(),
    status:String(o.status||'').toUpperCase(),
    origQty:String(o.originalQuantity??''),
    executedQty:String(o.cumulativeFilledQuantity??''),
    price:String(o.originalPrice??''),
    reduceOnly:bool(o.reduceOnly),
    closePosition:bool(o.closePosition),
    timeInForce:String(o.timeInForce||'').toUpperCase(),
  }));
}
function activeAlgoFromStream(state){
  return Object.values(state?.algoOrders||{}).filter(o=>o&&!TERMINAL_ALGO.has(String(o.status||'').toUpperCase())).map(o=>({
    orderClass:'ALGO',
    symbol:String(o.symbol||'').toUpperCase(),
    algoId:String(o.algoId??''),
    clientAlgoId:String(o.clientAlgoId??''),
    side:String(o.side||'').toUpperCase(),
    positionSide:String(o.positionSide||'BOTH').toUpperCase(),
    type:String(o.orderType||'').toUpperCase(),
    status:String(o.status||'').toUpperCase(),
    triggerPrice:String(o.triggerPrice??''),
    reduceOnly:bool(o.reduceOnly),
    closePosition:bool(o.closePosition),
    workingType:String(o.workingType||'').toUpperCase(),
  }));
}
function activeOrders(source){
  if(Array.isArray(source?.data?.binanceOrders))return source.data.binanceOrders;
  return [...activeStandardFromStream(source),...activeAlgoFromStream(source)];
}
function positions(source){
  if(Array.isArray(source?.data?.binancePositions))return source.data.binancePositions;
  return Object.values(source?.positions||{}).filter(p=>p&&n(p.positionAmount)!==0).map(p=>({
    symbol:String(p.symbol||'').toUpperCase(),
    positionSide:String(p.positionSide||'BOTH').toUpperCase(),
    positionAmt:String(p.positionAmount??''),
    quantity:Math.abs(n(p.positionAmount)),
  }));
}
function ready(source){
  if(source?.data?.userStream)return source.data.userStream.ready===true&&source.data.userStream.failClosed===false&&source.data.userStream.needsReconciliation===false;
  return source?.connected===true&&source?.failClosed===false&&source?.needsReconciliation===false;
}

export function runtimePositionQuantity(source,symbol,direction){
  const sym=cleanSymbol(symbol),dir=cleanDirection(direction);
  let qty=0;
  for(const p of positions(source)){
    if(String(p?.symbol||'').toUpperCase()!==sym)continue;
    const ps=String(p?.positionSide||'BOTH').toUpperCase();
    const amount=n(p?.positionAmt??p?.quantity??0);
    const actual=ps==='LONG'||ps==='SHORT'?ps:(amount<0?'SHORT':'LONG');
    if(actual===dir)qty=Math.max(qty,Math.abs(amount));
  }
  return qty;
}

export function selectExactExitOrder(source,{symbol,direction,clientOrderId=''}={}){
  const sym=cleanSymbol(symbol),side=oppositeSide(direction),cid=String(clientOrderId||'');
  const candidates=activeOrders(source).filter(o=>
    String(o?.orderClass||'STANDARD').toUpperCase()==='STANDARD'&&
    String(o?.symbol||'').toUpperCase()===sym&&
    String(o?.side||'').toUpperCase()===side&&
    String(o?.positionSide||'BOTH').toUpperCase()==='BOTH'&&
    String(o?.type||'').toUpperCase()==='LIMIT'&&
    String(o?.timeInForce||'GTC').toUpperCase()==='GTC'&&
    bool(o?.reduceOnly)&&!bool(o?.closePosition)
  );
  if(cid){
    const order=candidates.find(o=>String(o?.clientOrderId||'')===cid)||null;
    return {order,candidates,reason:order?'':'EXIT_ORDER_NOT_FOUND'};
  }
  if(candidates.length>1)return {order:null,candidates,reason:'EXIT_ORDER_AMBIGUOUS'};
  return {order:candidates[0]||null,candidates,reason:candidates.length?'':'EXIT_ORDER_NOT_FOUND'};
}

export function selectProtectionOrder(source,{symbol,direction,clientAlgoId=''}={}){
  const sym=cleanSymbol(symbol),side=oppositeSide(direction),cid=String(clientAlgoId||'');
  const candidates=activeOrders(source).filter(o=>
    String(o?.orderClass||'').toUpperCase()==='ALGO'&&
    String(o?.symbol||'').toUpperCase()===sym&&
    String(o?.side||'').toUpperCase()===side&&
    String(o?.positionSide||'BOTH').toUpperCase()==='BOTH'&&
    String(o?.type||'').toUpperCase()==='STOP_MARKET'&&
    bool(o?.closePosition)&&!bool(o?.reduceOnly)
  );
  if(cid){
    const order=candidates.find(o=>String(o?.clientAlgoId||'')===cid)||null;
    return {order,candidates,reason:order?'':'PROTECTION_ORDER_NOT_FOUND'};
  }
  if(candidates.length>1)return {order:null,candidates,reason:'PROTECTION_ORDER_AMBIGUOUS'};
  return {order:candidates[0]||null,candidates,reason:candidates.length?'':'PROTECTION_ORDER_NOT_FOUND'};
}

export function buildProtectionReplacementPlan({commandId,symbol,direction,triggerPrice}={}){
  const sym=cleanSymbol(symbol),dir=cleanDirection(direction);
  const trigger=n(triggerPrice,NaN);
  if(!(trigger>0))throw new Error('TRIGGER_PRICE_INVALID');
  const clientAlgoId=deterministicClientOrderId({commandId,symbol:sym,leg:'PROTECT'});
  return {
    clientAlgoId,
    params:{
      algoType:'CONDITIONAL',
      symbol:sym,
      side:oppositeSide(dir),
      positionSide:'BOTH',
      type:'STOP_MARKET',
      triggerPrice:String(trigger),
      workingType:'MARK_PRICE',
      closePosition:'true',
      priceProtect:'false',
      clientAlgoId,
    },
  };
}

export function validateProtectionTrigger({direction,triggerPrice,markPrice}={}){
  const dir=cleanDirection(direction),trigger=n(triggerPrice,NaN),mark=n(markPrice,NaN);
  if(!(trigger>0)||!(mark>0))return {ok:false,reason:'PROTECTION_PRICE_INVALID'};
  if(dir==='LONG'&&!(trigger<mark))return {ok:false,reason:'LONG_STOP_WOULD_TRIGGER_IMMEDIATELY'};
  if(dir==='SHORT'&&!(trigger>mark))return {ok:false,reason:'SHORT_STOP_WOULD_TRIGGER_IMMEDIATELY'};
  return {ok:true};
}

export function evaluateExitUpdateConfirmation(source,{symbol,direction,quantity,targetPrice,clientOrderId}={}){
  const streamReady=ready(source);
  const liveQty=runtimePositionQuantity(source,symbol,direction);
  const selected=selectExactExitOrder(source,{symbol,direction,clientOrderId});
  const order=selected.order;
  const ok=Boolean(
    streamReady&&
    liveQty>0&&
    order&&
    n(order.executedQty)<=1e-12&&
    nearly(order.origQty,quantity)&&
    nearly(order.price,targetPrice)
  );
  return {
    confirmed:ok,
    streamReady,
    liveQuantity:liveQty,
    order,
    reason:!streamReady?'USER_STREAM_NOT_READY':
      !(liveQty>0)?'POSITION_NOT_FOUND':
      !order?(selected.reason||'EXIT_ORDER_NOT_FOUND'):
      n(order.executedQty)>1e-12?'EXIT_ORDER_PARTIALLY_FILLED':
      !nearly(order.origQty,quantity)?'EXIT_ORDER_QUANTITY_MISMATCH':
      !nearly(order.price,targetPrice)?'EXIT_ORDER_PRICE_MISMATCH':'EXIT_UPDATE_CONFIRMED',
  };
}

export function evaluateProtectionUpdateConfirmation(source,{
  symbol,direction,triggerPrice,replacementClientAlgoId,previousClientAlgoId=''
}={}){
  const streamReady=ready(source);
  const liveQty=runtimePositionQuantity(source,symbol,direction);
  const replacement=selectProtectionOrder(source,{symbol,direction,clientAlgoId:replacementClientAlgoId}).order;
  const previous=previousClientAlgoId&&previousClientAlgoId!==replacementClientAlgoId
    ?selectProtectionOrder(source,{symbol,direction,clientAlgoId:previousClientAlgoId}).order:null;
  const replacementMatches=Boolean(replacement&&nearly(replacement.triggerPrice??replacement.stopPrice,triggerPrice));
  const ok=Boolean(streamReady&&liveQty>0&&replacementMatches&&!previous);
  return {
    confirmed:ok,
    streamReady,
    liveQuantity:liveQty,
    replacement,
    previousStillActive:Boolean(previous),
    reason:!streamReady?'USER_STREAM_NOT_READY':
      !(liveQty>0)?'POSITION_NOT_FOUND':
      !replacement?'REPLACEMENT_PROTECTION_NOT_FOUND':
      !replacementMatches?'REPLACEMENT_TRIGGER_MISMATCH':
      previous?'PREVIOUS_PROTECTION_STILL_ACTIVE':'PROTECTION_UPDATE_CONFIRMED',
  };
}
