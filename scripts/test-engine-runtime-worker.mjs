import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

test('24/7 engine worker is provider-neutral and keeps secrets out of browser/runtime state',()=>{
  assert.ok(worker.includes("process.env.ZENITH_BASE_URL"));
  assert.ok(worker.includes("process.env.ZENITH_ENGINE_BOOTSTRAP_SECRET"));
  assert.equal(worker.includes('UPSTASH_REDIS_REST_TOKEN'),false);
  assert.equal(worker.includes('BINANCE_API_KEY'),false);
  assert.equal(worker.includes('BINANCE_API_SECRET'),false);
  assert.equal(worker.includes('localStorage'),false);
  assert.equal(worker.includes('document.'),false);
});

test('bootstrap uses dedicated Bearer secret while normal calls carry cookie plus engine instance fence',()=>{
  assert.ok(worker.includes("headers.Authorization='Bearer '+BOOTSTRAP_SECRET"));
  assert.ok(worker.includes("headers['X-Zenith-Engine-Instance']=INSTANCE_ID"));
  assert.ok(worker.includes("headers.Cookie=sessionCookie"));
  assert.ok(worker.includes("Origin:BASE_URL"));
  assert.ok(worker.includes("syncApi('engine-bootstrap'"));
  assert.ok(worker.includes("body:{instanceId:INSTANCE_ID}"));
  assert.ok(worker.includes("__Host-zenith_device"));
});

test('activation wait refreshes bootstrap before the engine instance TTL can expire',()=>{
  assert.ok(worker.includes('const ACTIVATION_BOOTSTRAP_REFRESH_MS=25000;'));
  assert.ok(worker.includes("hb.code==='MASTER_ACTIVATION_REQUIRED'"));
  assert.ok(worker.includes('Date.now()-lastBootstrapAt>=ACTIVATION_BOOTSTRAP_REFRESH_MS'));
  assert.ok(worker.includes("ENGINE_ADMIN_REENABLE_REQUIRED"));
  assert.ok(worker.includes("ENGINE_CUTOVER_REQUIRED"));
});

test('runtime-only phase asserts PANIC on real arm but keeps REAL inventory identity',()=>{
  assert.ok(worker.includes('const RUNTIME_ONLY=true;'));
  assert.ok(worker.includes("syncApi('emergency-stop'"));
  assert.ok(worker.includes("realExecutionArmed===true?'REAL':'SIMULATION'"));
  assert.ok(worker.includes("runtimeOwner:'SERVER_ENGINE'"));
  assert.equal(worker.includes('realExecutionArmed=false;\n  setStatus(\'RUNTIME_ONLY_FORCED_PANIC\''),false);
  assert.equal(worker.includes("command-next"),false);
  assert.equal(worker.includes('masterExecutionCycle'),false);
  assert.equal(worker.includes('evaluateMasterAutoProgressiveProtection'),false);
});

test('controller configuration is hash-verified in memory before ACK',()=>{
  assert.ok(worker.includes('sha256(stableStringify(state.data))'));
  assert.ok(worker.includes("'CONTROLLER_STATE_HASH_MISMATCH'"));
  assert.ok(worker.includes("syncApi('master-config-status'"));
  assert.ok(worker.includes("syncApi('master-config-ack'"));
  assert.ok(worker.includes('body:{revision:verified.revision,stateHash:verified.stateHash}'));
});

test('Binance user stream is seeded from REST, buffered, reconciled and renewed',()=>{
  assert.ok(worker.includes("binanceApi('/api/binance-user-stream-session?action=start'"));
  assert.ok(worker.includes("new WebSocket('wss://fstream.binance.com/ws/'"));
  assert.ok(worker.includes("binanceApi('/api/binance-runtime-snapshot'"));
  assert.ok(worker.includes('seedUserStreamStateFromRuntimeSnapshot'));
  assert.ok(worker.includes('const STREAM_SEED_BUFFER_MAX=1000;'));
  assert.ok(worker.includes("binanceApi('/api/binance-reconcile'"));
  assert.ok(worker.includes("action=keepalive"));
  assert.ok(worker.includes('const STREAM_KEEPALIVE_MS=45*60*1000;'));
  assert.ok(worker.includes('const STREAM_RESTART_MS=23*60*60*1000;'));
});

test('stale websocket generations cannot mutate the current runtime state',()=>{
  assert.ok(worker.includes('expectedGeneration!==streamGeneration'));
  assert.ok(worker.includes("reason:'STALE_STREAM_GENERATION'"));
  assert.ok(worker.includes('const eventGeneration=generation;'));
  assert.ok(worker.includes('processStreamPayload(payload,eventGeneration)'));
});

test('reconciliation keeps existing orphan-cleanup and protection-repair semantics',()=>{
  assert.ok(worker.includes('orphanZenithCleanupOrders(report)'));
  assert.ok(worker.includes("type:'EXEC_CLEAN_ORPHAN_PROTECTION'"));
  assert.ok(worker.includes('protectionOnlyMismatchTarget(report)'));
  assert.ok(worker.includes('markUserStreamReconciled'));
  assert.ok(worker.includes('return reconcileUserStream(true)'));
});

test('worker publishes central runtime state without simulation browser positions',()=>{
  assert.ok(worker.includes("syncApi('state'"));
  assert.ok(worker.includes('runtimeInventoryFromUserStream'));
  assert.ok(worker.includes('controllerRevision'));
  assert.ok(worker.includes('appliedRevision'));
  assert.equal(worker.includes('openPositions=clone('),false);
  assert.equal(worker.includes('zenith_final3_v3_20260921'),false);
});
