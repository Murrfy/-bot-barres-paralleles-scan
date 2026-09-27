import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api=await readFile(new URL('../api/binance-protective-update-execute.js',import.meta.url),'utf8');
const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

test('manual Binance MAX-LOSS has priority only when exactly one safe external order exists',()=>{
  assert.match(worker,/external\.length!==1\|\|managed\.length<1/);
  assert.match(worker,/clientAlgoId:String\(managed\[0\]\?\.clientAlgoId\|\|''\)/);
  assert.match(api,/if\(external\.length!==1\)return \{ok:false,reason:external\.length\?'MULTIPLE_EXTERNAL_MAX_LOSS':'EXTERNAL_MAX_LOSS_NOT_CONFIRMED'\}/);
});

test('priority cleanup can cancel only a Zenith MAX-LOSS id',()=>{
  assert.match(api,/function managedMaxLossId/);
  assert.match(api,/!managedMaxLossId\(clientAlgoId\)/);
  assert.match(api,/target=managed\.find\(o=>String\(o\?\.clientAlgoId\|\|''\)===targetId\)/);
  assert.match(worker,/type:'EXEC_CLEAN_DUPLICATE_MAX_LOSS'/);
  assert.match(worker,/clientAlgoId:priorityCleanup\.clientAlgoId/);
});

test('Binance is re-read immediately before every managed duplicate cancellation',()=>{
  assert.match(api,/path:'\/fapi\/v3\/positionRisk'/);
  assert.match(api,/path:'\/fapi\/v1\/openAlgoOrders'/);
  assert.match(api,/params:\{algoType:'CONDITIONAL'\}/);
  assert.match(api,/if\(!proof\.ok\)return send\(res,409,\{ok:false,code:proof\.reason,writeAttempted:false\}\)/);
  assert.ok(api.indexOf('const proof=await directBinancePriorityMaxLossProof') < api.indexOf('cancelAlgoOrderIdempotent({'));
});

test('worker removes one Zenith duplicate, confirms terminal Binance state, then reconciles again',()=>{
  assert.match(worker,/const priorityCleanup=binancePriorityMaxLossCleanupTarget\(data\.report\)/);
  assert.match(worker,/clientId:priorityCleanup\.clientAlgoId,terminal:true/);
  assert.match(worker,/return reconcile\(false\)/);
  assert.match(worker,/managedCount:managed\.length/);
});
