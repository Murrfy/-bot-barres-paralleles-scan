import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('MASTER auto protection only accepts a single emergency stop within the hard $400 cap',()=>{
  assert.match(html,/function masterHasSingleMaxLoss\(position,orders,hardMaxLossUsd=400\)/);
  assert.match(html,/const impliedLossUsd=direction==='LONG'/);
  assert.match(html,/return impliedLossUsd<=cap\+1e-8/);
  assert.match(html,/if\(!masterHasSingleMaxLoss\(position,orders\)\)/);
});
