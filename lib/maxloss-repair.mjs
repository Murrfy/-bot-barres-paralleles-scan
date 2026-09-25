import { protectionOnlyMismatchTarget } from './protective-command.mjs';
import { buildRealProtectionLevels } from './real-protection-levels.mjs';
import { REAL_RISK_LIMITS } from './risk-policy.mjs';

function n(value,fallback=0){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function record(value){
  return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
}
function positionDirection(position){
  const amount=n(position?.positionAmt??position?.quantity,0);
  return amount<0?'SHORT':'LONG';
}

export function buildMaxLossRepairPlan({
  report,
  positions=[],
  tokenSettings={},
  settings={},
  priceFilters={},
}={}){
  const target=protectionOnlyMismatchTarget(report);
  if(!target)return {action:'NONE',reason:'NO_EXACT_REPAIR_TARGET'};

  const reasons=Array.isArray(report?.reasons)?report.reasons.map(x=>String(x||'')):[];
  if(reasons.includes('AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION')){
    return {action:'BLOCK',reason:'AMBIGUOUS_MAX_LOSS_REPAIR_UNSAFE',target};
  }
  if(!reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION')){
    return {action:'NONE',reason:'MAX_LOSS_NOT_MISSING',target};
  }

  const split=target.lastIndexOf(':');
  const symbol=split>0?target.slice(0,split).toUpperCase():'';
  const direction=split>0?target.slice(split+1).toUpperCase():'';
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!['LONG','SHORT'].includes(direction)){
    return {action:'BLOCK',reason:'REPAIR_TARGET_INVALID',target};
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
  const targetProfit=Math.max(1,n(tokenCfg.targetProfit,n(globalCfg.targetProfit,1)));
  const priceFilter=record(record(priceFilters)[symbol]);
  if(!(n(priceFilter.tickSize,0)>0)){
    return {action:'BLOCK',reason:'REPAIR_PRICE_FILTER_MISSING',target};
  }

  let levels;
  try{
    levels=buildRealProtectionLevels({
      position,
      targetProfitUsd:targetProfit,
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
    triggerPrice:levels.maxLossTriggerPrice,
    actualMaxLossUsd:levels.actualMaxLossUsd,
    lifecycleAt:Math.max(0,Math.floor(n(
      position?.lifecycleAt??position?.positionLifecycleAt??position?.updateTime,0
    ))),
  };
}
