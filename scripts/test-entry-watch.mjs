import test from 'node:test';
import assert from 'node:assert/strict';
import {
  entryWatchDefinition,
  entryWatchIdentity,
  evaluateEntryWatchTick,
  pruneEntryWatchStates,
} from '../lib/entry-watch.mjs';

const def=entryWatchDefinition('btcusdt',{buy:100,validatedAt:1000,armedAbove:true});

test('entry watch identity is tied to symbol, validation time and exact buy',()=>{
  assert.deepEqual(def,{symbol:'BTCUSDT',buy:100,validatedAt:1000});
  assert.equal(entryWatchIdentity(def),'BTCUSDT:1000:100');
  assert.notEqual(
    entryWatchIdentity(entryWatchDefinition('BTCUSDT',{buy:99,validatedAt:1000})),
    entryWatchIdentity(def)
  );
});

test('watch arms above buy then triggers once on downward crossing',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:1,eventTime:1100});
  assert.equal(r.action,'ARMED');
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:100,eventId:2,eventTime:1200,allowTrigger:true});
  assert.equal(r.action,'TRIGGER');
  assert.equal(r.signal.symbol,'BTCUSDT');
  assert.equal(r.signal.buy,100);
  const again=evaluateEntryWatchTick({definition:def,state:r.state,price:99,eventId:3,eventTime:1300,allowTrigger:true});
  assert.equal(again.action,'ALREADY_TRIGGERED');
  assert.equal(again.state.triggeredAt,1200);
});

test('crossing while entry is disabled is suppressed, never deferred',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:10,eventTime:2000});
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:99,eventId:11,eventTime:2100,allowTrigger:false});
  assert.equal(r.action,'SUPPRESSED');
  assert.equal(r.state.triggeredAt,0);
  assert.equal(r.state.armedAbove,false);
  const stillBelow=evaluateEntryWatchTick({definition:def,state:r.state,price:98,eventId:12,eventTime:2200,allowTrigger:true});
  assert.equal(stillBelow.action,'TRACKING');
  assert.equal(stillBelow.state.triggeredAt,0);
});

test('after suppressed crossing a fresh move above buy is required before another trigger',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:20,eventTime:3000});
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:99,eventId:21,eventTime:3100,allowTrigger:false});
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:102,eventId:22,eventTime:3200,allowTrigger:false});
  assert.equal(r.action,'ARMED');
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:100,eventId:23,eventTime:3300,allowTrigger:true});
  assert.equal(r.action,'TRIGGER');
  assert.equal(r.state.triggeredAt,3300);
});

test('duplicate or out-of-order aggTrade ids cannot retrigger state',()=>{
  const first=evaluateEntryWatchTick({definition:def,price:101,eventId:50,eventTime:4000});
  const duplicate=evaluateEntryWatchTick({definition:def,state:first.state,price:99,eventId:50,eventTime:4100,allowTrigger:true});
  assert.equal(duplicate.action,'DUPLICATE');
  assert.equal(duplicate.state.lastPrice,101);
  assert.equal(duplicate.state.triggeredAt,0);
});

test('changed validation identity resets an old triggered latch',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:60,eventTime:5000});
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:100,eventId:61,eventTime:5100,allowTrigger:true});
  assert.equal(r.state.triggeredAt,5100);
  const changed=entryWatchDefinition('BTCUSDT',{buy:95,validatedAt:6000});
  const fresh=evaluateEntryWatchTick({definition:changed,state:r.state,price:96,eventId:70,eventTime:6100});
  assert.equal(fresh.state.triggeredAt,0);
  assert.equal(fresh.state.identity,'BTCUSDT:6000:95');
});

test('seedArmed is explicit and can recover a recent validated-above starting point',()=>{
  const below=evaluateEntryWatchTick({
    definition:def,price:99,eventId:80,eventTime:7000,allowTrigger:true,seedArmed:true,
  });
  assert.equal(below.action,'TRIGGER');
  const conservative=evaluateEntryWatchTick({
    definition:def,price:99,eventId:80,eventTime:7000,allowTrigger:true,seedArmed:false,
  });
  assert.equal(conservative.action,'TRACKING');
});

test('pruning removes stale validation identities but preserves current state',()=>{
  const current=evaluateEntryWatchTick({definition:def,price:101,eventId:90,eventTime:8000}).state;
  const stale={...current,identity:'BTCUSDT:999:100'};
  assert.deepEqual(pruneEntryWatchStates({BTCUSDT:current,ETHUSDT:stale},[def]),{BTCUSDT:current});
});
