import { BinanceRequestError, signedBinanceRequest } from './binance-order-writer.mjs';

const TERMINAL_ALGO = new Set(['CANCELED','TRIGGERED','FINISHED','REJECTED','EXPIRED']);

function terminal(status) {
  return TERMINAL_ALGO.has(String(status || '').toUpperCase());
}

function notFound(error) {
  return error instanceof BinanceRequestError && Number(error.code) === -2013;
}

function validateClientAlgoId(value) {
  const id = String(value || '');
  if (!/^[.A-Z:/a-z0-9_-]{1,36}$/.test(id)) throw new Error('CLIENT_ALGO_ID_INVALID');
  return id;
}

export async function queryAlgoByClientId({
  fetchImpl = fetch,
  apiKey,
  secret,
  clientAlgoId,
  timestamp = Date.now(),
}) {
  const cid = validateClientAlgoId(clientAlgoId);
  return signedBinanceRequest({
    fetchImpl,
    path:'/fapi/v1/algoOrder',
    method:'GET',
    apiKey,
    secret,
    timestamp,
    params:{clientAlgoId:cid},
  });
}

export function algoOrderTerminal(status) {
  return terminal(status);
}

export async function placeAlgoOrderIdempotent({
  fetchImpl = fetch,
  apiKey,
  secret,
  algoParams,
  writesEnabled = false,
  timestamp = Date.now(),
}) {
  const clientAlgoId = validateClientAlgoId(algoParams?.clientAlgoId);
  try {
    const existing = await queryAlgoByClientId({
      fetchImpl,apiKey,secret,clientAlgoId,timestamp,
    });
    return {
      ok:true,
      disposition:'EXISTING',
      writeAttempted:false,
      order:existing,
    };
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  if (!writesEnabled) {
    return {
      ok:false,
      disposition:'WRITE_LOCKED',
      writeAttempted:false,
      clientAlgoId,
    };
  }

  try {
    const placed = await signedBinanceRequest({
      fetchImpl,
      path:'/fapi/v1/algoOrder',
      method:'POST',
      apiKey,
      secret,
      timestamp,
      params:{...algoParams,newOrderRespType:'ACK'},
    });
    if (String(placed?.clientAlgoId || '') !== clientAlgoId) {
      throw new BinanceRequestError('BINANCE_CLIENT_ALGO_ID_MISMATCH',{
        data:placed,ambiguous:true,
      });
    }
    return {
      ok:true,
      disposition:'PLACED',
      writeAttempted:true,
      order:placed,
    };
  } catch (error) {
    if (!(error instanceof BinanceRequestError) || !error.ambiguous) throw error;
    try {
      const recovered = await queryAlgoByClientId({
        fetchImpl,apiKey,secret,clientAlgoId,timestamp:timestamp+1,
      });
      return {
        ok:true,
        disposition:'RECOVERED_AFTER_AMBIGUOUS_POST',
        writeAttempted:true,
        order:recovered,
      };
    } catch (queryError) {
      if (!notFound(queryError)) throw queryError;
      throw new BinanceRequestError('ALGO_ORDER_RESULT_AMBIGUOUS',{
        data:{clientAlgoId,originalError:error.message},
        ambiguous:true,
      });
    }
  }
}

export async function cancelAlgoOrderIdempotent({
  fetchImpl = fetch,
  apiKey,
  secret,
  clientAlgoId,
  writesEnabled = false,
  timestamp = Date.now(),
}) {
  const cid = validateClientAlgoId(clientAlgoId);
  let existing;
  try {
    existing = await queryAlgoByClientId({
      fetchImpl,apiKey,secret,clientAlgoId:cid,timestamp,
    });
  } catch (error) {
    if (notFound(error)) {
      throw new BinanceRequestError('ALGO_CANCEL_TARGET_UNKNOWN',{
        code:error.code,data:{clientAlgoId:cid},ambiguous:true,
      });
    }
    throw error;
  }

  const status=String(existing?.algoStatus || existing?.status || '').toUpperCase();
  if (terminal(status)) {
    return {
      ok:true,
      disposition:status==='TRIGGERED'?'ALREADY_TRIGGERED':'ALREADY_TERMINAL',
      writeAttempted:false,
      reconciliationRequired:true,
      order:existing,
    };
  }

  if (!writesEnabled) {
    return {
      ok:false,
      disposition:'WRITE_LOCKED',
      writeAttempted:false,
      order:existing,
    };
  }

  try {
    const canceled=await signedBinanceRequest({
      fetchImpl,
      path:'/fapi/v1/algoOrder',
      method:'DELETE',
      apiKey,
      secret,
      timestamp,
      params:{clientAlgoId:cid},
    });
    return {
      ok:true,
      disposition:'CANCEL_SENT',
      writeAttempted:true,
      reconciliationRequired:true,
      order:canceled,
    };
  } catch (error) {
    if (!(error instanceof BinanceRequestError)) throw error;
    try {
      const after=await queryAlgoByClientId({
        fetchImpl,apiKey,secret,clientAlgoId:cid,timestamp:timestamp+1,
      });
      const afterStatus=String(after?.algoStatus || after?.status || '').toUpperCase();
      if (terminal(afterStatus)) {
        return {
          ok:true,
          disposition:afterStatus==='TRIGGERED'?'ALREADY_TRIGGERED':'RECOVERED_CANCELED',
          writeAttempted:true,
          reconciliationRequired:true,
          order:after,
        };
      }
      if (error.ambiguous) {
        throw new BinanceRequestError('ALGO_CANCEL_RESULT_AMBIGUOUS',{
          data:{clientAlgoId:cid,status:afterStatus},
          ambiguous:true,
        });
      }
      throw error;
    } catch (queryError) {
      if (queryError instanceof BinanceRequestError &&
          queryError.message==='ALGO_CANCEL_RESULT_AMBIGUOUS') throw queryError;
      if (notFound(queryError)) {
        return {
          ok:true,
          disposition:'NOT_FOUND_AFTER_CANCEL',
          writeAttempted:true,
          reconciliationRequired:true,
          order:null,
        };
      }
      throw queryError;
    }
  }
}
