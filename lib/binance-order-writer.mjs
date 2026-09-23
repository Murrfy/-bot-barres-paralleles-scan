import crypto from 'node:crypto';

export class BinanceRequestError extends Error {
  constructor(message, { status = 0, code = null, data = null, ambiguous = false } = {}) {
    super(message);
    this.name = 'BinanceRequestError';
    this.status = status;
    this.code = code;
    this.data = data;
    this.ambiguous = ambiguous;
  }
}

function encodeParams(params = {}) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    out.set(key, String(value));
  }
  return out;
}

function signParams(params, secret) {
  const signature = crypto.createHmac('sha256', secret).update(params.toString()).digest('hex');
  params.set('signature', signature);
  return params;
}

async function parseResponse(response) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || (typeof data?.code === 'number' && data.code < 0)) {
    throw new BinanceRequestError(data?.msg || `Binance HTTP ${response.status}`, {
      status: response.status,
      code: data?.code ?? null,
      data,
      ambiguous: response.status >= 500,
    });
  }
  return data;
}

export async function signedBinanceRequest({
  fetchImpl = fetch,
  baseUrl = 'https://fapi.binance.com',
  path,
  method = 'GET',
  apiKey,
  secret,
  params = {},
  timestamp = Date.now(),
  recvWindow = 5000,
  timeoutMs = 8000,
}) {
  if (!apiKey || !secret) throw new Error('BINANCE_CREDENTIALS_REQUIRED');
  const signed = signParams(encodeParams({ ...params, timestamp, recvWindow }), secret);
  const headers = { 'X-MBX-APIKEY': apiKey };
  const upper = String(method || 'GET').toUpperCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 8000));
  try {
    let response;
    if (upper === 'GET' || upper === 'DELETE') {
      response = await fetchImpl(`${baseUrl}${path}?${signed.toString()}`, {
        method: upper,
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: upper,
        headers,
        body: signed.toString(),
        cache: 'no-store',
        signal: controller.signal,
      });
    }
    return await parseResponse(response);
  } catch (error) {
    if (error instanceof BinanceRequestError) throw error;
    const message = error?.name === 'AbortError' ? 'BINANCE_REQUEST_TIMEOUT' : (error?.message || 'BINANCE_NETWORK_ERROR');
    throw new BinanceRequestError(message, { ambiguous: true });
  } finally {
    clearTimeout(timer);
  }
}

export async function queryOrderByClientId({
  fetchImpl = fetch,
  apiKey,
  secret,
  symbol,
  clientOrderId,
  timestamp = Date.now(),
}) {
  return signedBinanceRequest({
    fetchImpl,
    path: '/fapi/v1/order',
    method: 'GET',
    apiKey,
    secret,
    timestamp,
    params: { symbol, origClientOrderId: clientOrderId },
  });
}

function orderNotFound(error) {
  return error instanceof BinanceRequestError && Number(error.code) === -2013;
}

export async function placeStandardOrderIdempotent({
  fetchImpl = fetch,
  apiKey,
  secret,
  orderParams,
  writesEnabled = false,
  timestamp = Date.now(),
}) {
  const symbol = String(orderParams?.symbol || '').toUpperCase();
  const clientOrderId = String(orderParams?.newClientOrderId || '');
  if (!symbol || !clientOrderId) throw new Error('ORDER_IDEMPOTENCY_FIELDS_REQUIRED');

  try {
    const existing = await queryOrderByClientId({
      fetchImpl, apiKey, secret, symbol, clientOrderId, timestamp,
    });
    return {
      ok: true,
      disposition: 'EXISTING',
      writeAttempted: false,
      order: existing,
    };
  } catch (error) {
    if (!orderNotFound(error)) throw error;
  }

  if (!writesEnabled) {
    return {
      ok: false,
      disposition: 'WRITE_LOCKED',
      writeAttempted: false,
      clientOrderId,
    };
  }

  try {
    const placed = await signedBinanceRequest({
      fetchImpl,
      path: '/fapi/v1/order',
      method: 'POST',
      apiKey,
      secret,
      timestamp,
      params: { ...orderParams, newOrderRespType: 'ACK' },
    });
    if (String(placed?.clientOrderId || '') !== clientOrderId) {
      throw new BinanceRequestError('BINANCE_CLIENT_ORDER_ID_MISMATCH', { data: placed, ambiguous: true });
    }
    return {
      ok: true,
      disposition: 'PLACED',
      writeAttempted: true,
      order: placed,
    };
  } catch (error) {
    if (!(error instanceof BinanceRequestError) || !error.ambiguous) throw error;

    // A timeout/5xx after POST is ambiguous. Never submit a second POST blindly:
    // query the deterministic client id first.
    try {
      const recovered = await queryOrderByClientId({
        fetchImpl, apiKey, secret, symbol, clientOrderId, timestamp: timestamp + 1,
      });
      return {
        ok: true,
        disposition: 'RECOVERED_AFTER_AMBIGUOUS_POST',
        writeAttempted: true,
        order: recovered,
      };
    } catch (queryError) {
      if (!orderNotFound(queryError)) throw queryError;
      throw new BinanceRequestError('ORDER_RESULT_AMBIGUOUS', {
        data: { clientOrderId, originalError: error.message },
        ambiguous: true,
      });
    }
  }
}


