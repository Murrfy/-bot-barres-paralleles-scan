function n(value,fallback=NaN){const x=Number(value);return Number.isFinite(x)?x:fallback}
function upper(value){return String(value??'').toUpperCase()}
function bool(value){return value===true||value==='true'}
function near(a,b){
  const x=n(a),y=n(b);
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=Math.max(1e-9,Math.abs(y)*1e-10);
}
function zenithMaxId(value){
  const id=String(value||'');
  return /^zth-MAX-[A-Za-z0-9._:-]+$/.test(id)&&id.length<=36;
}

export const MAX_LOSS_ALGO_SHAPE=Object.freeze({
  type:'STOP',
  timeInForce:'IOC',
  priceMatch:'OPPONENT',
});

export function isLimitIocMaxLossOrder(order,{
  symbol='',
  side='',
  positionSide='BOTH',
  quantity=NaN,
  clientAlgoId='',
}={}){
  if(!order||typeof order!=='object')return false;
  if(order.orderClass&&upper(order.orderClass)!=='ALGO')return false;
  if(symbol&&upper(order.symbol)!==upper(symbol))return false;
  if(side&&upper(order.side)!==upper(side))return false;
  if(positionSide&&upper(order.positionSide||'BOTH')!==upper(positionSide))return false;
  if(upper(order.orderType||order.type)!==MAX_LOSS_ALGO_SHAPE.type)return false;
  if(upper(order.timeInForce)!==MAX_LOSS_ALGO_SHAPE.timeInForce)return false;
  if(!bool(order.reduceOnly)||bool(order.closePosition))return false;
  if(upper(order.priceMatch||'NONE')!==MAX_LOSS_ALGO_SHAPE.priceMatch)return false;
  const id=String(order.clientAlgoId||'');
  if(!zenithMaxId(id))return false;
  if(clientAlgoId&&id!==String(clientAlgoId))return false;
  const wanted=n(quantity,NaN);
  if(Number.isFinite(wanted)){
    const actual=n(order.origQty??order.quantity,NaN);
    if(!(actual>0)||!near(actual,wanted))return false;
  }
  return true;
}

export function maxLossAlgoExpected({
  symbol,side,quantity,clientAlgoId,triggerPrice,
}={}){
  const out={
    symbol:String(symbol||'').toUpperCase(),
    side:String(side||'').toUpperCase(),
    positionSide:'BOTH',
    type:MAX_LOSS_ALGO_SHAPE.type,
    timeInForce:MAX_LOSS_ALGO_SHAPE.timeInForce,
    quantity:String(quantity),
    reduceOnly:'true',
    priceMatch:MAX_LOSS_ALGO_SHAPE.priceMatch,
    clientAlgoId:String(clientAlgoId||''),
  };
  if(triggerPrice!==undefined)out.triggerPrice=String(triggerPrice);
  return out;
}
