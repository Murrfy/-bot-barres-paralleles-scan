import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

test('worker is provider-neutral and explicitly disabled until enabled',()=>{
  assert.ok(worker.includes("const WORKER_ENABLED=process.env.ZENITH_ENGINE_WORKER_ENABLED==='1';"));
  const main=worker.slice(worker.indexOf('async function main(){'));
  const gate=main.indexOf('if(!WORKER_ENABLED)');
  const bootstrap=main.indexOf('await bootstrapUntilReady()');
  assert.ok(gate>=0&&bootstrap>gate);
  assert.ok(worker.includes("log('DISABLED'"));
  assert.equal(worker.includes('render.com'),false);
  assert.equal(worker.includes('railway.app'),false);
  assert.equal(worker.includes('fly.io'),false);
});

test('worker owns no Binance or Redis credentials',()=>{
  for(const forbidden of [
    'BINANCE_API_KEY',
    'BINANCE_API_SECRET',
    'BINANCE_TRADING_API_KEY',
    'BINANCE_TRADING_API_SECRET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_TOKEN',
  ]) assert.equal(worker.includes(forbidden),false,forbidden+' must stay out of the worker');
  assert.equal(worker.includes('https://fapi.binance.com'),false);
  assert.ok(worker.includes('wss://fstream.binance.com/private/ws?listenKey='));
  assert.ok(worker.includes('&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/ALGO_UPDATE/listenKeyExpired'));
  assert.equal(worker.includes("new WebSocket('wss://fstream.binance.com/ws/"),false);
});

test('every authenticated server request carries the engine instance fence and session cookie',()=>{
  assert.ok(worker.includes("'X-Zenith-Engine-Instance':instanceId"));
  assert.ok(worker.includes('if(auth&&sessionCookie)headers.Cookie=sessionCookie'));
  assert.ok(worker.includes("__Host-zenith_device"));
  assert.ok(worker.includes("Origin:new URL(base).origin"));
});

test('worker bootstraps only through the existing engine principal API',()=>{
  assert.ok(worker.includes("syncApi('engine-bootstrap'"));
  assert.ok(worker.includes('body:{bootstrapSecret:BOOTSTRAP_SECRET,instanceId}'));
  assert.ok(worker.includes('ZENITH_ENGINE_BOOTSTRAP_SECRET'));
  assert.equal(worker.includes('ZENITH_MASTER_PAIRING_CODE'),false);
  assert.equal(worker.includes('ZENITH_MASTER_ADMIN_CODE'),false);
  assert.ok(worker.includes("'ENGINE_CUTOVER_REQUIRED'"));
  assert.ok(worker.includes("'ENGINE_ADMIN_REENABLE_REQUIRED'"));
});

test('worker ports the permanent MASTER runtime out of the browser',()=>{
  for(const required of [
    "syncApi('master-heartbeat'",
    "syncApi('master-config-status'",
    "syncApi('master-config-ack'",
    "binanceApi('/api/binance-runtime-snapshot'",
    "binanceApi('/api/binance-reconcile'",
    "userStreamApi('start','POST')",
    "userStreamApi('keepalive','POST')",
    "syncApi('command-next'",
    "commandDisposition('command-ack'",
    "commandDisposition('command-fail'",
    "commandDisposition('command-requeue'",
  ]) assert.ok(worker.includes(required),required);
  assert.equal(worker.includes('document.hidden'),false);
  assert.equal(worker.includes('localStorage'),false);
});

test('worker reuses the hardened user-stream, inventory, dispatch and close modules',()=>{
  for(const imported of [
    "../lib/user-stream-state.mjs",
    "../lib/master-runtime-inventory.mjs",
    "../lib/user-stream-seed.mjs",
    "../lib/master-command-dispatch.mjs",
    "../lib/protective-close-state.mjs",
  ]) assert.ok(worker.includes(imported),imported);
  assert.ok(worker.includes('runtimeInventoryFromUserStream'));
  assert.ok(worker.includes('buildMasterCommandDispatch'));
  assert.ok(worker.includes('PROTECTIVE_CLOSE_ATTEMPTS'));
});

test('runtime publication never mixes browser simulation positions into server REAL inventory',()=>{
  const start=worker.indexOf('function runtimeSnapshot(){');
  const end=worker.indexOf('\n}',start);
  const block=worker.slice(start,end+2);
  assert.ok(block.includes('openPositions:[]'));
  assert.ok(block.includes('binancePositions:'));
  assert.ok(block.includes('binanceOrders:'));
  assert.ok(block.includes("const executionMode=runtime.realExecutionArmed?'REAL':'SIMULATION';"));
});

test('command execution stays fail-closed on ambiguity and requires stream readiness',()=>{
  assert.ok(worker.includes('masterExecutionEligible({'));
  assert.ok(worker.includes('userStreamReady:userStreamReady(stream.state)'));
  assert.ok(worker.includes("if(wrote||ambiguous)"));
  assert.ok(worker.includes("'AMBIGUOUS_'+reason"));
  assert.ok(worker.includes('awaitReconciliation()'));
  assert.ok(worker.includes('PROTECTIVE_CLOSE_ATTEMPTS'));
});

test('automatic progressive protection is deliberately not claimed as migrated yet',()=>{
  assert.equal(worker.includes("../lib/master-auto-protection.mjs"),false);
  assert.ok(worker.includes('autoProtectionMoved:false'));
});
