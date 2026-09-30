import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('real active position shows only a compact MAX-LOSS state in its header',()=>{
  const start=html.indexOf('function renderRealPositions(){');
  const end=html.indexOf('function renderControllerIdentity()',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);
  assert.match(block,/🟢 MAX-LOSS : ACTIVE/);
  assert.match(block,/🔴 MAX-LOSS ABSENTE — RÉPARATION EN COURS/);
  assert.match(block,/maxLossState/);
  assert.match(block,/const openedAt=Math\.max\(0,n\(p\.openedAt,n\(p\.lifecycleAt,n\(p\.positionLifecycleAt,n\(p\.updateTime,0\)\)\)\)\)/);
  assert.match(block,/class="posElapsed">\$\{openedAt>0\?elapsedHMS\(openedAt\):'—'\}/);
  assert.doesNotMatch(block,/MODIFICATIONS OBJECTIF \/ PROTECTION GAIN BLOQUÉES/);
});

test('MAX-LOSS state styling remains discreet',()=>{
  assert.match(html,/\.maxLossState\{font-size:7px;/);
  assert.doesNotMatch(html,/\.maxLossState\{[^}]*font-size:(?:1[2-9]|[2-9][0-9])px/);
});


test('persistent MAX-LOSS red alert is delayed, optional and one-shot until recovery',()=>{
  assert.match(html,/const MAX_LOSS_RED_PERSIST_MS=30000/);
  assert.match(html,/function updatePersistentMaxLossAlerts\(rows\)/);
  assert.match(html,/settings\.maxLossAlert!==false/);
  assert.match(html,/maxLossRedAlerted\.has\(symbol\)/);
  assert.match(html,/now-n\(maxLossRedSince\.get\(symbol\),now\)>=MAX_LOSS_RED_PERSIST_MS/);
  assert.match(html,/maxLossRedAlerted\.delete\(symbol\)/);
  assert.match(html,/updatePersistentMaxLossAlerts\(rows\)/);
  assert.match(html,/ALERTE MAX-LOSS/);
});
