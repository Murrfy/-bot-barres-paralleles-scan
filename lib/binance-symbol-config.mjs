import { REAL_RISK_LIMITS } from './risk-policy.mjs';

function n(value,fallback=NaN){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function upper(value){return String(value??'').trim().toUpperCase()}
function isProtective(order){
  return order?.reduceOnly===true||order?.reduceOnly==='true'||
    order?.closePosition===true||order?.closePosition==='true';
}

export function planEntrySymbolConfiguration({
  symbol,
  desiredLeverage,
  symbolConfig,
  positions=[],
  standardOrders=[],
  algoOrders=[],
}={}){
  const sym=upper(symbol);
  if(!/^[A-Z0-9]{3,30}$/.test(sym))throw new Error('SYMBOL_INVALID');
  const leverage=Math.floor(n(desiredLeverage));
  if(!(leverage>=1&&leverage<=REAL_RISK_LIMITS.maxLeverage)){
    throw new Error('LEVERAGE_OVER_SERVER_CAP');
  }
  if(!symbolConfig||typeof symbolConfig!=='object')throw new Error('ACCOUNT_SYMBOL_CONFIG_MISSING');

  const livePositions=(Array.isArray(positions)?positions:[])
    .filter(p=>upper(p?.symbol)===sym&&Math.abs(n(p?.positionAmt,0))>0);
  const openOrders=[...(Array.isArray(standardOrders)?standardOrders:[]),...(Array.isArray(algoOrders)?algoOrders:[])]
    .filter(o=>upper(o?.symbol)===sym);

  const currentMarginType=upper(symbolConfig?.marginType);
  const currentLeverage=Math.floor(n(symbolConfig?.leverage,0));
  const needsMarginType=currentMarginType!=='ISOLATED';
  const needsLeverage=currentLeverage!==leverage;
  const needsMutation=needsMarginType||needsLeverage;

  if(needsMutation&&(livePositions.length>0||openOrders.length>0)){
    return {
      ok:false,
      reason:livePositions.length>0?'SYMBOL_CONFIGURATION_POSITION_ACTIVE':'SYMBOL_CONFIGURATION_ORDERS_ACTIVE',
      symbol:sym,
      desiredLeverage:leverage,
      currentLeverage,
      currentMarginType,
      needsMarginType,
      needsLeverage,
      livePositions:livePositions.length,
      openOrders:openOrders.length,
    };
  }

  return {
    ok:true,
    reason:needsMutation?'SYMBOL_CONFIGURATION_CHANGE_REQUIRED':'SYMBOL_CONFIGURATION_READY',
    symbol:sym,
    desiredLeverage:leverage,
    currentLeverage,
    currentMarginType,
    needsMarginType,
    needsLeverage,
    needsMutation,
    livePositions:livePositions.length,
    openOrders:openOrders.length,
    blockingEntryOrders:openOrders.filter(o=>!isProtective(o)).length,
  };
}
