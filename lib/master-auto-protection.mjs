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
function highestExecutableReachedStage(stages,reachedProfitUsd,observedProfitUsd){
  const reached=n(reachedProfitUsd);
  const observed=n(observedProfitUsd);
  if(!Number.isFinite(reached)||!Number.isFinite(observed))return null;
  const rows=Array.isArray(stages)?stages:[];
  let best=null;
  for(let i=0;i<rows.length;i++){
    const row=rows[i]||{};
    if(row.enabled===false)continue;
    const armProfitUsd=n(row.arm);
    const protectedProfitUsd=n(row.floor);
    if(!(armProfitUsd>=0)||!(protectedProfitUsd>=0)||!(protectedProfitUsd<armProfitUsd))continue;
    if(reached+1e-8<armProfitUsd)continue;
    if(!(observed>protectedProfitUsd+1e-8))continue;
    if(!best||
       armProfitUsd>best.armProfitUsd||
       (armProfitUsd===best.armProfitUsd&&protectedProfitUsd>best.protectedProfitUsd)){
      best={index:i,armProfitUsd,protectedProfitUsd};
    }
  }
  return best;
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
  const id=String(order?.clientAlgoId||'');
  const managedMaxLoss=
    /^zth-MAX-[A-Za-z0-9._:-]+$/.test(id) &&
    String(order?.timeInForce||'').toUpperCase()==='IOC' &&
    !bool(order?.closePosition) &&
    String(order?.priceMatch||'').toUpperCase()==='OPPONENT';
  if(managedMaxLoss)return false;
  return true;
}

export function evaluateMasterAutoProgressiveProtection({
  position,
  markPrice,
  protectionStages,
  currentOrders=[],
  priceFilter,
  previousHighWaterProfitUsd=NaN,
  redBlockedHighWaterProfitUsd=NaN,
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

  const highestStage=highestReachedProtectionStage(protectionStages,highWaterProfitUsd);
  if(!highestStage){
    return {
      action:'NONE',
      reason:'NO_PROTECTION_STAGE_REACHED',
      observedProfitUsd,
      highWaterProfitUsd,
      live,
    };
  }

  const redBlockedHighWater=n(redBlockedHighWaterProfitUsd,NaN);
  const redBlockedStage=Number.isFinite(redBlockedHighWater)
    ?highestReachedProtectionStage(protectionStages,redBlockedHighWater)
    :null;
  const redRecoveryActive=Boolean(redBlockedStage);
  let stage=highestStage;

  if(redRecoveryActive){
    stage=highestExecutableReachedStage(
      protectionStages,
      highWaterProfitUsd,
      observedProfitUsd
    );
    if(!stage){
      return {
        action:'NONE',
        reason:'RED_MAX_LOSS_REACHED_STAGE_NOT_CURRENTLY_EXECUTABLE',
        observedProfitUsd,
        highWaterProfitUsd,
        redBlockedHighWaterProfitUsd:redBlockedHighWater,
        redBlockedStage,
        redRecoveryActive:true,
        redRecoverySatisfied:false,
        live,
      };
    }
  }

  const redRecoverySatisfiedByStage=Boolean(
    redBlockedStage&&stage.protectedProfitUsd+1e-8>=redBlockedStage.protectedProfitUsd
  );

  const orders=Array.isArray(currentOrders)?currentOrders:[];
  const blockingLimits=orders.filter(order=>blockingStandardReduceOnlyLimit(order,live));
  if(blockingLimits.length){
    return {
      action:'BLOCK',
      reason:'STANDARD_REDUCE_ONLY_LIMIT_ALREADY_OPEN',
      observedProfitUsd,
      highWaterProfitUsd,
      stage,
      redRecoveryActive,
      redRecoverySatisfied:redRecoverySatisfiedByStage,
      redBlockedHighWaterProfitUsd:Number.isFinite(redBlockedHighWater)?redBlockedHighWater:NaN,
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
      redRecoveryActive,
      redRecoverySatisfied:redRecoverySatisfiedByStage,
      redBlockedHighWaterProfitUsd:Number.isFinite(redBlockedHighWater)?redBlockedHighWater:NaN,
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
      redRecoveryActive,
      redRecoverySatisfied:redRecoverySatisfiedByStage,
      redBlockedHighWaterProfitUsd:Number.isFinite(redBlockedHighWater)?redBlockedHighWater:NaN,
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
        redRecoveryActive,
        redRecoverySatisfied:redRecoverySatisfiedByStage,
        redBlockedHighWaterProfitUsd:Number.isFinite(redBlockedHighWater)?redBlockedHighWater:NaN,
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
        redRecoveryActive,
        redRecoverySatisfied:Boolean(
          redBlockedStage&&currentProtectedProfitUsd+1e-8>=redBlockedStage.protectedProfitUsd
        ),
        redBlockedHighWaterProfitUsd:Number.isFinite(redBlockedHighWater)?redBlockedHighWater:NaN,
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
    redRecoveryActive,
    redRecoverySatisfied:redRecoverySatisfiedByStage,
    redBlockedHighWaterProfitUsd:Number.isFinite(redBlockedHighWater)?redBlockedHighWater:NaN,
    live,
    previousClientAlgoId:current?String(current.clientAlgoId||''):'',
  };
}
