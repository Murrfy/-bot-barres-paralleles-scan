import {
  buildProgressiveProtectionLevel,
  highestReachedProtectionStage,
  pnlAtLinearPrice,
} from './real-protection-levels.mjs';

function n(value,fallback=NaN){const x=Number(value);return Number.isFinite(x)?x:fallback}
function bool(value){return value===true||value==='true'}
function zenithId(value){
  const id=String(value||'');
  return /^zth-[A-Za-z0-9._:-]+$/.test(id)&&id.length<=36;
}
function positionShape(position={}){
  const symbol=String(position?.symbol||'').trim().toUpperCase();
  const positionSide=String(position?.positionSide||'BOTH').toUpperCase();
  const amount=n(position?.positionAmt??position?.quantity);
  const entryPrice=n(position?.entryPrice);
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))throw new Error('SYMBOL_INVALID');
  if(positionSide!=='BOTH')throw new Error('HEDGE_MODE_UNSUPPORTED');
  if(!Number.isFinite(amount)||amount===0)throw new Error('POSITION_AMOUNT_INVALID');
  if(!(entryPrice>0))throw new Error('ENTRY_PRICE_INVALID');
  return {
    symbol,
    positionSide,
    positionAmt:amount,
    direction:amount>0?'LONG':'SHORT',
    quantity:Math.abs(amount),
    entryPrice,
    lifecycleAt:Math.max(0,Math.floor(n(position?.lifecycleAt??position?.positionLifecycleAt??position?.updateTime,0))),
    updateTime:Math.max(0,Math.floor(n(position?.updateTime,0))),
  };
}

function managedExitId(value){
  const id=String(value||'');
  return /^zth-EXI-[A-Za-z0-9._:-]+$/.test(id)&&id.length<=36;
}
function blockingStandardReduceOnlyLimit(order,live){
  if(String(order?.orderClass||'STANDARD').toUpperCase()!=='STANDARD')return false;
  if(String(order?.symbol||'').toUpperCase()!==live.symbol)return false;
  if(String(order?.positionSide||'BOTH').toUpperCase()!=='BOTH')return false;
  if(String(order?.side||'').toUpperCase()!==(live.direction==='LONG'?'SELL':'BUY'))return false;
  if(String(order?.type||'').toUpperCase()!=='LIMIT')return false;
  if(String(order?.timeInForce||'').toUpperCase()!=='GTC')return false;
  if(!bool(order?.reduceOnly))return false;
  return !managedExitId(order?.clientOrderId);
}

function sameProgressivePurpose(order,live){
  if(String(order?.orderClass||'').toUpperCase()!=='ALGO')return false;
  if(String(order?.symbol||'').toUpperCase()!==live.symbol)return false;
  if(String(order?.positionSide||'BOTH').toUpperCase()!=='BOTH')return false;
  if(String(order?.side||'').toUpperCase()!==(live.direction==='LONG'?'SELL':'BUY'))return false;
  if(String(order?.type||'').toUpperCase()!=='STOP')return false;
  if(!bool(order?.reduceOnly))return false;
  return true;
}