function terminalOrderStatus(status) {
  return ['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(String(status || '').toUpperCase());
}

export async function cancelEntryOrderIdempotent({
  fetchImpl = fetch,
  apiKey,
  secret,
  symbol,
  clientOrderId,
  writesEnabled = false,
  timestamp = Date.now(),
}) {
  const sym = String(symbol || '').toUpperCase();
  const cid = String(clientOrderId || '');
  if (!/^[A-Z0-9]{3,30}$/.test(sym) || !cid || cid.length > 36) {
    throw new Error('CANCEL_IDEMPOTENCY_FIELDS_INVALID');
  }

  let existing;
  try {
    existing = await queryOrderByClientId({
      fetchImpl, apiKey, secret, symbol: sym, clientOrderId: cid, timestamp,
    });
  } catch (error) {
    if (orderNotFound(error)) {
      throw new BinanceRequestError('CANCEL_TARGET_UNKNOWN', {
        code: error.code,
        data: { symbol: sym, clientOrderId: cid },
        ambiguous: true,
      });
    }
    throw error;
  }

  if (existing?.reduceOnly === true || existing?.reduceOnly === 'true') {
    throw new BinanceRequestError('CANCEL_TARGET_IS_REDUCE_ONLY', { data: existing });
  }
  if (String(existing?.positionSide || 'BOTH').toUpperCase() !== 'BOTH') {
    throw new BinanceRequestError('HEDGE_MODE_UNSUPPORTED', { data: existing });
  }

  const status = String(existing?.status || '').toUpperCase();
  if (terminalOrderStatus(status)) {
    return {
      ok: true,
      disposition: status === 'FILLED' ? 'ALREADY_FILLED' : 'ALREADY_TERMINAL',
      writeAttempted: false,
      reconciliationRequired: true,
      order: existing,
    };
  }

  if (!writesEnabled) {
    return {
      ok: false,
      disposition: 'WRITE_LOCKED',
      writeAttempted: false,
      order: existing,
    };
  }

  try {
    const canceled = await signedBinanceRequest({
      fetchImpl,
      path: '/fapi/v1/order',
      method: 'DELETE',
      apiKey,
      secret,
      timestamp,
      params: { symbol: sym, origClientOrderId: cid },
    });
    return {
      ok: true,
      disposition: 'CANCELED',
      writeAttempted: true,
      reconciliationRequired: true,
      order: canceled,
    };
  } catch (error) {
    if (!(error instanceof BinanceRequestError)) throw error;

    // Whether the DELETE failed definitively or the network result is ambiguous,
    // re-query first. Never assume cancellation from a transport error.
    try {
      const after = await queryOrderByClientId({
        fetchImpl, apiKey, secret, symbol: sym, clientOrderId: cid, timestamp: timestamp + 1,
      });
      const afterStatus = String(after?.status || '').toUpperCase();
      if (terminalOrderStatus(afterStatus)) {
        return {
          ok: true,
          disposition: afterStatus === 'FILLED' ? 'ALREADY_FILLED' : 'RECOVERED_CANCELED',
          writeAttempted: true,
          reconciliationRequired: true,
          order: after,
        };
      }
      if (error.ambiguous) {
        throw new BinanceRequestError('CANCEL_RESULT_AMBIGUOUS', {
          data: { symbol: sym, clientOrderId: cid, status: afterStatus },
          ambiguous: true,
        });
      }
      throw error;
    } catch (queryError) {
      if (queryError instanceof BinanceRequestError && queryError.message === 'CANCEL_RESULT_AMBIGUOUS') throw queryError;
      if (orderNotFound(queryError)) {
        throw new BinanceRequestError('CANCEL_RESULT_AMBIGUOUS', {
          data: { symbol: sym, clientOrderId: cid },
          ambiguous: true,
        });
      }
      throw queryError;
    }
  }
}
