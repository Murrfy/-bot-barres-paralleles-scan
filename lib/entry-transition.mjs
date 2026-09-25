import { REAL_RISK_LIMITS } from './risk-policy.mjs';

export const ENTRY_TRANSITION_MAX_LIFETIME_MS=120000;

function n(value,fallback=NaN){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function upper(value){return String(value??'').toUpperCase()}
function bool(value){return value===true||value==='true'}
function near(a,b){
  const x=n(a),y=n(b);
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=Math.max(1e-9,Math.abs(y)*1e-10);
}
function validId(value,prefix='zth-'){
  const id=String(value||'');
  return id.startsWith(prefix)&&/^zth-[A-Za-z0-9._:-]+$/.test(id)&&id.length<=36;
}
function positionDirection(position){
  const side=upper(position?.positionSide||'BOTH');
  if(side==='LONG'||side==='SHORT')return side;
  return n(position?.positionAmt??position?.quantity,0)<0?'SHORT':'LONG';
}
function orderIdentity(order){
  const symbol=upper(order?.symbol);
  if(String(order?.clientAlgoId||''))return symbol+':algo-client:'+String(order.clientAlgoId);
  if(String(order?.algoId||''))return symbol+':algo:'+String(order.algoId);
  if(String(order?.clientOrderId||''))return symbol+':client:'+String(order.clientOrderId);
  if(String(order?.orderId||''))return symbol+':id:'+String(order.orderId);
  return '';
}

export function normalizeEntryTransition(value,{now=Date.now()}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,reason:'ENTRY_TRANSITION_OBJECT_REQUIRED'};
  const version=n(value.version,0);
  const state=upper(value.state);
  const commandId=String(value.commandId||'');
  const symbol=upper(value.symbol);
  const side=upper(value.side);
  const direction=upper(value.direction);
  const quantity=n(value.quantity);
  const limitPrice=n(value.limitPrice);
  const maxLossUsd=n(value.maxLossUsd);
  const protectionTriggerPrice=n(value.protectionTriggerPrice);
  const protectionClientAlgoId=String(value.protectionClientAlgoId||'');
  const entryClientOrderId=String(value.entryClientOrderId||'');
  const createdAt=n(value.createdAt);
  const expiresAt=n(value.expiresAt);
  const validatedAt=n(value.validatedAt);
  const controllerRevision=n(value.controllerRevision);
  const masterDeviceId=String(value.masterDeviceId||'');
  const masterRoleEpoch=String(value.masterRoleEpoch||'');
  const engineInstanceId=String(value.engineInstanceId||'');

  if(version!==1)return {ok:false,reason:'ENTRY_TRANSITION_VERSION_INVALID'};
  if(!['PROTECTION_PREPARED','ENTRY_SUBMITTED'].includes(state))return {ok:false,reason:'ENTRY_TRANSITION_STATE_INVALID'};
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(commandId))return {ok:false,reason:'ENTRY_TRANSITION_COMMAND_ID_INVALID'};
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))return {ok:false,reason:'ENTRY_TRANSITION_SYMBOL_INVALID'};
  if(!['BUY','SELL'].includes(side))return {ok:false,reason:'ENTRY_TRANSITION_SIDE_INVALID'};
  if(!['LONG','SHORT'].includes(direction))return {ok:false,reason:'ENTRY_TRANSITION_DIRECTION_INVALID'};
  if((side==='BUY'?'LONG':'SHORT')!==direction)return {ok:false,reason:'ENTRY_TRANSITION_SIDE_DIRECTION_MISMATCH'};
  if(!(quantity>0)||!(limitPrice>0))return {ok:false,reason:'ENTRY_TRANSITION_SIZE_INVALID'};
  if(!(maxLossUsd>=2&&maxLossUsd<=REAL_RISK_LIMITS.maxLossUsd))return {ok:false,reason:'ENTRY_TRANSITION_MAX_LOSS_INVALID'};
  if(!(protectionTriggerPrice>0))return {ok:false,reason:'ENTRY_TRANSITION_TRIGGER_INVALID'};
  if(direction==='LONG'&&!(protectionTriggerPrice<limitPrice))return {ok:false,reason:'ENTRY_TRANSITION_TRIGGER_SIDE_INVALID'};
  if(direction==='SHORT'&&!(protectionTriggerPrice>limitPrice))return {ok:false,reason:'ENTRY_TRANSITION_TRIGGER_SIDE_INVALID'};
  const impliedLossUsd=Math.abs(limitPrice-protectionTriggerPrice)*quantity;
  if(impliedLossUsd>maxLossUsd+1e-8||impliedLossUsd>REAL_RISK_LIMITS.maxLossUsd+1e-8){
    return {ok:false,reason:'ENTRY_TRANSITION_PROTECTION_CAP_EXCEEDED'};
  }
  if(!validId(protectionClientAlgoId,'zth-MAX-'))return {ok:false,reason:'ENTRY_TRANSITION_MAXLOSS_ID_INVALID'};
  if(state==='ENTRY_SUBMITTED'&&!validId(entryClientOrderId,'zth-')){
    return {ok:false,reason:'ENTRY_TRANSITION_ENTRY_ID_INVALID'};
  }
  if(!(createdAt>0)||!(expiresAt>createdAt)||expiresAt-createdAt>ENTRY_TRANSITION_MAX_LIFETIME_MS){
    return {ok:false,reason:'ENTRY_TRANSITION_LIFETIME_INVALID'};
  }
  if(createdAt>now+5000)return {ok:false,reason:'ENTRY_TRANSITION_FROM_FUTURE'};
  if(expiresAt<=now)return {ok:false,reason:'ENTRY_TRANSITION_EXPIRED',expired:true};
  if(!(validatedAt>0)||!(controllerRevision>0)||!masterDeviceId||!masterRoleEpoch||!engineInstanceId){
    return {ok:false,reason:'ENTRY_TRANSITION_AUTHORITY_INVALID'};
  }

  return {ok:true,transition:{
    version:1,state,commandId,symbol,side,direction,quantity,limitPrice,maxLossUsd,
    protectionTriggerPrice,protectionClientAlgoId,entryClientOrderId,
    createdAt,expiresAt,validatedAt,controllerRevision,masterDeviceId,masterRoleEpoch,engineInstanceId,
    impliedLossUsd,
  }};
}

