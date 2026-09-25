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
  desiredMargin,
  desiredLeverage,
  bracketInfo,
  symbolConfig,
  positions=[],
  standardOrders=[],
  algoOrders=[],
}={}){
  const sym=upper(symbol);
  if(!/^[A-Z0-9]{3,30}$/.test(sym))throw new Error('SYMBOL_INVALID');
  const margin=n(desiredMargin);
  const leverage=Math.floor(n(desiredLeverage));
  if(!(margin>0&&margin<=REAL_RISK_LIMITS.maxMarginUsdt)){
    throw new Error('MARGIN_OVER_SERVER_CAP');
  }
  if(!(leverage>=1&&leverage<=REAL_RISK_LIMITS.maxLeverage)){
    throw new Error('LEVERAGE_OVER_SERVER_CAP');
  }
  const desiredNotional=margin*leverage;
  if(desiredNotional>REAL_RISK_LIMITS.maxNotionalUsdt){
    throw new Error('NOTIONAL_OVER_SERVER_CAP');
  }
  const brackets=Array.isArray(bracketInfo?.brackets)?bracketInfo.brackets:[];
  const bracket=brackets.find(row=>{
    const floor=n(row?.notionalFloor,0);
    const cap=n(row?.notionalCap,Infinity);
    return desiredNotional>=floor&&desiredNotional<cap;
  })||null;
  if(!bracket)throw new Error('LEVERAGE_BRACKET_UNAVAILABLE');
  const bracketMaxLeverage=Math.floor(n(bracket?.initialLeverage,0));
  if(!(bracketMaxLeverage>0)||leverage>bracketMaxLeverage){
    return {
      ok:false,
      reason:'LEVERAGE_BRACKET_EXCEEDED',
      symbol:sym,
      desiredMargin:margin,
      desiredLeverage:leverage,
      desiredNotional,
      bracketMaxLeverage,
      bracketNotionalFloor:n(bracket?.notionalFloor,0),
      bracketNotionalCap:n(bracket?.notionalCap,0),
    };
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
      desiredMargin:margin,
      desiredLeverage:leverage,
      desiredNotional,
      bracketMaxLeverage,
      bracketNotionalFloor:n(bracket?.notionalFloor,0),
      bracketNotionalCap:n(bracket?.notionalCap,0),
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
    desiredMargin:margin,
    desiredLeverage:leverage,
    desiredNotional,
    bracketMaxLeverage,
    bracketNotionalFloor:n(bracket?.notionalFloor,0),
    bracketNotionalCap:n(bracket?.notionalCap,0),
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
