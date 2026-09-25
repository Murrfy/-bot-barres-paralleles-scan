import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('real active position shows only a compact MAX-LOSS state in its header',()=>{
  const start=html.indexOf('function renderRealPositions(){');
  const end=html.indexOf('function applyMasterReadOnlyPolicy()',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);
  assert.match(block,/🟢 MAX-LOSS : ACTIVE/);
  assert.match(block,/🔴 MAX-LOSS ABSENTE — RÉPARATION EN COURS/);
  assert.match(block,/maxLossState/);
  assert.doesNotMatch(block,/MODIFICATIONS OBJECTIF \/ PROTECTION GAIN BLOQUÉES/);
});

test('MAX-LOSS state styling remains discreet',()=>{
  assert.match(html,/\.maxLossState\{font-size:7px;/);
  assert.doesNotMatch(html,/\.maxLossState\{[^}]*font-size:(?:1[2-9]|[2-9][0-9])px/);
});
