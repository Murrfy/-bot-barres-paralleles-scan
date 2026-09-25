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
    let limitPrice=NaN,maxLossUsd=NaN;
    if(protectionKind==='PROGRESSIVE'){
      limitPrice=n(payload.limitPrice);
      if(!(limitPrice>0))throw new Error('PROGRESSIVE_LIMIT_PRICE_REQUIRED');
      if(Math.abs(limitPrice-triggerPrice)>Math.max(1e-9,Math.abs(triggerPrice)*1e-10)){
        throw new Error('PROGRESSIVE_TRIGGER_LIMIT_MUST_MATCH');
      }
    }else if(payload.maxLossUsd!=null&&payload.maxLossUsd!==''){
      maxLossUsd=n(payload.maxLossUsd);
      if(!(maxLossUsd>=2&&maxLossUsd<=400))throw new Error('MAX_LOSS_USD_INVALID');
    }
    return {
      type:commandType,symbol,direction,quantity,triggerPrice,protectionKind,
      ...(protectionKind==='PROGRESSIVE'?{limitPrice}:{}),
      ...(protectionKind==='MAX_LOSS'&&Number.isFinite(maxLossUsd)?{maxLossUsd}:{}),
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
    if(!Number.isFinite(update.limitPrice)||update.limitPrice<=0)throw new Error('PROGRESSIVE_LIMIT_PRICE_REQUIRED');
    if(Math.abs(update.limitPrice-update.triggerPrice)>Math.max(1e-9,Math.abs(update.triggerPrice)*1e-10)){
      throw new Error('PROGRESSIVE_TRIGGER_LIMIT_MUST_MATCH');
    }
  }else if(update.protectionKind==='MAX_LOSS'){
    if(update.direction==='LONG'&&!(update.triggerPrice<entry))throw new Error('LONG_MAX_LOSS_TRIGGER_NOT_BELOW_ENTRY');
    if(update.direction==='SHORT'&&!(update.triggerPrice>entry))throw new Error('SHORT_MAX_LOSS_TRIGGER_NOT_ABOVE_ENTRY');
  }

  return {liveQuantity,entryPrice:entry,direction};
}


export function protectionOnlyMismatchTarget(report){
  if(!report||report.version!==2||report.status!=='MISMATCH'||report.failClosed!==true)return '';
  if(!Array.isArray(report.reasons)||!report.reasons.length)return '';
  const allowedReasons=new Set([
    'MISSING_BINANCE_PROTECTION',
    'MISSING_BINANCE_MAX_LOSS_PROTECTION',
    'AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION',
  ]);
  if(report.reasons.some(reason=>!allowedReasons.has(String(reason||''))))return '';

  const targets=[];
  for(const key of ['missingProtections','missingMaxLossProtections','ambiguousMaxLossProtections']){
    const rows=Array.isArray(report?.differences?.[key])?report.differences[key]:[];
    for(const row of rows){
      const target=String(row||'').toUpperCase();
      if(target)targets.push(target);
    }
  }
  const unique=[...new Set(targets)];
  return unique.length===1?unique[0]:'';
}

