import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntryProtectionPlan } from '../lib/entry-protection-plan.mjs';

const priceFilter={filterType:'PRICE_FILTER',tickSize:'0.1',minPrice:'0.1',maxPrice:'1000000'};

test('LONG entry protection is a close-all STOP_MARKET below the LIMIT entry',()=>{
  const plan=buildEntryProtectionPlan({
    commandId:'entry-long-123456',symbol:'BTCUSDT',side:'BUY',
    quantity:0.2,limitPrice:50000,maxLoss:400,priceFilter,
  });
  assert.equal(plan.direction,'LONG');
  assert.equal(plan.triggerPrice,48000);
  assert.equal(plan.actualMaxLossUsd,400);
  assert.equal(plan.algoPlan.protectionKind,'MAX_LOSS');
  assert.equal(plan.algoPlan.params.type,'STOP_MARKET');
  assert.equal(plan.algoPlan.params.side,'SELL');
  assert.equal(plan.algoPlan.params.positionSide,'BOTH');
  assert.equal(plan.algoPlan.params.closePosition,'true');
  assert.equal(plan.algoPlan.params.quantity,undefined);
  assert.equal(plan.algoPlan.params.reduceOnly,undefined);
  assert.match(plan.algoPlan.params.clientAlgoId,/^zth-MAX-[a-f0-9]{24}$/);
});

test('SHORT entry protection is above the LIMIT entry',()=>{
  const plan=buildEntryProtectionPlan({
    commandId:'entry-short-12345',symbol:'ETHUSDT',side:'SELL',
    quantity:2,limitPrice:3000,maxLoss:200,
    priceFilter:{filterType:'PRICE_FILTER',tickSize:'0.01',minPrice:'0.01',maxPrice:'1000000'},
  });
  assert.equal(plan.direction,'SHORT');
  assert.equal(plan.triggerPrice,3100);
  assert.equal(plan.actualMaxLossUsd,200);
  assert.equal(plan.algoPlan.params.side,'BUY');
});

test('entry protection never exceeds the server hard MAX-LOSS',()=>{
  assert.throws(()=>buildEntryProtectionPlan({
    commandId:'entry-loss-123456',symbol:'BTCUSDT',side:'BUY',
    quantity:0.2,limitPrice:50000,maxLoss:401,priceFilter,
  }),/MAX_LOSS_EXCEEDS_SERVER_LIMIT/);
});

test('tick rounding never makes actual loss exceed requested cap',()=>{
  const plan=buildEntryProtectionPlan({
    commandId:'entry-round-12345',symbol:'BTCUSDT',side:'BUY',
    quantity:3,limitPrice:100,maxLoss:10,
    priceFilter:{filterType:'PRICE_FILTER',tickSize:'0.1',minPrice:'0.1',maxPrice:'1000000'},
  });
  assert.ok(plan.actualMaxLossUsd<=10+1e-8);
  assert.ok(plan.triggerPrice<plan.limitPrice);
});
