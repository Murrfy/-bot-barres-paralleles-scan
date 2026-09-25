import test from 'node:test';
import assert from 'node:assert/strict';
import {
  entryWatchDefinition,entryWatchIdentity,evaluateEntryWatchTick,pruneEntryWatchStates,
} from '../lib/entry-watch.mjs';

const def=entryWatchDefinition('btcusdt',{buy:100,validatedAt:1000,armedAbove:true});

test('identity is tied to symbol, validation time and exact buy',()=>{
  assert.deepEqual(def,{symbol:'BTCUSDT',buy:100,validatedAt:1000});
  assert.equal(entryWatchIdentity(def),'BTCUSDT:1000:100');
});

test('watch arms above buy then triggers once on downward crossing',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:1,eventTime:1100});
  assert.equal(r.action,'ARMED');
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:100,eventId:2,eventTime:1200,allowTrigger:true});
  assert.equal(r.action,'TRIGGER');
  assert.equal(r.state.triggeredAt,1200);
  assert.equal(r.signal.limitPrice,100);
  assert.equal(r.signal.delayedCurrentPrice,false);
  assert.equal(
    evaluateEntryWatchTick({definition:def,state:r.state,price:99,eventId:3,eventTime:1300,allowTrigger:true}).action,
    'ALREADY_TRIGGERED'
  );
});

test('crossing without a free real slot enters a persistent 50-second pending window',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:10,eventTime:2000});
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:99,eventId:11,eventTime:2100,allowTrigger:false});
  assert.equal(r.action,'PENDING');
  assert.equal(r.state.pendingUntil,52100);
  assert.equal(r.state.triggeredAt,0);

  r=evaluateEntryWatchTick({definition:def,state:r.state,price:103,eventId:12,eventTime:3000,allowTrigger:true});
  assert.equal(r.action,'TRIGGER');
  assert.equal(r.state.pendingUntil,0);
  assert.equal(r.state.triggeredAt,3000);
  assert.equal(r.signal.limitPrice,103);
  assert.equal(r.signal.observedPrice,103);
  assert.equal(r.signal.delayedCurrentPrice,true);
});

test('pending window expires instead of buying late',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:20,eventTime:4000});
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:99,eventId:21,eventTime:4100,allowTrigger:false});
  const expired=evaluateEntryWatchTick({
    definition:def,state:r.state,price:99,eventId:22,eventTime:54101,allowTrigger:true
  });
  assert.equal(expired.action,'EXPIRED');
  assert.ok(expired.state.blockedAt>0);
  assert.equal(expired.state.triggeredAt,0);
});

test('duplicate aggTrade ids cannot retrigger state',()=>{
  const first=evaluateEntryWatchTick({definition:def,price:101,eventId:50,eventTime:6000});
  const duplicate=evaluateEntryWatchTick({definition:def,state:first.state,price:99,eventId:50,eventTime:6100,allowTrigger:true});
  assert.equal(duplicate.action,'DUPLICATE');
  assert.equal(duplicate.state.lastPrice,101);
});

test('changed validation identity resets trigger and pending latches',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:60,eventTime:7000});
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:100,eventId:61,eventTime:7100,allowTrigger:true});
  const changed=entryWatchDefinition('BTCUSDT',{buy:95,validatedAt:8000});
  const fresh=evaluateEntryWatchTick({definition:changed,state:r.state,price:96,eventId:70,eventTime:8100});
  assert.equal(fresh.state.triggeredAt,0);
  assert.equal(fresh.state.pendingUntil,0);
  assert.equal(fresh.state.identity,'BTCUSDT:8000:95');
});

test('REST fallback cannot erase exact aggTrade cursor',()=>{
  let r=evaluateEntryWatchTick({definition:def,price:101,eventId:120,eventTime:9000});
  r=evaluateEntryWatchTick({definition:def,state:r.state,price:102,eventId:-1,eventTime:9500});
  assert.equal(r.state.lastAggId,120);
  assert.equal(r.state.lastAggTime,9000);
  assert.equal(r.state.lastPrice,102);
});

test('pruning removes stale validation identities',()=>{
  const current=evaluateEntryWatchTick({definition:def,price:101,eventId:90,eventTime:10000}).state;
  const stale={...current,identity:'BTCUSDT:999:100'};
  assert.deepEqual(pruneEntryWatchStates({BTCUSDT:current,ETHUSDT:stale},[def]),{BTCUSDT:current});
});
