import test from 'node:test';
import assert from 'node:assert/strict';
import { binanceApiPermissionBlockers, fetchBinanceApiPermissions } from '../lib/binance-api-permissions.mjs';

const safe = {
  ipRestrict: true,
  enableReading: true,
  enableWithdrawals: false,
  enableInternalTransfer: false,
  enableMargin: false,
  enableFutures: true,
  permitsUniversalTransfer: false,
  enableVanillaOptions: false,
  enableFixApiTrade: false,
  enableFixReadOnly: true,
  enableSpotAndMarginTrading: false,
  enablePortfolioMarginTrading: false,
};

test('safe Futures-only Binance API permissions are accepted', () => {
  assert.deepEqual(binanceApiPermissionBlockers(safe), []);
});



test('unrestricted Binance API key blocks real execution', () => {
  const blockers = binanceApiPermissionBlockers({...safe, ipRestrict:false});
  assert.ok(blockers.includes('BINANCE_API_IP_RESTRICTION_REQUIRED'));
});

test('withdrawal and transfer capabilities block real execution', () => {
  const blockers = binanceApiPermissionBlockers({
    ...safe,
    enableWithdrawals: true,
    enableInternalTransfer: true,
    permitsUniversalTransfer: true,
  });
  assert.ok(blockers.includes('BINANCE_API_WITHDRAWALS_MUST_BE_DISABLED'));
  assert.ok(blockers.includes('BINANCE_API_INTERNAL_TRANSFER_MUST_BE_DISABLED'));
  assert.ok(blockers.includes('BINANCE_API_UNIVERSAL_TRANSFER_MUST_BE_DISABLED'));
});

test('non-Futures and extra trading permissions block real execution', () => {
  const blockers = binanceApiPermissionBlockers({
    ...safe,
    enableFutures: false,
    enableMargin: true,
    enableVanillaOptions: true,
    enableFixApiTrade: true,
    enableSpotAndMarginTrading: true,
    enablePortfolioMarginTrading: true,
  });
  assert.ok(blockers.includes('BINANCE_API_FUTURES_REQUIRED'));
  assert.ok(blockers.includes('BINANCE_API_MARGIN_MUST_BE_DISABLED'));
  assert.ok(blockers.includes('BINANCE_API_OPTIONS_MUST_BE_DISABLED'));
  assert.ok(blockers.includes('BINANCE_API_FIX_TRADE_MUST_BE_DISABLED'));
  assert.ok(blockers.includes('BINANCE_API_SPOT_MARGIN_TRADING_MUST_BE_DISABLED'));
  assert.ok(blockers.includes('BINANCE_API_PORTFOLIO_MARGIN_MUST_BE_DISABLED'));
});

test('missing or unreadable permission data fails closed', () => {
  assert.deepEqual(binanceApiPermissionBlockers(null), ['BINANCE_API_PERMISSIONS_UNAVAILABLE']);
  assert.ok(binanceApiPermissionBlockers({...safe, enableReading:false}).includes('BINANCE_API_READING_REQUIRED'));
});


test('permission fetch signs the Binance restrictions request and returns the permission record', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    if (u.pathname === '/api/v3/time') {
      return new Response(JSON.stringify({ serverTime: 1700000000000 }));
    }
    if (u.pathname === '/sapi/v1/account/apiRestrictions') {
      assert.equal(init.headers['X-MBX-APIKEY'], 'api-key-test');
      assert.equal(u.searchParams.get('timestamp'), '1700000000000');
      assert.equal(u.searchParams.get('recvWindow'), '5000');
      assert.ok(u.searchParams.get('signature'));
      return new Response(JSON.stringify(safe));
    }
    return new Response('{}', { status: 404 });
  };

  const result = await fetchBinanceApiPermissions({
    apiKey: 'api-key-test',
    secret: 'secret',
    fetchImpl,
  });

  assert.deepEqual(result, safe);
  assert.equal(calls.length, 2);
});

test('permission fetch fails closed when Binance permission data cannot be verified', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/v3/time') {
      return new Response(JSON.stringify({ serverTime: 1700000000000 }));
    }
    return new Response(JSON.stringify({ code: -2015, msg: 'rejected' }), { status: 401 });
  };

  await assert.rejects(
    fetchBinanceApiPermissions({ apiKey: 'api-key-test', secret: 'secret', fetchImpl }),
    error => error?.code === 'BINANCE_API_PERMISSION_CHECK_FAILED',
  );
});
