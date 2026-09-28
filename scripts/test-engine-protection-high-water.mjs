import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/zenith-sync.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

function between(startMarker,endMarker){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing source block '+startMarker);
  return source.slice(start,end);
}

const readBlock=between(
  "if (action === 'engine-protection-high-water' && req.method === 'GET')",
  "if (action === 'engine-protection-high-water' && req.method === 'POST')"
);
const writeBlock=between(
  "if (action === 'engine-protection-high-water' && req.method === 'POST')",
  "if (action === 'master-config-status' && req.method === 'GET')"
);

test('engine high-water is stored in a dedicated server state key',()=>{
  assert.ok(source.includes('KEY_ENGINE_PROTECTION_HIGH_WATER'));
  assert.ok(source.includes('engine-protection-high-water'));
});

test('high-water read is restricted to the current fenced engine MASTER',()=>{
  assert.ok(readBlock.includes("requireDevice(req, res, ['master'])"));
  assert.ok(readBlock.includes("device.principal !== 'engine'"));
  for(const required of [
    'KEY_ENGINE_INSTANCE','KEY_MASTER_DEVICE','KEY_MASTER',
    "roleAssignmentKey(PREFIX, 'master')",'KEY_ENGINE_AUTHORIZED',
    'KEY_ENGINE_PROTECTION_HIGH_WATER','currentInstance ~= ARGV[1]',
    'registered ~= ARGV[2]','lease ~= ARGV[2]','epoch ~= ARGV[3]'
  ]) assert.ok(readBlock.includes(required),required);
});

test('high-water is scoped to persistent engine authorization',()=>{
  assert.ok(readBlock.includes('authorization?.version !== 1'));
  assert.ok(readBlock.includes('authorization?.masterDeviceId'));
  assert.ok(readBlock.includes('Number(stored?.authorizationAt || 0) === authorizationAt'));
  assert.ok(readBlock.includes('entries:sameScope ? stored.entries : {}'));
  assert.ok(readBlock.includes('staleScope:Boolean(stored && !sameScope)'));
});

test('high-water write has no position-count cap and atomically rechecks authority plus authorizationAt',()=>{
  assert.equal(writeBlock.includes('keys.length > 20'),false);
  assert.equal(writeBlock.includes('ENGINE_HIGH_WATER_TOO_MANY_ENTRIES'),false);
  for(const required of [
    'A-Za-z0-9._:+-','Math.abs(value) > 1e9',
    "Buffer.byteLength(entriesRaw, 'utf8') > ENGINE_HIGH_WATER_STATE_MAX_BYTES",
    'currentInstance ~= ARGV[1]','registered ~= ARGV[2]',
    'lease ~= ARGV[2]','epoch ~= ARGV[3]',
    "authorization['masterDeviceId']","authorization['authorizedAt']",
    'ENGINE_HIGH_WATER_AUTHORIZATION_CHANGED'
  ]) assert.ok(writeBlock.includes(required),required);
  assert.ok(writeBlock.indexOf("authorization['authorizedAt']") < writeBlock.indexOf("redis.call('SET', KEYS[6], encoded)"));
});

test('server-side high-water merge is monotonic for active position keys and prunes absent keys',()=>{
  assert.ok(writeBlock.includes("local previousRaw = redis.call('GET', KEYS[6])"));
  assert.ok(writeBlock.includes("local oldValue = tonumber(previous[key])"));
  assert.ok(writeBlock.includes("if oldValue and oldValue > nextValue then nextValue = oldValue end"));
  assert.ok(writeBlock.includes("local merged = {}"));
  assert.ok(writeBlock.includes("for key, value in pairs(incoming) do"));
  assert.ok(writeBlock.includes("entries=merged"));
  assert.equal(writeBlock.includes("for key, value in pairs(previous) do"),false);
});

test('high-water API never accepts ADMIN or pairing secrets',()=>{
  assert.equal(readBlock.includes('adminCode'),false);
  assert.equal(writeBlock.includes('adminCode'),false);
  assert.equal(readBlock.includes('pairingCode'),false);
  assert.equal(writeBlock.includes('pairingCode'),false);
});

test('worker records Redis high-water updatedAt and refreshes it after successful persistence',()=>{
  assert.ok(worker.includes('highWaterUpdatedAt:0'));
  assert.ok(worker.includes('autoProtection.highWaterUpdatedAt=n(result.data.updatedAt,0)'));
  assert.ok(worker.includes('autoProtection.highWaterUpdatedAt=n(result.data.updatedAt,Date.now())'));
  assert.ok(worker.includes('autoProtection.highWaterUpdatedAt=0'));
});

test('restart lifecycle migration requires persisted proof newer than the Binance position update',()=>{
  const start=worker.indexOf('function migrateLegacyAutoHighWaterKey(position)');
  const end=worker.indexOf('function observedLinearPnl',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.ok(block.includes('n(autoProtection.highWaterUpdatedAt,0)>=lifecycle'));
  assert.ok(block.includes('candidateKeys.length===1'));
  assert.ok(block.includes("log('AUTO_HIGH_WATER_RESTART_CONTINUITY'"));
});

test('ACCOUNT_UPDATE prunes obsolete lifecycle keys and persists high-water before reconciliation invalidation',()=>{
  const start=worker.indexOf('async function processStreamPayload(payload)');
  const end=worker.indexOf('async function seedStream',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  const account=block.indexOf("String(result.kind||'')==='ACCOUNT'");
  const prune=block.indexOf('pruneAutoHighWaterEntries()',account);
  const save=block.indexOf('await persistAutoHighWaterNow()',prune);
  const invalidate=block.indexOf('markUserStreamNeedsReconciliation',save);
  assert.ok(account>=0&&prune>account&&save>prune&&invalidate>save);
});

test('high-water pruning uses lifecycle-only active keys, so quantity changes do not erase the same position memory',()=>{
  const keyStart=worker.indexOf('function autoPositionKey(position)');
  const keyEnd=worker.indexOf('function migrateLegacyAutoHighWaterKey',keyStart);
  const keyBlock=worker.slice(keyStart,keyEnd);
  assert.ok(keyBlock.includes('return `${symbol}:${direction}:${lifecycle}`'));
  assert.equal(keyBlock.includes('qty'),false);
  assert.equal(keyBlock.includes('entry='),false);

  const pruneStart=worker.indexOf('function pruneAutoHighWaterEntries()');
  const pruneEnd=worker.indexOf('async function pruneAutoHighWater()',pruneStart);
  const pruneBlock=worker.slice(pruneStart,pruneEnd);
  assert.ok(pruneBlock.includes('.map(autoPositionKey)'));
});
