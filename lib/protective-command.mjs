function n(value){const x=Number(value);return Number.isFinite(x)?x:NaN}
function cleanSymbol(value){
  const symbol=String(value||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))throw new Error('SYMBOL_INVALID');
  return symbol;
}
function cleanDirection(value){
  const direction=String(value||'').toUpperCase();
  if(!['LONG','SHORT'].includes(direction))throw new Error('DIRECTION_INVALID');
  return direction;
}
function optionalZenithId(value,code){
  const id=String(value||'');
  if(!id)return '';
  if(id.length>36||!/^zth-[A-Za-z0-9._:-]+$/.test(id))throw new Error(code);
  return id;
}

export function normalizeProtectiveUpdatePayload(type,payload={}){
  const commandType=String(type||'').toUpperCase();
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('PAYLOAD_OBJECT_REQUIRED');
  const symbol=cleanSymbol(payload.symbol);
  const direction=cleanDirection(payload.direction);
  const quantity=n(payload.quantity);
  if(!(quantity>0))throw new Error('QUANTITY_INVALID');

  if(commandType==='EXEC_UPDATE_EXIT'){
    const targetPrice=n(payload.targetPrice);
    if(!(targetPrice>0))throw new Error('TARGET_PRICE_INVALID');
    return {
      type:commandType,symbol,direction,quantity,targetPrice,
      previousClientOrderId:optionalZenithId(payload.previousClientOrderId,'PREVIOUS_EXIT_ID_INVALID'),
    };
  }

  if(commandType==='EXEC_UPDATE_PROTECTION'){
    const triggerPrice=n(payload.triggerPrice);
    if(!(triggerPrice>0))throw new Error('TRIGGER_PRICE_INVALID');
    const protectionKind=String(payload.protectionKind||'PROGRESSIVE').toUpperCase();
    if(!['PROGRESSIVE','MAX_LOSS'].includes(protectionKind))throw new Error('PROTECTION_KIND_INVALID');
    return {
      type:commandType,symbol,direction,quantity,triggerPrice,protectionKind,
      previousClientAlgoId:optionalZenithId(payload.previousClientAlgoId,'PREVIOUS_PROTECTION_ID_INVALID'),
    };
  }

  throw new Error('PROTECTIVE_UPDATE_TYPE_INVALID');
}

export function validateUpdateAgainstLivePosition(update,position){
  if(!position)throw new Error('POSITION_NOT_FOUND');
  if(String(position?.positionSide||'BOTH').toUpperCase()!=='BOTH')throw new Error('HEDGE_MODE_UNSUPPORTED');
  const amount=n(position?.positionAmt??position?.quantity);
  if(!Number.isFinite(amount)||amount===0)throw new Error('POSITION_NOT_FOUND');
  const direction=amount>0?'LONG':'SHORT';
  if(direction!==update.direction)throw new Error('POSITION_DIRECTION_MISMATCH');
  const liveQuantity=Math.abs(amount);
  if(Math.abs(liveQuantity-update.quantity)>1e-12)throw new Error('FULL_POSITION_QUANTITY_REQUIRED');

  const entry=n(position?.entryPrice);
  if(!(entry>0))throw new Error('ENTRY_PRICE_INVALID');

  if(update.type==='EXEC_UPDATE_EXIT'){
    if(update.direction==='LONG'&&!(update.targetPrice>entry))throw new Error('LONG_TARGET_MUST_BE_ABOVE_ENTRY');
    if(update.direction==='SHORT'&&!(update.targetPrice<entry))throw new Error('SHORT_TARGET_MUST_BE_BELOW_ENTRY');
  }else if(update.protectionKind==='PROGRESSIVE'){
    if(update.direction==='LONG'&&update.triggerPrice<entry)throw new Error('LONG_PROGRESSIVE_TRIGGER_BELOW_ENTRY');
    if(update.direction==='SHORT'&&update.triggerPrice>entry)throw new Error('SHORT_PROGRESSIVE_TRIGGER_ABOVE_ENTRY');
  }else if(update.protectionKind==='MAX_LOSS'){
    if(update.direction==='LONG'&&!(update.triggerPrice<entry))throw new Error('LONG_MAX_LOSS_TRIGGER_NOT_BELOW_ENTRY');
    if(update.direction==='SHORT'&&!(update.triggerPrice>entry))throw new Error('SHORT_MAX_LOSS_TRIGGER_NOT_ABOVE_ENTRY');
  }

  return {liveQuantity,entryPrice:entry,direction};
}
