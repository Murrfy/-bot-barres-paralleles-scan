import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('server auto protection accepts only one safe MAX-LOSS within the supplied configured cap',()=>{
  assert.match(worker,/function safeMaxLossOrders\(position,orders,hardMaxLossUsd\)/);
  assert.match(worker,/const impliedLossUsd=direction==='LONG'/);
  assert.match(worker,/return impliedLossUsd>=0&&impliedLossUsd<=cap\+1e-8/);
  assert.match(worker,/function uniqueManagedMaxLoss\(position,orders,hardMaxLossUsd=REAL_RISK_LIMITS\.maxLossUsd\)/);
  assert.match(worker,/uniqueManagedMaxLoss\(position,orders,configuredMaxLoss\)/);
  assert.match(worker,/const rows=safeMaxLossOrders\(position,orders,hardMaxLossUsd\)/);
  assert.match(worker,/return rows\.length===1/);
});
