import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  evaluateEntryTransitionReconciliation,
} from '../lib/entry-transition.mjs';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

const now=2_000_000;
const record={
  version:1,state:'ENTRY_SUBMITTED',commandId:'entry-BTCUSDT-12345678',
  symbol:'BTCUSDT',side:'BUY',direction:'LONG',quantity:0.2,limitPrice:50000,maxLossUsd:400,
  protectionTriggerPrice:48000,protectionClientAlgoId:'zth-MAX-abcdef123456789012345678',
  entryClientOrderId:'zth-ENT-abcdef123456789012345678',
  createdAt:now-121000,expiresAt:now-1000,validatedAt:now-121000,
  controllerRevision:14,masterDeviceId:'zenith-server-engine-v1',masterRoleEpoch:'123',
  engineInstanceId:'engine-instance-test',
};
const protection={
  orderClass:'ALGO',symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',
  timeInForce:'IOC',closePosition:false,reduceOnly:true,origQty:'0.2',priceMatch:'OPPONENT',triggerPrice:'48000',
  clientAlgoId:'zth-MAX-abcdef123456789012345678'
};
const entry={
  orderClass:'STANDARD',symbol:'BTCUSDT',side:'BUY',positionSide:'BOTH',type:'LIMIT',
  timeInForce:'GTC',reduceOnly:false,origQty:'0.2',price:'50000',
  clientOrderId:'zth-ENT-abcdef123456789012345678'
};

test('expired transition stays protective only while the exact pending entry is still open',()=>{
  const result=evaluateEntryTransitionReconciliation({
    transitions:[record],actualOrders:[entry,protection],actualPositions:[],now,
  });
  assert.equal(result.expired.length,1);
  assert.equal(result.active.length,1);
  assert.equal(result.active[0].expiredPendingEntry,true);
  assert.deepEqual(result.missingProtections,[]);
  assert.deepEqual(result.missingEntries,[]);
  assert.equal(result.allowedOrderIdentities.has('BTCUSDT:client:'+entry.clientOrderId),true);
  assert.equal(result.allowedOrderIdentities.has('BTCUSDT:algo-client:'+protection.clientAlgoId),true);
});

test('expired exact pending entry with missing MAX-LOSS is still fenced for cancel-first recovery',()=>{
  const result=evaluateEntryTransitionReconciliation({
    transitions:[record],actualOrders:[entry],actualPositions:[],now,
  });
  assert.equal(result.active.length,1);
  assert.deepEqual(result.missingProtections,['BTCUSDT:LONG']);
  assert.equal(result.allowedOrderIdentities.has('BTCUSDT:client:'+entry.clientOrderId),true);
});

test('expired transition without its exact entry grants no protection exemption and cannot re-open entry',()=>{
  const protectionOnly=evaluateEntryTransitionReconciliation({
    transitions:[record],actualOrders:[protection],actualPositions:[],now,
  });
  assert.equal(protectionOnly.active.length,0);
  assert.deepEqual(protectionOnly.missingEntries,[]);
  assert.equal(protectionOnly.allowedOrderIdentities.has('BTCUSDT:algo-client:'+protection.clientAlgoId),false);

  const empty=evaluateEntryTransitionReconciliation({
    transitions:[record],actualOrders:[],actualPositions:[],now,
  });
  assert.equal(empty.active.length,0);
  assert.equal(empty.expired.length,1);
});

test('canceling an unprotected pending entry marks the watched token as not started',()=>{
  const start=worker.indexOf('async function cancelPendingEntriesMissingPreparedProtection');
  const end=worker.indexOf('async function repairMissingMaxLoss',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.match(block,/watchState\.triggeredAt=0/);
  assert.match(block,/watchState\.pendingUntil=0/);
  assert.match(block,/watchState\.blockedAt=Date\.now\(\)/);
  assert.match(block,/persistEntryWatchStateNow\(\)/);
});
