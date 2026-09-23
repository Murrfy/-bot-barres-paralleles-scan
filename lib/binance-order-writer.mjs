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
}) {
  if (!apiKey || !secret) throw new Error('BINANCE_CREDENTIALS_REQUIRED');
  const signed = signParams(encodeParams({ ...params, timestamp, recvWindow }), secret);
  const headers = { 'X-MBX-APIKEY': apiKey };
  const upper = String(method || 'GET').toUpperCase();

  try {
    let response;
    if (upper === 'GET' || upper === 'DELETE') {
      response = await fetchImpl(`${baseUrl}${path}?${signed.toString()}`, {
        method: upper,
        headers,
        cache: 'no-store',
      });
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: upper,
        headers,
        body: signed.toString(),
        cache: 'no-store',
      });
    }
    return await parseResponse(response);
  } catch (error) {
    if (error instanceof BinanceRequestError) throw error;
    throw new BinanceRequestError(error?.message || 'BINANCE_NETWORK_ERROR', { ambiguous: true });
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
