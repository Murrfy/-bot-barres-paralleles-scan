import { deterministicClientOrderId } from './order-intent.mjs';

function n(value,fallback=NaN){const x=Number(value);return Number.isFinite(x)?x:fallback}
function symbolText(value){
  const symbol=String(value||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))throw new Error('SYMBOL_INVALID');
  return symbol;
}
function commandText(value){
  const id=String(value||'').trim();
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(id))throw new Error('COMMAND_ID_INVALID');
  return id;
}
function positive(value,code){const x=n(value);if(!(x>0))throw new Error(code);return x}

export function buildProtectiveAlgoPlan({
  commandId,symbol,direction,quantity,triggerPrice,limitPrice=0,protectionKind='PROGRESSIVE',attempt=0,priceMatch='OPPONENT'
}={}){
  const id=commandText(commandId),sym=symbolText(symbol);
  const dir=String(direction||'').toUpperCase();
  if(!['LONG','SHORT'].includes(dir))throw new Error('POSITION_DIRECTION_INVALID');
  const trigger=positive(triggerPrice,'TRIGGER_PRICE_INVALID');
  const kind=String(protectionKind||'').toUpperCase();
  const side=dir==='LONG'?'SELL':'BUY';
  const params={
    algoType:'CONDITIONAL',
    symbol:sym,
    side,
    positionSide:'BOTH',
    triggerPrice:String(trigger),
    workingType:'CONTRACT_PRICE',
    priceProtect:'false',
  };

  if(kind==='PROGRESSIVE'){
    const qty=positive(quantity,'QUANTITY_INVALID');
    const limit=positive(limitPrice,'PROGRESSIVE_LIMIT_PRICE_INVALID');
    if(Math.abs(limit-trigger)>Math.max(1e-9,Math.abs(trigger)*1e-10)){
      throw new Error('PROGRESSIVE_TRIGGER_LIMIT_MUST_MATCH');
    }
    params.type='STOP';
    params.timeInForce='GTC';
    params.quantity=String(qty);
    params.reduceOnly='true';
    params.price=String(limit);
    params.clientAlgoId=deterministicClientOrderId({
      commandId:id,symbol:sym,leg:'PROGRESSIVE_STOP',attempt
    });
  }else if(kind==='MAX_LOSS'){
    const qty=positive(quantity,'QUANTITY_INVALID');
    const match=String(priceMatch||'OPPONENT').toUpperCase();
    if(!['OPPONENT','OPPONENT_5','OPPONENT_10','OPPONENT_20'].includes(match)){
      throw new Error('PRICE_MATCH_INVALID');
    }
    params.type='STOP';
    params.timeInForce='IOC';
    params.quantity=String(qty);
    params.reduceOnly='true';
    params.priceMatch=match;
    params.clientAlgoId=deterministicClientOrderId({
      commandId:id,symbol:sym,leg:'MAXLOSS_STOP',attempt
    });
  }else{
    throw new Error('PROTECTION_KIND_INVALID');
  }

  return {
    version:1,
    commandId:id,
    endpoint:'/fapi/v1/algoOrder',
    method:'POST',
    protectionKind:kind,
    params,
  };
}

export function protectiveAlgoIdentity(plan={}){
  const p=plan?.params||{};
  return {
    symbol:String(p.symbol||'').toUpperCase(),
    side:String(p.side||'').toUpperCase(),
    positionSide:String(p.positionSide||'BOTH').toUpperCase(),
    type:String(p.type||'').toUpperCase(),
    triggerPrice:String(p.triggerPrice||''),
    quantity:p.quantity,
    reduceOnly:p.reduceOnly,
    closePosition:p.closePosition,
    price:p.price,
    priceMatch:p.priceMatch,
    clientAlgoId:String(p.clientAlgoId||''),
  };
}