export function missingMaxLossRepairTarget(report){
  if(!report||report.version!==2||report.status!=='MISMATCH'||report.failClosed!==true)return '';
  const reasons=Array.isArray(report.reasons)?report.reasons.map(reason=>String(reason||'')):[];
  if(!reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION'))return '';
  const allowed=new Set(['MISSING_BINANCE_PROTECTION','MISSING_BINANCE_MAX_LOSS_PROTECTION']);
  if(reasons.some(reason=>!allowed.has(reason)))return '';
  const missing=Array.isArray(report?.differences?.missingMaxLossProtections)
    ?report.differences.missingMaxLossProtections.map(value=>String(value||'').toUpperCase()).filter(Boolean)
    :[];
  const ambiguous=Array.isArray(report?.differences?.ambiguousMaxLossProtections)
    ?report.differences.ambiguousMaxLossProtections.filter(Boolean)
    :[];
  const unsafe=Array.isArray(report?.differences?.unsafeMaxLossProtections)
    ?report.differences.unsafeMaxLossProtections.filter(Boolean)
    :[];
  if(ambiguous.length||unsafe.length)return '';
  const unique=[...new Set(missing)];
  return unique.length===1?unique[0]:'';
}

export function pendingEntryProtectionLossTargets(report){
  if(!report||report.version!==2||report.status!=='MISMATCH'||report.failClosed!==true)return [];
  const reasons=Array.isArray(report.reasons)?report.reasons.map(value=>String(value||'')):[];
  if(!reasons.includes('ENTRY_TRANSITION_PROTECTION_MISSING'))return [];
  const allowedReasons=new Set(['ENTRY_TRANSITION_PROTECTION_MISSING','MISSING_BINANCE_ORDER']);
  if(reasons.some(reason=>!allowedReasons.has(reason)))return [];

  const rows=Array.isArray(report?.differences?.entryTransitions?.missingProtectionPendingEntries)
    ?report.differences.entryTransitions.missingProtectionPendingEntries:[];
  if(!rows.length)return [];

  const out=[];
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object')return [];
    const commandId=String(row.commandId||'');
    const symbol=String(row.symbol||'').toUpperCase();
    const direction=String(row.direction||'').toUpperCase();
    const quantity=n(row.quantity);
    const limitPrice=n(row.limitPrice);
    const entryClientOrderId=String(row.entryClientOrderId||'');
    const protectionClientAlgoId=String(row.protectionClientAlgoId||'');
    const expiresAt=n(row.expiresAt);
    if(!/^[A-Za-z0-9._:-]{8,128}$/.test(commandId)||
       !/^[A-Z0-9]{3,30}$/.test(symbol)||
       !['LONG','SHORT'].includes(direction)||
       !(quantity>0)||!(limitPrice>0)||
       !/^zth-[A-Za-z0-9._:-]+$/.test(entryClientOrderId)||entryClientOrderId.length>36||
       !/^zth-MAX-[A-Za-z0-9._:-]+$/.test(protectionClientAlgoId)||protectionClientAlgoId.length>36||
       !(expiresAt>0))return [];
    const key=symbol+':'+entryClientOrderId;
    if(seen.has(key))return [];
    seen.add(key);
    out.push({
      commandId,symbol,direction,quantity,limitPrice,
      entryClientOrderId,protectionClientAlgoId,expiresAt,
    });
  }

  if(reasons.includes('MISSING_BINANCE_ORDER')){
    const missingOrders=Array.isArray(report?.differences?.missingOrders)?report.differences.missingOrders:[];
    if(!missingOrders.length)return [];
    for(const order of missingOrders){
      const symbol=String(order?.symbol||'').toUpperCase();
      const clientAlgoId=String(order?.clientAlgoId||'');
      if(!out.some(row=>row.symbol===symbol&&row.protectionClientAlgoId===clientAlgoId))return [];
    }
  }

  return out;
}

export function pendingEntryWriteAheadRecoveryTargets(report){
  if(!report||report.version!==2||report.status!=='MISMATCH'||report.failClosed!==true)return [];
  const reasons=Array.isArray(report.reasons)?report.reasons.map(value=>String(value||'')):[];
  if(reasons.length!==1||reasons[0]!=='ENTRY_TRANSITION_ENTRY_MISSING')return [];
  const rows=Array.isArray(report?.differences?.entryTransitions?.entryMissingPreparedProtections)
    ?report.differences.entryTransitions.entryMissingPreparedProtections:[];
  if(!rows.length)return [];

  const out=[];
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object')return [];
    const commandId=String(row.commandId||'');
    const symbol=String(row.symbol||'').toUpperCase();
    const side=String(row.side||'').toUpperCase();
    const direction=String(row.direction||'').toUpperCase();
    const quantity=n(row.quantity);
    const limitPrice=n(row.limitPrice);
    const maxLossUsd=n(row.maxLossUsd);
    const entryClientOrderId=String(row.entryClientOrderId||'');
    const protectionClientAlgoId=String(row.protectionClientAlgoId||'');
    const orderClass=String(row.orderClass||'').toUpperCase();
    const orderSide=String(row.side||'').toUpperCase();
    const positionSide=String(row.positionSide||'BOTH').toUpperCase();
    const type=String(row.type||'').toUpperCase();
    const reduceOnly=row.reduceOnly===true||row.reduceOnly==='true';
    const closePosition=row.closePosition===true||row.closePosition==='true';
    const triggerPrice=n(row.triggerPrice);
    const expiresAt=n(row.expiresAt);
    if(!/^[A-Za-z0-9._:-]{8,128}$/.test(commandId)||
       !/^[A-Z0-9]{3,30}$/.test(symbol)||
       !['BUY','SELL'].includes(side)||
       !['LONG','SHORT'].includes(direction)||
       (side==='BUY'?'LONG':'SHORT')!==direction||
       !(quantity>0)||!(limitPrice>0)||!(maxLossUsd>=2&&maxLossUsd<=400)||
       !/^zth-[A-Za-z0-9._:-]+$/.test(entryClientOrderId)||entryClientOrderId.length>36||
       !/^zth-MAX-[A-Za-z0-9._:-]+$/.test(protectionClientAlgoId)||protectionClientAlgoId.length>36||
       orderClass!=='ALGO'||!['BUY','SELL'].includes(orderSide)||positionSide!=='BOTH'||
       type!=='STOP_MARKET'||reduceOnly||!closePosition||!(triggerPrice>0)||
       (direction==='LONG'?!(triggerPrice<limitPrice):!(triggerPrice>limitPrice))||
       Math.abs(limitPrice-triggerPrice)*quantity>maxLossUsd+1e-8||
       !(expiresAt>0))return [];
    const key=symbol+':'+entryClientOrderId;
    if(seen.has(key))return [];
    seen.add(key);
    out.push({
      commandId,symbol,side,direction,quantity,limitPrice,maxLossUsd,
      entryClientOrderId,protectionClientAlgoId,triggerPrice,expiresAt,
    });
  }
  return out;
}