export function evaluateMasterAutoProgressiveProtection({
  position,
  markPrice,
  protectionStages,
  currentOrders=[],
  priceFilter,
  previousHighWaterProfitUsd=NaN,
}={}){
  const live=positionShape(position);
  const mark=n(markPrice);
  if(!(mark>0))throw new Error('MARK_PRICE_INVALID');

  const observedProfitUsd=pnlAtLinearPrice({
    entryPrice:live.entryPrice,
    quantity:live.quantity,
    direction:live.direction,
    price:mark,
  });
  const previous=n(previousHighWaterProfitUsd,NaN);
  const highWaterProfitUsd=Number.isFinite(previous)
    ?Math.max(previous,observedProfitUsd)
    :observedProfitUsd;

  const stage=highestReachedProtectionStage(protectionStages,highWaterProfitUsd);
  if(!stage){
    return {
      action:'NONE',
      reason:'NO_PROTECTION_STAGE_REACHED',
      observedProfitUsd,
      highWaterProfitUsd,
      live,
    };
  }

  const orders=Array.isArray(currentOrders)?currentOrders:[];
  const blockingLimits=orders.filter(order=>blockingStandardReduceOnlyLimit(order,live));
  if(blockingLimits.length){
    return {
      action:'BLOCK',
      reason:'STANDARD_REDUCE_ONLY_LIMIT_ALREADY_OPEN',
      observedProfitUsd,
      highWaterProfitUsd,
      stage,
      live,
    };
  }

  const progressive=orders.filter(order=>sameProgressivePurpose(order,live));
  if(progressive.length>1){
    return {
      action:'BLOCK',
      reason:'MULTIPLE_PROGRESSIVE_PROTECTIONS',
      observedProfitUsd,
      highWaterProfitUsd,
      stage,
      live,
    };
  }

  const current=progressive[0]||null;
  if(current&&!zenithId(current?.clientAlgoId)){
    return {
      action:'BLOCK',
      reason:'EXTERNAL_PROGRESSIVE_PROTECTION',
      observedProfitUsd,
      highWaterProfitUsd,
      stage,
      live,
    };
  }

  let currentProtectedProfitUsd=NaN;
  if(current){
    const currentPrice=n(current?.price);
    const currentTrigger=n(current?.triggerPrice??current?.stopPrice);
    const currentLimitShape=
      String(current?.timeInForce||'').toUpperCase()==='GTC' &&
      currentPrice>0 &&
      currentTrigger>0 &&
      Math.abs(currentPrice-currentTrigger)<=Math.max(1e-9,Math.abs(currentTrigger)*1e-10) &&
      (!current?.priceMatch||String(current?.priceMatch).toUpperCase()==='NONE');
    if(!currentLimitShape){
      return {
        action:'BLOCK',
        reason:'PROGRESSIVE_ORDER_NOT_EXACT_LIMIT',
        observedProfitUsd,
        highWaterProfitUsd,
        stage,
        live,
      };
    }
    const currentOrigQty=n(current?.origQty??current?.quantity);
    const currentExecutedQty=Math.max(0,n(current?.executedQty,0));
    const currentRemainingQty=currentOrigQty-currentExecutedQty;
    const quantityMatches=
      currentOrigQty>0 &&
      currentRemainingQty>0 &&
      Math.abs(currentRemainingQty-live.quantity)<=Math.max(1e-12,live.quantity*1e-10);
    currentProtectedProfitUsd=pnlAtLinearPrice({
      entryPrice:live.entryPrice,
      quantity:live.quantity,
      direction:live.direction,
      price:currentPrice,
    });
    if(quantityMatches&&currentProtectedProfitUsd+1e-8>=stage.protectedProfitUsd){
      return {
        action:'NONE',
        reason:'PROTECTION_ALREADY_AT_OR_ABOVE_STAGE',
        observedProfitUsd,
        highWaterProfitUsd,
        currentProtectedProfitUsd,
        stage,
        live,
      };
    }
  }

  const level=buildProgressiveProtectionLevel({
    position:{
      symbol:live.symbol,
      positionSide:'BOTH',
      positionAmt:String(live.positionAmt),
      entryPrice:String(live.entryPrice),
    },
    armProfitUsd:stage.armProfitUsd,
    protectedProfitUsd:stage.protectedProfitUsd,
    priceFilter,
  });

  return {
    action:'REPLACE',
    reason:current
      ?(
        !(n(current?.origQty??current?.quantity)>0) ||
        Math.abs(
          (n(current?.origQty??current?.quantity)-Math.max(0,n(current?.executedQty,0)))-live.quantity
        )>Math.max(1e-12,live.quantity*1e-10)
          ?'PROGRESSIVE_QUANTITY_REFRESH_REQUIRED'
          :'HIGHER_STAGE_REACHED'
      )
      :'FIRST_STAGE_REACHED',
    observedProfitUsd,
    highWaterProfitUsd,
    currentProtectedProfitUsd,
    stage,
    level,
    live,
    previousClientAlgoId:current?String(current.clientAlgoId||''):'',
  };
}
