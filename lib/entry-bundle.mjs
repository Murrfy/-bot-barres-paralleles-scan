import { buildEntryOrderPlan } from './order-intent.mjs';
import { buildRealProtectionLevels } from './real-protection-levels.mjs';
import { buildProtectiveAlgoPlan } from './protective-update-intent.mjs';
import { ENTRY_TRANSITION_MAX_LIFETIME_MS, normalizeEntryTransition } from './entry-transition.mjs';

function n(value,fallback=NaN){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}

export function buildPreparedEntryBundle({
  command,
  riskSnapshot,
  validatedAt,
  controllerRevision,
  masterDeviceId,
  masterRoleEpoch,
  engineInstanceId,
  now=Date.now(),
}={}){
  const side=String(command?.side||'').toUpperCase();
  if(!['BUY','SELL'].includes(side))throw new Error('SIDE_INVALID');
  const entryPlan=buildEntryOrderPlan({command,riskSnapshot,now});
  const normalized=riskSnapshot?.normalized||{};
  const quantity=n(entryPlan?.params?.quantity);
  const limitPrice=n(command?.limitPrice);
  const maxLoss=n(command?.maxLoss);
  if(!(quantity>0)||!(limitPrice>0)||!(maxLoss>0))throw new Error('ENTRY_BUNDLE_SIZE_INVALID');

  const priceFilter={
    filterType:'PRICE_FILTER',
    tickSize:String(normalized.priceTickSize??''),
    minPrice:String(normalized.minPrice??''),
    maxPrice:String(normalized.maxPrice??''),
  };
  if(!(n(priceFilter.tickSize)>0))throw new Error('ENTRY_BUNDLE_PRICE_FILTER_MISSING');

  const direction=side==='BUY'?'LONG':'SHORT';
  const signedQuantity=direction==='LONG'?quantity:-quantity;
  const protectionLevels=buildRealProtectionLevels({
    position:{
      symbol:String(command?.symbol||'').toUpperCase(),
      positionSide:'BOTH',
      positionAmt:String(signedQuantity),
      entryPrice:String(limitPrice),
    },
    targetProfitUsd:Math.max(1,n(command?.targetProfit,1)),
    maxLossUsd:maxLoss,
    priceFilter,
  });
  if(protectionLevels.direction!==direction)throw new Error('ENTRY_BUNDLE_DIRECTION_MISMATCH');

  const protectionPlan=buildProtectiveAlgoPlan({
    commandId:String(command?.id||''),
    symbol:String(command?.symbol||'').toUpperCase(),
    direction,
    quantity,
    triggerPrice:protectionLevels.maxLossTriggerPrice,
    protectionKind:'MAX_LOSS',
    attempt:0,
  });

  const transition={
    version:1,
    state:'PROTECTION_PREPARED',
    commandId:String(command?.id||''),
    symbol:String(command?.symbol||'').toUpperCase(),
    side,
    direction,
    quantity,
    limitPrice,
    maxLossUsd:maxLoss,
    protectionTriggerPrice:protectionLevels.maxLossTriggerPrice,
    protectionClientAlgoId:String(protectionPlan?.params?.clientAlgoId||''),
    entryClientOrderId:'',
    createdAt:now,
    expiresAt:now+ENTRY_TRANSITION_MAX_LIFETIME_MS,
    validatedAt:Number(validatedAt),
    controllerRevision:Number(controllerRevision),
    masterDeviceId:String(masterDeviceId||''),
    masterRoleEpoch:String(masterRoleEpoch||''),
    engineInstanceId:String(engineInstanceId||''),
  };
  const checked=normalizeEntryTransition(transition,{now});
  if(!checked.ok)throw new Error(checked.reason||'ENTRY_TRANSITION_INVALID');

  return {
    version:1,
    entryPlan,
    protectionPlan,
    protectionLevels,
    transition:checked.transition,
  };
}
