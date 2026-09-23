import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api=await readFile(new URL('../api/binance-protective-update-execute.js',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('real protective update server enforces hard max-loss validation before write',()=>{
  assert.match(api,/validateMaxLossTrigger\(\{/);
  assert.match(api,/hardMaxLossUsd:REAL_RISK_LIMITS\.maxLossUsd/);
  assert.match(api,/MAX_LOSS_EXCEEDS_SERVER_LIMIT|MAX_LOSS_TRIGGER_INVALID/);
  const validationIndex=api.indexOf('validateMaxLossTrigger({');
  const writerIndex=api.indexOf('placeAlgoOrderIdempotent({');
  assert.ok(validationIndex>=0&&writerIndex>validationIndex);
});

test('iPhone exposes auto objective and auto max-loss through shared calculator',()=>{
  assert.match(html,/import\('\/lib\/real-protection-levels\.mjs'\)/);
  assert.match(html,/buildRealProtectionLevels\(\{/);
  assert.match(html,/data-real-auto-exit/);
  assert.match(html,/OBJECTIF AUTO/);
  assert.match(html,/data-real-auto-maxloss/);
  assert.match(html,/PERTE MAX AUTO/);
  assert.match(html,/grossNote/);
});
