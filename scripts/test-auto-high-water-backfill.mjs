import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  backfillStartTime,
  favorableExtremeFromMarkKlines,
  highWaterProfitFromExtreme,
} from '../lib/auto-high-water-backfill.mjs';
import { evaluateMasterAutoProgressiveProtection } from '../lib/master-auto-protection.mjs';

const worker = fs.readFileSync(new URL('../server/zenith-engine-worker.mjs', import.meta.url), 'utf8');

test('backfill starts at the first full minute after opening, never before', () => {
  const opened = Date.UTC(2026, 0, 1, 10, 0, 30);
  const start = backfillStartTime(opened, opened + 10 * 60000);
  assert.equal(start, Date.UTC(2026, 0, 1, 10, 1, 0));
  assert.equal(backfillStartTime(0, 1e12), 0);
  assert.equal(backfillStartTime(opened, opened + 1000), 0);
});

test('LONG uses the highest mark price, SHORT the lowest, ignoring candles before start', () => {
  const t = 1_000_000 * 60000;
  const rows = [
    [t - 60000, '1', '99', '1', '1'],
    [t, '1', '103', '99', '1'],
    [t + 60000, '1', '101', '98', '1'],
  ];
  assert.equal(favorableExtremeFromMarkKlines(rows, { direction: 'LONG', startTime: t }), 103);
  assert.equal(favorableExtremeFromMarkKlines(rows, { direction: 'SHORT', startTime: t }), 98);
  assert.ok(Number.isNaN(favorableExtremeFromMarkKlines([], { direction: 'LONG', startTime: t })));
  assert.ok(Number.isNaN(favorableExtremeFromMarkKlines(rows, { direction: 'BOTH', startTime: t })));
});

test('wick above the arm threshold while disconnected arms the gain protection after reconnection', () => {
  const position = { symbol: 'ABCUSDT', positionSide: 'BOTH', positionAmt: '10', entryPrice: '100' };
  const wickProfit = highWaterProfitFromExtreme({ position, extremePrice: 104 });
  assert.equal(wickProfit, 40);
  const plan = evaluateMasterAutoProgressiveProtection({
    position,
    markPrice: 102.8, // déjà redescendu sous le seuil (+30 = 103) mais encore au-dessus du protégé (+20 = 102)
    protectionStages: [{ enabled: true, arm: 30, floor: 20 }],
    currentOrders: [],
    priceFilter: { tickSize: '0.01', minPrice: '0.01', maxPrice: '100000' },
    previousHighWaterProfitUsd: wickProfit,
  });
  assert.equal(plan.action, 'REPLACE');
  assert.equal(plan.level.triggerPrice, 102);
});

test('SHORT profit from the lowest price', () => {
  const position = { symbol: 'ABCUSDT', positionSide: 'BOTH', positionAmt: '-10', entryPrice: '100' };
  assert.equal(highWaterProfitFromExtreme({ position, extremePrice: 96 }), 40);
});

test('worker back-fills the high-water before observing it, read-only and without ordering', () => {
  assert.match(worker, /async function backfillAutoHighWater\(position\)/);
  assert.match(worker, /await backfillAutoHighWater\(position\);\s*const highWaterKey=autoPositionKey\(position\)/);
  const start = worker.indexOf('async function backfillAutoHighWater');
  const end = worker.indexOf('function observeAutoHighWater', start);
  const block = worker.slice(start, end);
  assert.match(block, /markPriceKlines/);
  assert.doesNotMatch(block, /callProtective|binanceApi|EXEC_|signedBinance/);
});
