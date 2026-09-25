function num(value,fallback=0){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function upper(value){return String(value??'').trim().toUpperCase()}

export function entryWatchDefinition(symbol,validated){
  const sym=upper(symbol);
  const buy=num(validated?.buy,0);
  const validatedAt=Math.max(0,Math.floor(num(validated?.validatedAt,0)));
  if(!/^[A-Z0-9]{3,30}$/.test(sym)||!(buy>0)||!(validatedAt>0))return null;
  return {symbol:sym,buy,validatedAt};
}

export function entryWatchIdentity(definition){
  if(!definition)return '';
  return `${definition.symbol}:${definition.validatedAt}:${definition.buy}`;
}

export function normalizeEntryWatchState(state,definition,{seedArmed=false}={}){
  const identity=entryWatchIdentity(definition);
  const same=state&&String(state.identity||'')===identity;
  if(!same){
    return {
      version:1,
      identity,
      symbol:definition.symbol,
      buy:definition.buy,
      validatedAt:definition.validatedAt,
      armedAbove:seedArmed===true,
      lastPrice:0,
      lastAggId:-1,
      lastAggTime:0,
      suppressedCrossingAt:0,
      pendingUntil:0,
      blockedAt:0,
      triggeredAt:0,
    };
  }
  return {
    version:1,
    identity,
    symbol:definition.symbol,
    buy:definition.buy,
    validatedAt:definition.validatedAt,
    armedAbove:state.armedAbove===true,
    lastPrice:num(state.lastPrice,0),
    lastAggId:Number.isFinite(Number(state.lastAggId))?Number(state.lastAggId):-1,
    lastAggTime:Math.max(0,Math.floor(num(state.lastAggTime,0))),
    suppressedCrossingAt:Math.max(0,Math.floor(num(state.suppressedCrossingAt,0))),
    pendingUntil:Math.max(0,Math.floor(num(state.pendingUntil,0))),
    blockedAt:Math.max(0,Math.floor(num(state.blockedAt,0))),
    triggeredAt:Math.max(0,Math.floor(num(state.triggeredAt,0))),
  };
}

export function evaluateEntryWatchTick({
  definition,
  state,
  price,
  eventId=-1,
  eventTime=Date.now(),
  allowTrigger=false,
  seedArmed=false,
}={}){
  if(!definition)throw new Error('ENTRY_WATCH_DEFINITION_REQUIRED');
  const px=num(price,0);
  if(!(px>0))throw new Error('ENTRY_WATCH_PRICE_INVALID');
  const id=Number.isFinite(Number(eventId))?Number(eventId):-1;
  const at=Math.max(definition.validatedAt,Math.floor(num(eventTime,Date.now())));
  const current=normalizeEntryWatchState(state,definition,{seedArmed});

  if(id>=0&&current.lastAggId>=0&&id<=current.lastAggId){
    return {action:'DUPLICATE',state:current};
  }

  const next={
    ...current,
    lastPrice:px,
    lastAggId:id>=0?id:current.lastAggId,
    lastAggTime:id>=0?at:current.lastAggTime,
  };
  if(next.triggeredAt>0)return {action:'ALREADY_TRIGGERED',state:next};
  if(next.blockedAt>0)return {action:'BLOCKED',state:next};

  if(next.pendingUntil>0){
    if(at>=next.pendingUntil){
      next.pendingUntil=0;
      next.blockedAt=at;
      return {action:'EXPIRED',state:next};
    }
    if(allowTrigger===true){
      next.pendingUntil=0;
      next.triggeredAt=at;
      return {
        action:'TRIGGER',
        state:next,
        signal:{
          symbol:definition.symbol,
          buy:definition.buy,
          limitPrice:px,
          delayedCurrentPrice:true,
          validatedAt:definition.validatedAt,
          eventId:id,
          eventTime:at,
          observedPrice:px,
        },
      };
    }
    return {action:'PENDING',state:next};
  }

  if(px>definition.buy){
    const changed=next.armedAbove!==true;
    next.armedAbove=true;
    return {action:changed?'ARMED':'TRACKING',state:next};
  }

  if(next.armedAbove===true){
    next.armedAbove=false;
    if(allowTrigger===true){
      next.triggeredAt=at;
      return {
        action:'TRIGGER',
        state:next,
        signal:{
          symbol:definition.symbol,
          buy:definition.buy,
          limitPrice:definition.buy,
          delayedCurrentPrice:false,
          validatedAt:definition.validatedAt,
          eventId:id,
          eventTime:at,
          observedPrice:px,
        },
      };
    }
    next.suppressedCrossingAt=at;
    next.pendingUntil=at+50000;
    return {action:'PENDING',state:next};
  }

  return {action:'TRACKING',state:next};
}

export function pruneEntryWatchStates(states,definitions){
  const defs=new Map(
    (Array.isArray(definitions)?definitions:[])
      .filter(Boolean)
      .map(def=>[def.symbol,entryWatchIdentity(def)])
  );
  const out={};
  for(const [symbol,state] of Object.entries(states&&typeof states==='object'?states:{})){
    const wanted=defs.get(upper(symbol));
    if(wanted&&String(state?.identity||'')===wanted)out[upper(symbol)]=state;
  }
  return out;
}
