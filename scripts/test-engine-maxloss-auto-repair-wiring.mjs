import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('24/7 engine repairs one exact missing MAX-LOSS before accepting reconciliation',()=>{
  assert.match(worker,/buildMaxLossRepairPlan/);
  assert.match(worker,/repairMissingMaxLoss\(data\.report\)/);
  assert.match(worker,/AUTO_MAX_LOSS_REPAIR_/);
  assert.match(worker,/protectionKind:'MAX_LOSS'/);
  assert.match(worker,/phase:'PLACE_NEW'/);
  assert.match(worker,/STOP_MARKET/);
  assert.match(worker,/closePosition/);
  assert.match(worker,/return reconcile\(true\)/);
});

test('ambiguous or failed repair remains fail-closed without manual PANIC or auto-close',()=>{
  assert.match(worker,/if\(plan\.action!=='REPAIR'\)/);
  assert.match(worker,/await invalidateStream\(reason\)/);
  assert.match(worker,/AUTO_MAX_LOSS_REPAIR_RECONCILIATION_FAILED/);
  assert.equal(worker.includes("syncApi('emergency-stop'"),false);
});
