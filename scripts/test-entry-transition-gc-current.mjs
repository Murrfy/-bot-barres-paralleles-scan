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
  orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',
  timeInForce:'IOC',priceMatch:'OPPONENT',reduceOnly:true,closePosition:false,
  origQty:'0.2',triggerPrice:'48000',
  clientAlgoId:'zth-MAX-abcdef123456789012345678'
};

test('expired transition with only exact current MAX-LOSS is classified for orphan cleanup, not pruning',()=>{
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

test('only exact STOP IOC OPPONENT reduce-only MAX-LOSS is linked to expired entry',()=>{
  const report={
    version:2,status:'MISMATCH',failClosed:true,
    reasons:['ORPHAN_ZENITH_PROTECTIVE_ORDER'],
    differences:{
      entryTransitions:{expiredProtectionOnly:[{
        state:expired.state,commandId:expired.commandId,symbol:'BTCUSDT',direction:'LONG',
        quantity:expired.quantity,protectionTriggerPrice:expired.protectionTriggerPrice,
        protectionClientAlgoId:expired.protectionClientAlgoId,
        entryClientOrderId:expired.entryClientOrderId,expiresAt:expired.expiresAt,
      }]},
      orphanZenithProtectiveOrders:[{...protection}],
    },
  };
  const rows=expiredEntryOrphanProtections(report);
  assert.equal(rows.length,1);
  assert.equal(rows[0].commandId,expired.commandId);

  assert.deepEqual(expiredEntryOrphanProtections({
    ...report,
    differences:{...report.differences,orphanZenithProtectiveOrders:[{...protection,priceMatch:'OPPONENT_5'}]},
  }),[]);
  assert.deepEqual(expiredEntryOrphanProtections({
    ...report,
    differences:{...report.differences,orphanZenithProtectiveOrders:[{...protection,origQty:'0.3'}]},
  }),[]);
});

test('reconcile prunes only clean inert transitions through atomic compare-and-delete',()=>{
  assert.match(reconcileApi,/prunableExpired: \(Array\.isArray\(transitionState\.prunableExpired\)\?transitionState\.prunableExpired:\[\]\)\.map/);
  assert.match(reconcileApi,/expiredProtectionOnly: \(Array\.isArray\(transitionState\.expiredProtectionOnly\)\?transitionState\.expiredProtectionOnly:\[\]\)\.map/);
  assert.match(reconcileApi,/async function pruneExpiredEntryTransitionAtomic\(row\)/);
  assert.match(reconcileApi,/redis\.call\('HGET', KEYS\[1\], ARGV\[1\]\)/);
  assert.match(reconcileApi,/value\['state'\]/);
  assert.match(reconcileApi,/value\['expiresAt'\]/);
  assert.match(reconcileApi,/value\['protectionClientAlgoId'\]/);
  assert.match(reconcileApi,/value\['entryClientOrderId'\]/);
  assert.match(reconcileApi,/redis\.call\('HDEL', KEYS\[1\], ARGV\[1\]\)/);
  assert.match(reconcileApi,/if \(report\.failClosed === false\)/);
  assert.match(reconcileApi,/Garbage collection is non-authoritative/);
});

test('worker marks not-started only if current watch still has same auto-entry command id',()=>{
  const start=worker.indexOf('const orphanTargets=orphanZenithCleanupOrders');
  const end=worker.indexOf('const repairTarget=missingMaxLossRepairTarget',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.match(block,/expiredEntryOrphanProtections\(data\.report\)/);
  assert.match(block,/watchedEntryConfig\(expiredEntry\.symbol\)/);
  assert.match(block,/autoEntryCommandId\(watchConfig\)===expiredEntry\.commandId/);
  assert.match(block,/watchState\.triggeredAt=0/);
  assert.match(block,/watchState\.blockedAt=Date\.now\(\)/);
  assert.match(block,/persistEntryWatchStateNow\(\)/);
});
