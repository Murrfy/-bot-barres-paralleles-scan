import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('server auto protection accepts only one safe MAX-LOSS within the supplied configured cap',()=>{
  assert.match(worker,/function safeMaxLossOrders\(position,orders,hardMaxLossUsd\)/);
  assert.doesNotMatch(worker,/function safeMaxLossOrders\(position,orders,hardMaxLossUsd=REAL_RISK_LIMITS\.maxLossUsd\)/);
  assert.match(worker,/const impliedLossUsd=direction==='LONG'/);
  assert.match(worker,/return impliedLossUsd>=0&&impliedLossUsd<=cap\+1e-8/);
  assert.match(worker,/function uniqueManagedMaxLoss\(position,orders,hardMaxLossUsd\)/);
  assert.doesNotMatch(worker,/function uniqueManagedMaxLoss\(position,orders,hardMaxLossUsd=REAL_RISK_LIMITS\.maxLossUsd\)/);
  assert.match(worker,/const rows=safeMaxLossOrders\(position,orders,hardMaxLossUsd\)/);
  assert.match(worker,/return rows\.length===1/);
});

test('active MAX-LOSS runtime has no legacy fixed $400 ceiling',()=>{
  assert.doesNotMatch(worker,/REAL_RISK_LIMITS\.maxLossUsd/);
  assert.doesNotMatch(worker,/Math\.min\([^\n]*400/);
  assert.doesNotMatch(worker,/maxLoss[^\n]{0,80}>\s*400/);
  assert.match(worker,/maxLoss>margin\+1e-8/);
});
