import { BinanceRequestError, signedBinanceRequest } from './binance-order-writer.mjs';

const ALGO_PATH='/fapi/v1/algoOrder';
const TERMINAL_ALGO=new Set(['CANCELED','TRIGGERED','FINISHED','REJECTED','EXPIRED']);

function orderNotFound(error){
  return error instanceof BinanceRequestError && Number(error.code)===-2013;
}
function bool(v){return v===true||v==='true'}
function text(v){return String(v??'')}
function upper(v){return text(v).toUpperCase()}
function nearlyEqual(a,b){
  const x=Number(a),y=Number(b);
  if(!Number.isFinite(x)||!Number.isFinite(y))return false;
  return Math.abs(x-y)<=Math.max(1e-9,Math.abs(y)*1e-10);
}
function assertExistingMatches(existing,expected){
  const expectedType=upper(expected?.type);
  const actualType=upper(existing?.orderType||existing?.type);
  const fields=[
    [upper(existing?.symbol),upper(expected?.symbol),'ALGO_SYMBOL_MISMATCH'],
    [upper(existing?.side),upper(expected?.side),'ALGO_SIDE_MISMATCH'],
    [upper(existing?.positionSide||'BOTH'),upper(expected?.positionSide||'BOTH'),'ALGO_POSITION_SIDE_MISMATCH'],
    [actualType,expectedType,'ALGO_TYPE_MISMATCH'],
    [text(existing?.clientAlgoId),text(expected?.clientAlgoId),'ALGO_CLIENT_ID_MISMATCH'],
  ];
  for(const [a,b,code] of fields)if(a!==b)throw new BinanceRequestError(code,{data:{existing,expected},ambiguous:true});
  if(expected?.triggerPrice!==undefined&&!nearlyEqual(existing?.triggerPrice,expected.triggerPrice)){
    throw new BinanceRequestError('ALGO_TRIGGER_PRICE_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  if(expected?.closePosition!==undefined&&bool(existing?.closePosition)!==bool(expected.closePosition)){
    throw new BinanceRequestError('ALGO_CLOSE_POSITION_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  if(expected?.reduceOnly!==undefined&&bool(existing?.reduceOnly)!==bool(expected.reduceOnly)){
    throw new BinanceRequestError('ALGO_REDUCE_ONLY_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  if(expected?.quantity!==undefined&&!nearlyEqual(existing?.quantity,expected.quantity)){
    throw new BinanceRequestError('ALGO_QUANTITY_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  if(expected?.price!==undefined&&!nearlyEqual(existing?.price,expected.price)){
    throw new BinanceRequestError('ALGO_LIMIT_PRICE_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  if(expected?.priceMatch!==undefined&&upper(existing?.priceMatch||'NONE')!==upper(expected.priceMatch||'NONE')){
    throw new BinanceRequestError('ALGO_PRICE_MATCH_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  if(expected?.timeInForce!==undefined&&upper(existing?.timeInForce||'GTC')!==upper(expected.timeInForce||'GTC')){
    throw new BinanceRequestError('ALGO_TIME_IN_FORCE_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  if(expected?.workingType!==undefined&&upper(existing?.workingType||'CONTRACT_PRICE')!==upper(expected.workingType||'CONTRACT_PRICE')){
    throw new BinanceRequestError('ALGO_WORKING_TYPE_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  if(expected?.priceProtect!==undefined&&bool(existing?.priceProtect)!==bool(expected.priceProtect)){
    throw new BinanceRequestError('ALGO_PRICE_PROTECT_MISMATCH',{data:{existing,expected},ambiguous:true});
  }
  return existing;
}

export async function queryAlgoByClientId({
  fetchImpl=fetch,apiKey,secret,symbol,clientAlgoId,timestamp=Date.now()
}={}){
  return signedBinanceRequest({
    fetchImpl,path:ALGO_PATH,method:'GET',apiKey,secret,timestamp,
    params:{symbol:String(symbol||'').toUpperCase(),clientAlgoId:String(clientAlgoId||'')}
  });
}

export async function placeAlgoOrderIdempotent({
  fetchImpl=fetch,apiKey,secret,algoParams,writesEnabled=false,timestamp=Date.now()
}={}){
  const symbol=upper(algoParams?.symbol),clientAlgoId=text(algoParams?.clientAlgoId);
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!clientAlgoId||clientAlgoId.length>36){
    throw new Error('ALGO_IDEMPOTENCY_FIELDS_REQUIRED');
  }

  try{
    const existing=await queryAlgoByClientId({fetchImpl,apiKey,secret,symbol,clientAlgoId,timestamp});
    assertExistingMatches(existing,algoParams);
    return {ok:true,disposition:'EXISTING',writeAttempted:false,algoOrder:existing};
  }catch(error){
    if(!orderNotFound(error))throw error;
  }

  if(!writesEnabled){
    return {ok:false,disposition:'WRITE_LOCKED',writeAttempted:false,clientAlgoId};
  }

  try{
    const placed=await signedBinanceRequest({
      fetchImpl,path:ALGO_PATH,method:'POST',apiKey,secret,timestamp,
      params:{...algoParams,newOrderRespType:'ACK'}
    });
    if(text(placed?.clientAlgoId)!==clientAlgoId){
      throw new BinanceRequestError('BINANCE_CLIENT_ALGO_ID_MISMATCH',{data:placed,ambiguous:true});
    }
    assertExistingMatches(placed,algoParams);
    return {ok:true,disposition:'PLACED',writeAttempted:true,algoOrder:placed};
  }catch(error){
    if(!(error instanceof BinanceRequestError)||!error.ambiguous)throw error;
    try{
      const recovered=await queryAlgoByClientId({
        fetchImpl,apiKey,secret,symbol,clientAlgoId,timestamp:timestamp+1
      });
      assertExistingMatches(recovered,algoParams);
      return {ok:true,disposition:'RECOVERED_AFTER_AMBIGUOUS_POST',writeAttempted:true,algoOrder:recovered};
    }catch(queryError){
      if(!orderNotFound(queryError))throw queryError;
      throw new BinanceRequestError('ALGO_ORDER_RESULT_AMBIGUOUS',{
        data:{symbol,clientAlgoId,originalError:error.message},ambiguous:true
      });
    }
  }
}

export async function cancelAlgoOrderIdempotent({
  fetchImpl=fetch,apiKey,secret,symbol,clientAlgoId,
  expected={},writesEnabled=false,timestamp=Date.now()
}={}){
  const sym=upper(symbol),cid=text(clientAlgoId);
  if(!/^[A-Z0-9]{3,30}$/.test(sym)||!cid||cid.length>36)throw new Error('ALGO_CANCEL_FIELDS_INVALID');

  let existing;
  try{
    existing=await queryAlgoByClientId({fetchImpl,apiKey,secret,symbol:sym,clientAlgoId:cid,timestamp});
  }catch(error){
    if(orderNotFound(error)){
      throw new BinanceRequestError('ALGO_CANCEL_TARGET_UNKNOWN',{
        code:error.code,data:{symbol:sym,clientAlgoId:cid},ambiguous:true
      });
    }
    throw error;
  }
  assertExistingMatches(existing,{...expected,symbol:sym,clientAlgoId:cid});
  const status=upper(existing?.algoStatus||existing?.status);
  if(TERMINAL_ALGO.has(status)){
    return {ok:true,disposition:'ALREADY_TERMINAL',writeAttempted:false,algoOrder:existing};
  }
  if(!writesEnabled)return {ok:false,disposition:'WRITE_LOCKED',writeAttempted:false,algoOrder:existing};

  try{
    await signedBinanceRequest({
      fetchImpl,path:ALGO_PATH,method:'DELETE',apiKey,secret,timestamp,
      params:{symbol:sym,clientAlgoId:cid}
    });
  }catch(error){
    if(!(error instanceof BinanceRequestError))throw error;
    if(!error.ambiguous)throw error;
  }

  try{
    const after=await queryAlgoByClientId({
      fetchImpl,apiKey,secret,symbol:sym,clientAlgoId:cid,timestamp:timestamp+1
    });
    assertExistingMatches(after,{...expected,symbol:sym,clientAlgoId:cid});
    const afterStatus=upper(after?.algoStatus||after?.status);
    if(TERMINAL_ALGO.has(afterStatus)){
      return {ok:true,disposition:'CANCELED',writeAttempted:true,algoOrder:after};
    }
    throw new BinanceRequestError('ALGO_CANCEL_RESULT_AMBIGUOUS',{
      data:{symbol:sym,clientAlgoId:cid,status:afterStatus},ambiguous:true
    });
  }catch(queryError){
    if(queryError instanceof BinanceRequestError&&queryError.message==='ALGO_CANCEL_RESULT_AMBIGUOUS')throw queryError;
    if(orderNotFound(queryError)){
      throw new BinanceRequestError('ALGO_CANCEL_RESULT_AMBIGUOUS',{
        data:{symbol:sym,clientAlgoId:cid},ambiguous:true
      });
    }
    throw queryError;
  }
}
