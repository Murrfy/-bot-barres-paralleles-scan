import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('24/7 engine repairs one exact missing MAX-LOSS before accepting reconciliation',()=>{
  assert.match(worker,/buildMaxLossRepairPlan/);
  assert.match(worker,/repairMissingMaxLoss\(data\.report\)/);
  assert.match(worker,/AUTO_MAX_LOSS_REPAIR_/);
  assert.doesNotMatch(worker,/syncApi\('emergency-stop'/);
  assert.match(worker,/protectionKind:'MAX_LOSS'/);
  assert.match(worker,/phase:'PLACE_NEW'/);
  assert.match(worker,/STOP_MARKET/);
  assert.match(worker,/closePosition/);
  assert.match(worker,/return reconcile\(true\)/);
});

test('ambiguous or failed repair remains fail-closed without closing the position',()=>{
  assert.match(worker,/if\(plan\.action!=='REPAIR'\)/);
  assert.match(worker,/markMaxLossRepairFailure/);
  assert.match(worker,/AUTO_MAX_LOSS_REPAIR_RECONCILIATION_FAILED/);
  const start=worker.indexOf('async function repairMissingMaxLoss');
  const end=worker.indexOf('async function reconcile',start);
  const repairBlock=worker.slice(start,end);
  assert.doesNotMatch(repairBlock,/runFullClose|EXEC_CLOSE_POSITION|MARKET_LAST_RESORT|emergency-stop/);
});
