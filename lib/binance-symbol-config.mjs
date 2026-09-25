import { BinanceRequestError, signedBinanceRequest } from './binance-order-writer.mjs';

function num(value,fallback=0){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}
function upper(value){return String(value??'').toUpperCase()}
function firstForSymbol(value,symbol){
  const rows=Array.isArray(value)?value:value?[value]:[];
  return rows.find(x=>upper(x?.symbol)===symbol)||null;
}
function configFailure(code,{cause=null,writeAttempted=false,ambiguous=false}={}){
  const e=new Error(code);
  e.code=code;
  e.writeAttempted=writeAttempted===true;
  e.ambiguous=ambiguous===true;
  if(cause?.status)e.status=cause.status;
  if(cause?.retryAfterSeconds)e.retryAfterSeconds=cause.retryAfterSeconds;
  if(cause?.code!==undefined&&cause?.code!==null)e.binanceCode=cause.code;
  return e;
}
function requestTimestamp(base,offset){return Math.max(1,Math.floor(num(base,Date.now())))+offset}

async function readSymbolConfig({requestImpl,apiKey,secret,symbol,timestamp,offset}){
  const raw=await requestImpl({
    path:'/fapi/v1/symbolConfig',
    method:'GET',
    apiKey,secret,
    timestamp:requestTimestamp(timestamp,offset),
    params:{symbol},
  });
  const config=firstForSymbol(raw,symbol);
  if(!config)throw configFailure('BINANCE_SYMBOL_CONFIG_MISSING');
  return config;
}

export function entrySymbolConfigMatches(config,{symbol,leverage}={}){
  const wanted=upper(symbol);
  return Boolean(
    config&&upper(config.symbol)===wanted&&
    upper(config.marginType)==='ISOLATED'&&
    num(config.leverage)===num(leverage)
  );
}

export async function ensureBinanceEntrySymbolConfig({
  apiKey,
  secret,
  symbol,
  leverage,
  timestamp=Date.now(),
  requestImpl=signedBinanceRequest,
}={}){
  const wanted=upper(symbol);
  const wantedLeverage=Math.round(num(leverage,0));
  if(!/^[A-Z0-9]{3,30}$/.test(wanted)||wantedLeverage<1||wantedLeverage>10){
    throw configFailure('BINANCE_SYMBOL_CONFIG_REQUEST_INVALID');
  }

  let offset=0;
  let current=await readSymbolConfig({
    requestImpl,apiKey,secret,symbol:wanted,timestamp,offset:offset++
  });
  const before={
    marginType:upper(current.marginType),
    leverage:num(current.leverage),
  };
  let marginTypeChanged=false,leverageChanged=false,recoveredAfterAmbiguous=false;

  if(upper(current.marginType)!=='ISOLATED'){
    let writeError=null;
    try{
      await requestImpl({
        path:'/fapi/v1/marginType',
        method:'POST',
        apiKey,secret,
        timestamp:requestTimestamp(timestamp,offset++),
        params:{symbol:wanted,marginType:'ISOLATED'},
      });
    }catch(e){
      writeError=e;
      if(!(e instanceof BinanceRequestError)&&e?.ambiguous!==true){
        throw configFailure('BINANCE_MARGIN_TYPE_WRITE_FAILED',{cause:e,writeAttempted:true});
      }
      if(e instanceof BinanceRequestError&&Number(e.code)===-4046){
        // Binance can report "No need to change margin type"; verify below.
      }else if(e?.ambiguous!==true){
        throw configFailure('BINANCE_MARGIN_TYPE_WRITE_FAILED',{cause:e,writeAttempted:true});
      }
    }
    current=await readSymbolConfig({
      requestImpl,apiKey,secret,symbol:wanted,timestamp,offset:offset++
    });
    if(upper(current.marginType)!=='ISOLATED'){
      throw configFailure(
        writeError?.ambiguous===true?'BINANCE_MARGIN_TYPE_RESULT_AMBIGUOUS':'BINANCE_MARGIN_TYPE_NOT_APPLIED',
        {cause:writeError,writeAttempted:true,ambiguous:writeError?.ambiguous===true}
      );
    }
    marginTypeChanged=true;
    if(writeError?.ambiguous===true)recoveredAfterAmbiguous=true;
  }

  if(num(current.leverage)!==wantedLeverage){
    let writeError=null;
    try{
      await requestImpl({
        path:'/fapi/v1/leverage',
        method:'POST',
        apiKey,secret,
        timestamp:requestTimestamp(timestamp,offset++),
        params:{symbol:wanted,leverage:wantedLeverage},
      });
    }catch(e){
      writeError=e;
      if(e?.ambiguous!==true){
        throw configFailure('BINANCE_LEVERAGE_WRITE_FAILED',{cause:e,writeAttempted:true});
      }
    }
    current=await readSymbolConfig({
      requestImpl,apiKey,secret,symbol:wanted,timestamp,offset:offset++
    });
    if(num(current.leverage)!==wantedLeverage){
      throw configFailure(
        writeError?.ambiguous===true?'BINANCE_LEVERAGE_RESULT_AMBIGUOUS':'BINANCE_LEVERAGE_NOT_APPLIED',
        {cause:writeError,writeAttempted:true,ambiguous:writeError?.ambiguous===true}
      );
    }
    leverageChanged=true;
    if(writeError?.ambiguous===true)recoveredAfterAmbiguous=true;
  }

  if(!entrySymbolConfigMatches(current,{symbol:wanted,leverage:wantedLeverage})){
    throw configFailure('BINANCE_SYMBOL_CONFIG_VERIFY_FAILED',{
      writeAttempted:marginTypeChanged||leverageChanged
    });
  }

  return {
    ok:true,
    symbol:wanted,
    requested:{marginType:'ISOLATED',leverage:wantedLeverage},
    before,
    after:{marginType:upper(current.marginType),leverage:num(current.leverage)},
    marginTypeChanged,
    leverageChanged,
    recoveredAfterAmbiguous,
    writeAttempted:marginTypeChanged||leverageChanged,
  };
}
