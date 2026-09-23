import test from 'node:test';
import assert from 'node:assert/strict';
import { binanceApiPermissionBlockers, binanceCredentialSeparationBlockers } from '../api/zenith-sync.js';

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


test('distinct Binance read and trading API keys are required', () => {
  assert.deepEqual(binanceCredentialSeparationBlockers({
    readApiKey:'read-key-123',
    tradingApiKey:'trade-key-456',
  }), []);
  assert.deepEqual(binanceCredentialSeparationBlockers({
    readApiKey:'same-key-123',
    tradingApiKey:'same-key-123',
  }), ['BINANCE_TRADING_KEY_MUST_DIFFER_FROM_READ_KEY']);
});
