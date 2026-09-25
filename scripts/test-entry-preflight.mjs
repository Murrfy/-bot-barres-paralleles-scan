import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
        { filterType: 'PRICE_FILTER', minPrice: '1', maxPrice: '1000000', tickSize: '0.10' },
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


test('configured maxActive=1 blocks a second real position', () => {
  const positions = [{symbol:'ETHUSDT', positionAmt:'1'}];
  const r = evaluateEntryRisk(base({ positions, maxActivePositions:1 }));
  assert.equal(r.normalized.maxActivePositions,1);
  assert.equal(r.normalized.occupiedPositionSlots,1);
  assert.ok(r.reasons.includes('MAX_ACTIVE_POSITIONS_REACHED'));
});

test('pending entry orders reserve real position slots across symbols', () => {
  const r = evaluateEntryRisk(base({
    maxActivePositions:2,
    positions:[{symbol:'ETHUSDT',positionAmt:'1'}],
    standardOrders:[{symbol:'SOLUSDT',side:'BUY',type:'LIMIT',reduceOnly:false,closePosition:false}],
  }));
  assert.equal(r.normalized.activePositions,1);
  assert.equal(r.normalized.pendingEntrySlots,1);
  assert.equal(r.normalized.occupiedPositionSlots,2);
  assert.ok(r.reasons.includes('MAX_ACTIVE_POSITIONS_REACHED'));
});

test('protective orders never consume a new position slot', () => {
  const r = evaluateEntryRisk(base({
    maxActivePositions:2,
    positions:[{symbol:'ETHUSDT',positionAmt:'1'}],
    algoOrders:[{symbol:'ETHUSDT',side:'SELL',type:'STOP_MARKET',closePosition:true,reduceOnly:false}],
  }));
  assert.equal(r.normalized.pendingEntrySlots,0);
  assert.equal(r.normalized.occupiedPositionSlots,1);
  assert.equal(r.reasons.includes('MAX_ACTIVE_POSITIONS_REACHED'),false);
});

test('invalid configured maxActive fails closed instead of raising the server cap', () => {
  const r = evaluateEntryRisk(base({ maxActivePositions:4 }));
  assert.equal(r.ready,false);
  assert.ok(r.reasons.includes('MAX_ACTIVE_CONFIG_INVALID'));
  assert.equal(r.normalized.maxActivePositions,REAL_RISK_LIMITS.maxActivePositions);
});


test('existing target-symbol order blocks duplicate entry', () => {
  const r = evaluateEntryRisk(base({ standardOrders:[{symbol:'BTCUSDT'}] }));
  assert.ok(r.reasons.includes('SYMBOL_ORDER_ALREADY_OPEN'));
});

test('insufficient available balance fails closed', () => {
  const r = evaluateEntryRisk(base({ availableBalanceUsdt: 500 }));
  assert.ok(r.reasons.includes('AVAILABLE_BALANCE_INSUFFICIENT'));
});


test('protective close-only orders do not masquerade as duplicate entry orders', () => {
  const r = evaluateEntryRisk(base({
    algoOrders:[{
      symbol:'BTCUSDT',
      side:'SELL',
      type:'STOP_MARKET',
      closePosition:true,
      reduceOnly:false,
    }],
  }));
  assert.equal(r.ready, true);
  assert.equal(r.normalized.protectiveOrdersPresent, 1);
});

test('limit reference price must respect Binance PRICE_FILTER tick', () => {
  const r = evaluateEntryRisk(base({ referencePrice: 50000.05 }));
  assert.equal(r.ready, false);
  assert.ok(r.reasons.includes('PRICE_NOT_TICK_ALIGNED'));
});

test('limit reference price must remain inside Binance PRICE_FILTER bounds', () => {
  const symbolInfo = structuredClone(base().symbolInfo);
  symbolInfo.filters[0] = { filterType:'PRICE_FILTER', minPrice:'100', maxPrice:'60000', tickSize:'0.10' };
  const r = evaluateEntryRisk(base({ referencePrice: 70000, symbolInfo }));
  assert.equal(r.ready, false);
  assert.ok(r.reasons.includes('PRICE_ABOVE_EXCHANGE_MAX'));
});


test('TradFi USDT perpetual contracts stay eligible (IBM-like)', () => {
  const seed=base();
  const symbolInfo=structuredClone(seed.symbolInfo);
  symbolInfo.symbol='IBMUSDT';
  symbolInfo.contractType='TRADIFI_PERPETUAL';
  const symbolConfig={...seed.symbolConfig,symbol:'IBMUSDT'};
  const bracketInfo={...seed.bracketInfo,symbol:'IBMUSDT'};
  const r=evaluateEntryRisk(base({symbol:'IBMUSDT',symbolInfo,symbolConfig,bracketInfo}));
  assert.equal(r.ready,true);
  assert.ok(!r.reasons.includes('SYMBOL_NOT_USDT_PERPETUAL'));
});

test('live preflight reads all open entry orders so pending symbols reserve slots', () => {
  const source=fs.readFileSync('api/binance-entry-preflight.js','utf8');
  assert.match(source,/signedGet\('\/fapi\/v1\/openOrders', apiKey, secret, serverTime\)/);
  assert.match(source,/signedGet\('\/fapi\/v1\/openAlgoOrders', apiKey, secret, serverTime, \{ algoType: 'CONDITIONAL' \}\)/);
  assert.match(source,/maxActivePositions = await readConfiguredMaxActivePositions\(\)/);
});

test('new Binance special perpetual families remain eligible without code changes', () => {
  const symbolInfo=structuredClone(base().symbolInfo);
  symbolInfo.contractType='NEWCLASS_PERPETUAL';
  const r=evaluateEntryRisk(base({symbolInfo}));
  assert.equal(r.reasons.includes('SYMBOL_NOT_USDT_PERPETUAL'),false);
});

test('delivery contracts are not mistaken for perpetual contracts', () => {
  const symbolInfo=structuredClone(base().symbolInfo);
  symbolInfo.contractType='CURRENT_QUARTER';
  const r=evaluateEntryRisk(base({symbolInfo}));
  assert.ok(r.reasons.includes('SYMBOL_NOT_USDT_PERPETUAL'));
});


test('Binance auto-add margin is rejected even in ISOLATED mode', () => {
  const symbolConfig={...base().symbolConfig,isAutoAddMargin:true};
  const r=evaluateEntryRisk(base({symbolConfig}));
  assert.equal(r.ready,false);
  assert.ok(r.reasons.includes('AUTO_ADD_MARGIN_ENABLED'));
  assert.equal(r.normalized.autoAddMargin,true);
});
