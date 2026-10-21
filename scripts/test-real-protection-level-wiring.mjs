import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api=await readFile(new URL('../api/binance-protective-update-execute.js',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('real protective update server enforces configured max-loss validation before write',()=>{
  assert.match(api,/validateMaxLossTrigger\(\{/);
  assert.match(api,/hardMaxLossUsd:allowedMaxLoss/);
  assert.doesNotMatch(api,/hardMaxLossUsd:REAL_RISK_LIMITS\.maxLossUsd/);
  assert.match(api,/MAX_LOSS_EXCEEDS_SERVER_LIMIT|MAX_LOSS_TRIGGER_INVALID/);
  const validationIndex=api.indexOf('validateMaxLossTrigger({');
  const writerIndex=api.indexOf('placeAlgoOrderIdempotent({');
  assert.ok(validationIndex>=0&&writerIndex>validationIndex);
});

test('iPhone keeps the shared calculator for token-settings edits and a compact active card',()=>{
  assert.match(html,/import\('\/lib\/real-protection-levels\.mjs'\)/);
  assert.match(html,/buildRealProtectionLevels\(\{/);
  assert.match(html,/grossNote/);
  assert.match(html,/data-real-close=/);
  assert.doesNotMatch(html,/data-real-auto-exit|data-real-auto-maxloss|data-real-exit=|data-real-progressive=|data-real-maxloss=/);
});