export function pendingEntryWriteAheadRecoveryAllowed(report,payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return false;
  const commandId=String(payload.commandId||'');
  const symbol=String(payload.symbol||'').toUpperCase();
  const side=String(payload.side||'').toUpperCase();
  const limitPrice=n(payload.limitPrice);
  const maxLossUsd=n(payload.maxLoss??payload.maxLossUsd);
  return pendingEntryWriteAheadRecoveryTargets(report).some(row=>
    row.commandId===commandId&&row.symbol===symbol&&row.side===side&&
    Math.abs(row.limitPrice-limitPrice)<=Math.max(1e-9,Math.abs(row.limitPrice)*1e-10)&&
    Math.abs(row.maxLossUsd-maxLossUsd)<=1e-8
  );
}

export function pendingEntryProtectionLossCancelAllowed(report,payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return false;
  const symbol=String(payload.symbol||'').trim().toUpperCase();
  const clientOrderId=String(payload.clientOrderId||'');
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||
     !/^zth-[A-Za-z0-9._:-]+$/.test(clientOrderId)||clientOrderId.length>36)return false;
  return pendingEntryProtectionLossTargets(report)
    .some(row=>row.symbol===symbol&&row.entryClientOrderId===clientOrderId);
}

export function protectiveRepairTarget(type,payload={}){
  const commandType=String(type||'').toUpperCase();
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return '';
  const symbol=String(payload.symbol||'').trim().toUpperCase();
  const direction=String(payload.direction||'').toUpperCase();
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!['LONG','SHORT'].includes(direction))return '';

  if(commandType==='EXEC_CLOSE_POSITION'&&payload.closeAll===true){
    return `${symbol}:${direction}`;
  }
  if(commandType==='EXEC_UPDATE_PROTECTION'&&String(payload.protectionKind||'').toUpperCase()==='MAX_LOSS'){
    return `${symbol}:${direction}`;
  }
  return '';
}

export function exactProtectiveRepairAllowed(report,type,payload={}){
  const missingTarget=protectionOnlyMismatchTarget(report);
  if(!missingTarget)return false;
  return protectiveRepairTarget(type,payload)===missingTarget;
}


export function orphanZenithCleanupOrders(report){
  if(!report||report.version!==2||report.status!=='MISMATCH'||report.failClosed!==true)return [];
  if(!Array.isArray(report.reasons)||report.reasons.length!==1||
     String(report.reasons[0]||'')!=='ORPHAN_ZENITH_PROTECTIVE_ORDER')return [];
  const rows=Array.isArray(report?.differences?.orphanZenithProtectiveOrders)
    ?report.differences.orphanZenithProtectiveOrders:[];
  const out=[];
  for(const row of rows){
    if(!row||typeof row!=='object')return [];
    const symbol=String(row.symbol||'').toUpperCase();
    const orderClass=String(row.orderClass||'STANDARD').toUpperCase();
    const clientOrderId=String(row.clientOrderId||'');
    const clientAlgoId=String(row.clientAlgoId||'');
    const id=orderClass==='ALGO'?clientAlgoId:clientOrderId;
    const side=String(row.side||'').toUpperCase();
    const positionSide=String(row.positionSide||'BOTH').toUpperCase();
    const type=String(row.type||'').toUpperCase();
    const reduceOnly=row.reduceOnly===true||row.reduceOnly==='true';
    const closePosition=row.closePosition===true||row.closePosition==='true';
    if(!/^[A-Z0-9]{3,30}$/.test(symbol)||
       !['STANDARD','ALGO'].includes(orderClass)||
       !/^zth-[A-Za-z0-9._:-]+$/.test(id)||id.length>36||
       !['BUY','SELL'].includes(side)||positionSide!=='BOTH'||!type||
       !(reduceOnly||closePosition))return [];
    out.push({
      symbol,orderClass,clientOrderId,clientAlgoId,side,positionSide,type,
      reduceOnly,closePosition,
      price:String(row.price??''),
      triggerPrice:String(row.triggerPrice??row.stopPrice??''),
      origQty:String(row.origQty??''),
      timeInForce:String(row.timeInForce||''),
    });
  }
  return out;
}
