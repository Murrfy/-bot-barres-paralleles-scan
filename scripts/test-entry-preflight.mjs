import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEntryRisk, REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';

function base(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    margin: 1000,
    leverage: 10,
    maxLoss: 400,
    referencePrice: 50000,
    symbolInfo: {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      filters: [
        { filterType: 'PRICE_FILTER', minPrice: '0.10', maxPrice: '1000000', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ],
    },
    symbolConfig: {
      symbol: 'BTCUSDT',
      marginType: 'ISOLATED',
      leverage: 10,
      maxNotionalValue: '100000',
    },
    bracketInfo: {
      symbol: 'BTCUSDT',
      brackets: [
        { bracket: 1, initialLeverage: 75, notionalFloor: 0, notionalCap: 50000 },
      ],
    },
    dualSidePosition: false,
    positions: [],
    standardOrders: [],
    algoOrders: [],
    availableBalanceUsdt: 5000,
    ...overrides,
  };
}

test('baseline entry preflight is ready', () => {
  const r = evaluateEntryRisk(base());
  assert.equal(r.ready, true);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.normalized.quantity, 0.2);
});

test('hard server leverage cap is 10x', () => {
  assert.equal(REAL_RISK_LIMITS.maxLeverage, 10);
  const r = evaluateEntryRisk(base({ leverage: 11, symbolConfig: {...base().symbolConfig, leverage: 11} }));
  assert.equal(r.ready, false);
  assert.ok(r.reasons.includes('LEVERAGE_OVER_SERVER_CAP'));
});

test('cross margin is rejected', () => {
  const r = evaluateEntryRisk(base({ symbolConfig: {...base().symbolConfig, marginType: 'CROSSED'} }));
  assert.ok(r.reasons.includes('MARGIN_TYPE_NOT_ISOLATED'));
});

test('hedge mode is detected and rejected until explicitly supported', () => {
  const r = evaluateEntryRisk(base({ dualSidePosition: true }));
  assert.ok(r.reasons.includes('POSITION_MODE_HEDGE_UNSUPPORTED'));
});

test('three active positions block a fourth', () => {
  const positions = ['ETHUSDT','BNBUSDT','SOLUSDT'].map(symbol => ({symbol, positionAmt:'1'}));
  const r = evaluateEntryRisk(base({ positions }));
  assert.ok(r.reasons.includes('MAX_ACTIVE_POSITIONS_REACHED'));
});

test('existing target-symbol order blocks duplicate entry', () => {
  const r = evaluateEntryRisk(base({ standardOrders:[{symbol:'BTCUSDT'}] }));
  assert.ok(r.reasons.includes('SYMBOL_ORDER_ALREADY_OPEN'));
});

test('insufficient available balance fails closed', () => {
  const r = evaluateEntryRisk(base({ availableBalanceUsdt: 500 }));
  assert.ok(r.reasons.includes('AVAILABLE_BALANCE_INSUFFICIENT'));
});


test('entry price must align to Binance tick size', () => {
  const r = evaluateEntryRisk(base({ referencePrice: 50000.05 }));
  assert.equal(r.ready, false);
  assert.ok(r.reasons.includes('PRICE_NOT_TICK_ALIGNED'));
});
