const ALLOWED_PRICE_MATCH = new Set([
  'OPPONENT','OPPONENT_5','OPPONENT_10','OPPONENT_20',
  'QUEUE','QUEUE_5','QUEUE_10','QUEUE_20',
]);
const CLIENT_ID_RE=/^[.A-Z:/a-z0-9_-]{1,36}$/;

function positive(v,code){
  const n=Number(v);
  if(!Number.isFinite(n)||!(n>0))throw new Error(code);
  return n;
}

function text(v){return String(v??'')}

export function validateStandardOrderPlan(plan){
  if(!plan||typeof plan!=='object')throw new Error('ORDER_PLAN_REQUIRED');
  if(plan.writeAllowed!==false)throw new Error('ORDER_PLAN_MUST_REMAIN_NON_EXECUTING');
  if(plan.endpoint!=='/fapi/v1/order'||String(plan.method||'').toUpperCase()!=='POST'){
    throw new Error('ORDER_PLAN_ENDPOINT_INVALID');
  }

  const p={...(plan.params||{})};
  const symbol=text(p.symbol).toUpperCase();
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))throw new Error('SYMBOL_INVALID');
  const side=text(p.side).toUpperCase();
  if(!['BUY','SELL'].includes(side))throw new Error('SIDE_INVALID');
  const type=text(p.type).toUpperCase();
  if(!['LIMIT','MARKET'].includes(type))throw new Error('STANDARD_ORDER_TYPE_INVALID');
  if(text(p.positionSide).toUpperCase()!=='BOTH')throw new Error('POSITION_SIDE_NOT_ONE_WAY');

  const quantity=positive(p.quantity,'QUANTITY_INVALID');
  const reduceOnly=text(p.reduceOnly).toLowerCase();
  if(!['true','false'].includes(reduceOnly))throw new Error('REDUCE_ONLY_INVALID');

  const clientOrderId=text(p.newClientOrderId);
  if(!CLIENT_ID_RE.test(clientOrderId))throw new Error('CLIENT_ORDER_ID_INVALID');

  const out={
    symbol,
    side,
    positionSide:'BOTH',
    type,
    quantity:String(quantity),
    reduceOnly,
    newClientOrderId:clientOrderId,
  };

  if(type==='MARKET'){
    if(p.price!==undefined||p.priceMatch!==undefined||p.timeInForce!==undefined){
      throw new Error('MARKET_ORDER_FIELDS_INVALID');
    }
  }else{
    const tif=text(p.timeInForce).toUpperCase();
    if(!['GTC','IOC','FOK','GTX'].includes(tif))throw new Error('TIME_IN_FORCE_INVALID');
    out.timeInForce=tif;
    const hasPrice=p.price!==undefined&&p.price!==null&&text(p.price)!=='';
    const hasPriceMatch=p.priceMatch!==undefined&&p.priceMatch!==null&&text(p.priceMatch)!=='';
    if(hasPrice===hasPriceMatch)throw new Error('LIMIT_REQUIRES_EXACTLY_ONE_PRICE_MODE');
    if(hasPrice)out.price=String(positive(p.price,'PRICE_INVALID'));
    if(hasPriceMatch){
      const priceMatch=text(p.priceMatch).toUpperCase();
      if(!ALLOWED_PRICE_MATCH.has(priceMatch))throw new Error('PRICE_MATCH_INVALID');
      out.priceMatch=priceMatch;
    }
  }

  return out;
}
