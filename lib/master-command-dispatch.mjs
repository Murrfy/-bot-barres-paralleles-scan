function text(value){return String(value??'').trim()}
function finite(value){const n=Number(value);return Number.isFinite(n)?n:NaN}

export function buildMasterCommandDispatch(command){
  const type=text(command?.type).toUpperCase();
  const commandId=text(command?.id);
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(commandId))return{supported:false,reason:'COMMAND_ID_INVALID'};
  if(type!=='EXEC_CLOSE_POSITION')return{supported:false,reason:'COMMAND_TYPE_NOT_IMPLEMENTED'};

  const payload=command?.payload&&typeof command.payload==='object'?command.payload:{};
  const symbol=text(payload.symbol).toUpperCase();
  const direction=text(payload.direction).toUpperCase();
  const quantity=finite(payload.quantity);
  const exitMode=text(payload.exitMode||'PROTECTIVE_IOC').toUpperCase();
  const targetPrice=finite(payload.targetPrice);
  const attempt=Math.max(0,Math.min(20,Math.floor(finite(payload.attempt)||0)));

  if(!/^[A-Z0-9]{3,30}$/.test(symbol))return{supported:false,reason:'SYMBOL_INVALID'};
  if(!['LONG','SHORT'].includes(direction))return{supported:false,reason:'DIRECTION_INVALID'};
  if(!(quantity>0))return{supported:false,reason:'QUANTITY_INVALID'};
  if(!['PROTECTIVE_IOC','NORMAL_LIMIT','MARKET_LAST_RESORT'].includes(exitMode))return{supported:false,reason:'EXIT_MODE_INVALID'};
  if(exitMode==='NORMAL_LIMIT'&&!(targetPrice>0))return{supported:false,reason:'TARGET_PRICE_REQUIRED'};

  return{
    supported:true,
    endpoint:'/api/binance-protective-execute',
    body:{
      type,
      commandId,
      symbol,
      direction,
      quantity,
      exitMode,
      ...(targetPrice>0?{targetPrice}:{}),
      attempt,
    },
  };
}

export function masterCommandRetryDelay(value,fallback=900){
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0)return fallback;
  return Math.max(250,Math.min(5000,Math.round(n)));
}