export function transitionProtectionMatches(order,transition){
  if(!order||!transition)return false;
  const expectedSide=transition.direction==='LONG'?'SELL':'BUY';
  return upper(order.orderClass)==='ALGO'&&
    upper(order.symbol)===transition.symbol&&
    upper(order.side)===expectedSide&&
    upper(order.positionSide||'BOTH')==='BOTH'&&
    upper(order.type)==='STOP_MARKET'&&
    bool(order.closePosition)&&
    !bool(order.reduceOnly)&&
    String(order.clientAlgoId||'')===transition.protectionClientAlgoId&&
    near(order.triggerPrice??order.stopPrice,transition.protectionTriggerPrice);
}

export function transitionEntryMatches(order,transition){
  if(!order||!transition||transition.state!=='ENTRY_SUBMITTED')return false;
  return upper(order.orderClass||'STANDARD')==='STANDARD'&&
    upper(order.symbol)===transition.symbol&&
    upper(order.side)===transition.side&&
    upper(order.positionSide||'BOTH')==='BOTH'&&
    upper(order.type)==='LIMIT'&&
    upper(order.timeInForce)==='GTC'&&
    !bool(order.reduceOnly)&&
    String(order.clientOrderId||'')===transition.entryClientOrderId&&
    near(order.origQty??order.quantity,transition.quantity)&&
    near(order.price,transition.limitPrice);
}

export function evaluateEntryTransitionReconciliation({
  transitions=[],
  actualOrders=[],
  actualPositions=[],
  now=Date.now(),
}={}){
  const active=[];
  const invalid=[];
  const expired=[];
  for(const row of Array.isArray(transitions)?transitions:[]){
    const normalized=normalizeEntryTransition(row,{now});
    if(normalized.ok)active.push(normalized.transition);
    else if(normalized.expired)expired.push({record:row,reason:normalized.reason});
    else invalid.push({record:row,reason:normalized.reason});
  }

  const allowedOrderIdentities=new Set();
  const missingProtections=[];
  const missingEntries=[];

  for(const transition of active){
    const protection=(Array.isArray(actualOrders)?actualOrders:[])
      .find(order=>transitionProtectionMatches(order,transition));
    if(protection){
      const id=orderIdentity(protection);if(id)allowedOrderIdentities.add(id);
    }else{
      missingProtections.push(transition.symbol+':'+transition.direction);
    }

    if(transition.state==='ENTRY_SUBMITTED'){
      const live=(Array.isArray(actualPositions)?actualPositions:[]).some(position=>
        upper(position?.symbol)===transition.symbol&&
        Math.abs(n(position?.positionAmt??position?.quantity,0))>0&&
        positionDirection(position)===transition.direction
      );
      if(!live){
        const entry=(Array.isArray(actualOrders)?actualOrders:[])
          .find(order=>transitionEntryMatches(order,transition));
        if(entry){
          const id=orderIdentity(entry);if(id)allowedOrderIdentities.add(id);
        }else{
          missingEntries.push(transition.symbol+':'+transition.direction);
        }
      }
    }
  }

  return {
    active,
    invalid,
    expired,
    allowedOrderIdentities,
    missingProtections:[...new Set(missingProtections)],
    missingEntries:[...new Set(missingEntries)],
  };
}

export function entryTransitionOrderIdentity(order){return orderIdentity(order)}
