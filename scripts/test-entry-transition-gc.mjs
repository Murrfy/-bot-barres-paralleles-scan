import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  evaluateEntryTransitionReconciliation,
} from '../lib/entry-transition.mjs';
import {
  expiredEntryOrphanProtections,
} from '../lib/protective-command.mjs';

const reconcileApi=fs.readFileSync('api/binance-reconcile.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

const now=2_000_000;
const expired={
  version:1,state:'ENTRY_SUBMITTED',commandId:'auto-entry-BTCUSDT-1234567890abcdef1234',
  symbol:'BTCUSDT',side:'BUY',direction:'LONG',quantity:0.2,limitPrice:50000,maxLossUsd:400,
  protectionTriggerPrice:48000,protectionClientAlgoId:'zth-MAX-abcdef123456789012345678',
  entryClientOrderId:'zth-ENT-abcdef123456789012345678',
  createdAt:now-121000,expiresAt:now-1000,validatedAt:now-121000,
  controllerRevision:14,masterDeviceId:'zenith-server-engine-v1',masterRoleEpoch:'123',
  engineInstanceId:'engine-instance-test',
};
const protection={
  orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',
  closePosition:true,reduceOnly:false,triggerPrice:'48000',
  clientAlgoId:'zth-MAX-abcdef123456789012345678'
};

test('expired transition with only exact protection is classified for orphan cleanup, not pruning',()=>{
  const r=evaluateEntryTransitionReconciliation({
    transitions:[expired],actualOrders:[protection],actualPositions:[],now,
  });
  assert.equal(r.active.length,0);
  assert.equal(r.expiredProtectionOnly.length,1);
  assert.equal(r.prunableExpired.length,0);
  assert.equal(r.expiredProtectionOnly[0].commandId,expired.commandId);
});

test('expired transition with no entry, protection or position is prunable',()=>{
  const r=evaluateEntryTransitionReconciliation({
    transitions:[expired],actualOrders:[],actualPositions:[],now,
  });
  assert.equal(r.expiredProtectionOnly.length,0);
  assert.equal(r.prunableExpired.length,1);
  assert.equal(r.prunableExpired[0].commandId,expired.commandId);
});

test('expired transition tied to a live position is conservatively retained',()=>{
  const r=evaluateEntryTransitionReconciliation({
    transitions:[expired],
    actualOrders:[],
    actualPositions:[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.2'}],
    now,
  });
  assert.equal(r.prunableExpired.length,0);
  assert.equal(r.expiredProtectionOnly.length,0);
});

test('only exact expired-entry orphan protection is associated with not-started outcome',()=>{
  const report={
    version:2,status:'MISMATCH',failClosed:true,
    reasons:['ORPHAN_ZENITH_PROTECTIVE_ORDER'],
    differences:{
      entryTransitions:{expiredProtectionOnly:[{
        commandId:expired.commandId,symbol:'BTCUSDT',direction:'LONG',
        protectionClientAlgoId:expired.protectionClientAlgoId,
        entryClientOrderId:expired.entryClientOrderId,
      }]},
      orphanZenithProtectiveOrders:[{
        ...protection,orderClass:'ALGO',
      }],
    },
  };
  const rows=expiredEntryOrphanProtections(report);
  assert.equal(rows.length,1);
  assert.equal(rows[0].commandId,expired.commandId);

  const wrong={...report,differences:{
    ...report.differences,
    orphanZenithProtectiveOrders:[{...protection,clientAlgoId:'zth-MAX-other'}],
  }};
  assert.deepEqual(expiredEntryOrphanProtections(wrong),[]);
});

test('reconcile API prunes only clean-report inert transition ids and never invalid records',()=>{
  assert.match(reconcileApi,/prunableExpired: transitionState\.prunableExpired\.map/);
  assert.match(reconcileApi,/if \(report\.failClosed === false\)/);
  assert.match(reconcileApi,/redis\(\['HDEL', KEY_ENTRY_TRANSITIONS, commandId\]\)/);
  assert.match(reconcileApi,/Garbage collection is non-authoritative/);
  assert.doesNotMatch(reconcileApi,/invalidReasons[\s\S]{0,300}HDEL/);
});

test('orphan cleanup marks not-started only if current watch still has same auto-entry command id',()=>{
  const start=worker.indexOf('const orphanTargets=orphanZenithCleanupOrders');
  const end=worker.indexOf('const repairTarget=missingMaxLossRepairTarget',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.match(block,/expiredEntryOrphanProtections\(data\.report\)/);
  assert.match(block,/watchedEntryConfig\(expiredEntry\.symbol\)/);
  assert.match(block,/autoEntryCommandId\(watchConfig\)===expiredEntry\.commandId/);
  assert.match(block,/watchState\.blockedAt=Date\.now\(\)/);
  assert.match(block,/persistEntryWatchStateNow\(\)/);
});
