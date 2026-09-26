import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  evaluateEntryRisk,
  DEFAULT_MAX_ACTIVE_POSITIONS,
  MAX_ACTIVE_POSITIONS_HARD_CAP,
} from '../lib/risk-policy.mjs';

test('server risk policy hard-caps simultaneous positions at three',()=>{
  assert.equal(DEFAULT_MAX_ACTIVE_POSITIONS,3);
  assert.equal(MAX_ACTIVE_POSITIONS_HARD_CAP,3);
  const result=evaluateEntryRisk({
    symbol:'BTCUSDT',
    margin:100,
    leverage:10,
    maxLoss:40,
    referencePrice:50000,
    maxActivePositions:4,
  });
  assert.ok(result.reasons.includes('MAX_ACTIVE_CONFIG_INVALID'));
  assert.equal(result.normalized.maxActivePositions,3);
});

test('Binance preflight refuses controller maxActive above three',()=>{
  const src=fs.readFileSync('api/binance-entry-preflight.js','utf8');
  assert.match(src,/value > MAX_ACTIVE_POSITIONS_HARD_CAP/);
});

test('Render worker rejects config above three before entry watch dispatch',()=>{
  const src=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  assert.match(src,/requestedMaxActive>MAX_ACTIVE_POSITIONS_HARD_CAP/);
});

test('iPhone UI and legacy load are capped at three',()=>{
  const html=fs.readFileSync('index.html','utf8');
  assert.match(html,/id="bMaxActive" type="number" min="1" max="3" step="1"/);
  assert.match(html,/settings\.maxActive=clamp\(Math\.trunc\(n\(settings\.maxActive,3\)\),1,3\)/);
  assert.match(html,/requested>=1&&requested<=3\?requested:3/);
});
