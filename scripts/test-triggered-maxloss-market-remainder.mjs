import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const execute=fs.readFileSync('api/binance-protective-execute.js','utf8');
const command=fs.readFileSync('lib/protective-command.mjs','utf8');
const reconcile=fs.readFileSync('api/binance-reconcile.js','utf8');
const protectionIntent=fs.readFileSync('lib/protective-update-intent.mjs','utf8');

test('MAX-LOSS itself remains STOP LIMIT IOC OPPONENT',()=>{
  const start=protectionIntent.indexOf("}else if(kind==='MAX_LOSS')");
  const end=protectionIntent.indexOf("}else{",start);
  const block=protectionIntent.slice(start,end);
  assert.match(block,/params\.type='STOP'/);
  assert.match(block,/params\.timeInForce='IOC'/);
  assert.match(block,/params\.priceMatch='OPPONENT'/);
  assert.match(block,/params\.reduceOnly='true'/);
  assert.doesNotMatch(block,/MARKET/);
});

test('only a confirmed triggered MAX-LOSS remainder switches to MARKET',()=>{
  const start=worker.indexOf('async function recoverTriggeredMaxLossRemainder');
  const end=worker.indexOf('async function reconcile',start);
  const block=worker.slice(start,end);
  assert.match(block,/triggeredMaxLossRemainderTargets/);
  assert.match(block,/exitMode:'REMAINDER_MARKET'/);
  assert.match(block,/recoveryReason:'TRIGGERED_MAX_LOSS_REMAINDER'/);
  assert.match(block,/clientAlgoId:target\.clientAlgoId/);
  assert.match(block,/actualOrderId:target\.actualOrderId/);
  assert.match(block,/remainderMarketClosed/);
  assert.doesNotMatch(block,/PROTECTIVE_IOC|priceMatch:target\.priceMatch|attempt:target\.nextAttempt/);
});

test('protective endpoint requires exact MAX-LOSS report proof before remainder MARKET',()=>{
  assert.match(command,/triggeredMaxLossRemainderRecoveryAllowed/);
  const start=command.indexOf('export function triggeredMaxLossRemainderRecoveryAllowed');
  const end=command.indexOf('function orphanCleanupReportScope',start);
  const block=command.slice(start,end);
  assert.match(block,/TRIGGERED_MAX_LOSS_REMAINDER/);
  assert.match(block,/REMAINDER_MARKET/);
  assert.doesNotMatch(block,/OPPONENT_5|OPPONENT_10|OPPONENT_20/);
  assert.match(execute,/!partialTargetRemainder&&!progressiveRemainderRecovery&&!maxLossRemainderRecovery&&!persistedRemainderRecovery/);
  assert.match(execute,/sourceReason==='TRIGGERED_MAX_LOSS_REMAINDER'&&maxLossRemainderRecovery!==true/);
});

test('MAX-LOSS MARKET remainder inherits restart-safe Redis continuity',()=>{
  for(const source of [execute,command,reconcile]){
    assert.match(source,/TRIGGERED_MAX_LOSS_REMAINDER/);
    assert.match(source,/zth-MAX/);
  }
  assert.match(execute,/KEY_SALE_REMAINDER_RECOVERIES/);
  assert.match(reconcile,/activeSaleRemainderRecoveries/);
  assert.match(worker,/recoverPersistedSaleRemainder/);
});
