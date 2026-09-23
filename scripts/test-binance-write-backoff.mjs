import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BINANCE_WRITE_BACKOFF_KEY,
  binanceBackoffSecondsFromError,
  readBinanceWriteBackoff,
  registerBinanceWriteBackoff,
} from '../lib/binance-write-backoff.mjs';

function fakeRedis(){
  const store=new Map();
  return async command=>{
    const [op,key,...args]=command;
    if(op==='GET')return store.get(key)??null;
    if(op==='SET'){
      store.set(key,String(args[0]));
      return 'OK';
    }
    if(op==='DEL'){
      const had=store.delete(key);
      return had?1:0;
    }
    throw new Error('UNSUPPORTED_REDIS_COMMAND:'+op);
  };
}

test('429 uses Retry-After and 418 has a conservative fallback',()=>{
  assert.equal(binanceBackoffSecondsFromError({status:429,retryAfterSeconds:23}),23);
  assert.equal(binanceBackoffSecondsFromError({status:429}),60);
  assert.equal(binanceBackoffSecondsFromError({status:418}),300);
  assert.equal(binanceBackoffSecondsFromError({status:500}),0);
});

test('shared Binance write backoff blocks until its deadline then clears',async()=>{
  const redis=fakeRedis();
  const now=1_700_000_000_000;
  const registered=await registerBinanceWriteBackoff(redis,{status:429,retryAfterSeconds:30},now);
  assert.equal(registered.active,true);
  assert.equal(registered.retryAfterSeconds,30);
  assert.equal(registered.until,now+30_000);

  const active=await readBinanceWriteBackoff(redis,now+5_000);
  assert.equal(active.active,true);
  assert.equal(active.retryAfterSeconds,25);
  assert.equal(active.status,429);

  const expired=await readBinanceWriteBackoff(redis,now+31_000);
  assert.equal(expired.active,false);
  assert.equal(await redis(['GET',BINANCE_WRITE_BACKOFF_KEY]),null);
});
