import { buildEmergencyMaxLossLevel } from './real-protection-levels.mjs';
import { buildProtectiveAlgoPlan } from './protective-update-intent.mjs';

function n(value,fallback=NaN){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
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

export function buildEntryProtectionPlan({
  commandId,
  symbol,
  side,
  quantity,
  limitPrice,
  maxLoss,
  priceFilter,
}={}){
  const id=commandText(commandId);
  const sym=symbolText(symbol);
  const entrySide=String(side||'').toUpperCase();
  if(!['BUY','SELL'].includes(entrySide))throw new Error('SIDE_INVALID');
  const qty=n(quantity);
  const entry=n(limitPrice);
  const loss=n(maxLoss);
  if(!(qty>0))throw new Error('QUANTITY_INVALID');
  if(!(entry>0))throw new Error('LIMIT_PRICE_INVALID');
  if(!(loss>0))throw new Error('MAX_LOSS_INVALID');

  const direction=entrySide==='BUY'?'LONG':'SHORT';
  const position={
    symbol:sym,
    positionSide:'BOTH',
    positionAmt:direction==='LONG'?qty:-qty,
    entryPrice:entry,
  };
  const level=buildEmergencyMaxLossLevel({
    position,
    maxLossUsd:loss,
    priceFilter,
  });
  const algoPlan=buildProtectiveAlgoPlan({
    commandId:id,
    symbol:sym,
    direction,
    quantity:qty,
    triggerPrice:level.triggerPrice,
    protectionKind:'MAX_LOSS',
  });

  return {
    version:1,
    commandId:id,
    symbol:sym,
    side:entrySide,
    direction,
    quantity:qty,
    limitPrice:entry,
    maxLossUsd:loss,
    triggerPrice:level.triggerPrice,
    actualMaxLossUsd:level.actualMaxLossUsd,
    algoPlan,
  };
}
