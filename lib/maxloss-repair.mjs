import { missingMaxLossRepairTarget, maxLossSymbolQuarantine } from './protective-command.mjs';
import { buildEmergencyMaxLossLevel } from './real-protection-levels.mjs';
import { REAL_RISK_LIMITS } from './risk-policy.mjs';

function n(value,fallback=0){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function record(value){
  return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
}
function bool(value){return value===true||String(value||'').toLowerCase()==='true'}
function managedMaxLossId(value){
  const id=String(value||'');
  return /^zth-MAX-[A-Za-z0-9._:-]+$/.test(id)&&id.length<=36;
}
function positionDirection(position){
  const amount=n(position?.positionAmt??position?.quantity,0);
  return amount<0?'SHORT':'LONG';
}

export function buildMaxLossRepairPlan({
  report,
  positions=[],
  orders=[],
  tokenSettings={},
  settings={},
  priceFilters={},
}={}){
  const target=missingMaxLossRepairTarget(report);
  if(!target)return {action:'NONE',reason:'NO_EXACT_REPAIR_TARGET'};

  const reasons=Array.isArray(report?.reasons)?report.reasons.map(x=>String(x||'')):[];
  if(reasons.includes('AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION')){
    return {action:'BLOCK',reason:'AMBIGUOUS_MAX_LOSS_REPAIR_UNSAFE',target};
  }

  const split=target.lastIndexOf(':');
  const symbol=split>0?target.slice(0,split).toUpperCase():'';
  const direction=split>0?target.slice(split+1).toUpperCase():'';
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!['LONG','SHORT'].includes(direction)){
    return {action:'BLOCK',reason:'REPAIR_TARGET_INVALID',target};
  }
  const localRepair=maxLossSymbolQuarantine(report,symbol,direction)?.reason==='MISSING_MAX_LOSS_REPAIR_PENDING';
  if(!reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION')&&!localRepair){
    return {action:'NONE',reason:'MAX_LOSS_NOT_MISSING',target};
  }

  const position=(Array.isArray(positions)?positions:[]).find(row=>{
    if(String(row?.symbol||'').toUpperCase()!==symbol)return false;
    const amount=n(row?.positionAmt??row?.quantity,0);
    if(!amount)return false;
    return positionDirection(row)===direction;
  });
  if(!position)return {action:'BLOCK',reason:'REPAIR_POSITION_NOT_FOUND',target};

  const quantity=Math.abs(n(position?.positionAmt??position?.quantity,0));
  const entryPrice=n(position?.entryPrice,0);
  if(!(quantity>0)||!(entryPrice>0)){
    return {action:'BLOCK',reason:'REPAIR_POSITION_INVALID',target};
  }

  const tokenCfg=record(record(tokenSettings)[symbol]);
  const globalCfg=record(settings);
  const requestedMaxLoss=Math.min(
    REAL_RISK_LIMITS.maxLossUsd,
    Math.max(2,n(tokenCfg.maxLoss,n(globalCfg.maxLoss,REAL_RISK_LIMITS.maxLossUsd)))
  );
  const expectedSide=direction==='LONG'?'SELL':'BUY';
  const staleSamePurpose=(Array.isArray(orders)?orders:[]).filter(order=>{
    if(String(order?.orderClass||'').toUpperCase()!=='ALGO')return false;
    if(String(order?.symbol||'').toUpperCase()!==symbol)return false;
    if(String(order?.side||'').toUpperCase()!==expectedSide)return false;
    if(String(order?.positionSide||'BOTH').toUpperCase()!=='BOTH')return false;
    if(String(order?.type||'').toUpperCase()!=='STOP')return false;
    if(String(order?.timeInForce||'').toUpperCase()!=='IOC')return false;
    if(!bool(order?.reduceOnly)||bool(order?.closePosition))return false;
    if(String(order?.priceMatch||'').toUpperCase()!=='OPPONENT')return false;
    const oldQuantity=n(order?.origQty??order?.quantity,NaN);
    if(!(oldQuantity>quantity+Math.max(1e-12,quantity*1e-10)))return false;
    const trigger=n(order?.triggerPrice??order?.stopPrice,NaN);
    if(!(trigger>0))return false;
    const lossSide=direction==='LONG'?trigger<entryPrice:trigger>entryPrice;
    if(!lossSide)return false;
    const impliedLoss=direction==='LONG'
      ?(entryPrice-trigger)*quantity
      :(trigger-entryPrice)*quantity;
    return impliedLoss>=0&&
      impliedLoss<=requestedMaxLoss+1e-8&&
      impliedLoss<=REAL_RISK_LIMITS.maxLossUsd+1e-8;
  });
  const staleExternal=staleSamePurpose.filter(order=>!managedMaxLossId(order?.clientAlgoId));
  const staleManaged=staleSamePurpose.filter(order=>managedMaxLossId(order?.clientAlgoId));
  if(staleExternal.length){
    return {action:'BLOCK',reason:'STALE_EXTERNAL_MAX_LOSS_REQUIRES_MANUAL_REVIEW',target};
  }
  if(staleManaged.length>1){
    return {action:'BLOCK',reason:'MULTIPLE_STALE_MANAGED_MAX_LOSS',target};
  }

  const priceFilter=record(record(priceFilters)[symbol]);
  if(!(n(priceFilter.tickSize,0)>0)){
    return {action:'BLOCK',reason:'REPAIR_PRICE_FILTER_MISSING',target};
  }

  let levels;
  try{
    levels=buildEmergencyMaxLossLevel({
      position,
      maxLossUsd:requestedMaxLoss,
      priceFilter,
    });
  }catch(error){
    return {action:'BLOCK',reason:String(error?.message||'REPAIR_LEVELS_INVALID'),target};
  }

  if(levels.direction!==direction){
    return {action:'BLOCK',reason:'REPAIR_DIRECTION_MISMATCH',target};
  }

  return {
    action:'REPAIR',
    reason:'MISSING_MAX_LOSS',
    target,
    symbol,
    direction,
    quantity,
    entryPrice,
    maxLossUsd:requestedMaxLoss,
    triggerPrice:levels.triggerPrice,
    actualMaxLossUsd:levels.actualMaxLossUsd,
    ...(staleManaged.length===1?{
      previousClientAlgoId:String(staleManaged[0]?.clientAlgoId||''),
      previousQuantity:n(staleManaged[0]?.origQty??staleManaged[0]?.quantity,NaN),
      previousTriggerPrice:n(staleManaged[0]?.triggerPrice??staleManaged[0]?.stopPrice,NaN),
    }:{}),
    lifecycleAt:Math.max(0,Math.floor(n(
      position?.lifecycleAt??position?.positionLifecycleAt??position?.updateTime,0
    ))),
  };
}
