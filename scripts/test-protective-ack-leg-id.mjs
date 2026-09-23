import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildExitOrderPlan } from '../lib/order-intent.mjs';
import { buildProtectiveAlgoPlan } from '../lib/protective-update-intent.mjs';

const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');

test('protective ACK requires exact Zenith leg prefix',()=>{
  assert.match(sync,/expectedProofPrefix = commandType === 'EXEC_UPDATE_EXIT'/);
  assert.match(sync,/'zth-EXI-'/);
  assert.match(sync,/'zth-MAX-'/);
  assert.match(sync,/'zth-PRO-'/);
  assert.match(sync,/^\s*if \(!\/\^zth-\(\?:EXI\|PRO\|MAX\)-\[a-f0-9\]\{24\}\$\/\.test\(newClientId\)/m);
});

test('planner IDs match the ACK prefixes exactly',()=>{
  const exit=buildExitOrderPlan({
    commandId:'command-12345678',symbol:'BTCUSDT',direction:'LONG',
    quantity:1,targetPrice:110,exitMode:'NORMAL_LIMIT'
  });
  const progressive=buildProtectiveAlgoPlan({
    commandId:'command-12345678',symbol:'BTCUSDT',direction:'LONG',
    quantity:1,triggerPrice:105,limitPrice:105,protectionKind:'PROGRESSIVE'
  });
  const maxLoss=buildProtectiveAlgoPlan({
    commandId:'command-12345678',symbol:'BTCUSDT',direction:'LONG',
    quantity:1,triggerPrice:90,protectionKind:'MAX_LOSS'
  });
  assert.match(exit.params.newClientOrderId,/^zth-EXI-[a-f0-9]{24}$/);
  assert.match(progressive.params.clientAlgoId,/^zth-PRO-[a-f0-9]{24}$/);
  assert.match(maxLoss.params.clientAlgoId,/^zth-MAX-[a-f0-9]{24}$/);
});
