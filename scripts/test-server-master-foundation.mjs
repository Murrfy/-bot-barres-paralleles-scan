import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const session=fs.readFileSync('lib/device-session.mjs','utf8');
const worker=fs.readFileSync('server/zenith-master-worker.mjs','utf8');
const apiFiles=[
  'api/binance-user-stream-session.js',
  'api/binance-runtime-snapshot.js',
  'api/binance-reconcile.js',
  'api/binance-entry-preflight.js',
  'api/binance-entry-execute.js',
  'api/binance-protective-execute.js',
  'api/binance-protective-update-execute.js',
];

function between(source,startMarker,endMarker){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing block '+startMarker);
  return source.slice(start,end);
}

test('server MASTER sessions are fenced by the current worker instance',()=>{
  assert.ok(session.includes('export function serverMasterLeaseKey'));
  assert.ok(session.includes("record?.deviceKind || '') !== 'server-master'"));
  assert.ok(session.includes("String(leaseRaw || '') === instanceId"));
  for(const file of apiFiles){
    const source=fs.readFileSync(file,'utf8');
    assert.ok(source.includes('serverMasterLeaseKey'),file+' missing server lease key');
    assert.ok(source.includes('serverMasterInstanceActive'),file+' missing server instance fence');
  }
  const verify=between(sync,'async function verifyRoleDevice','async function roleDeviceId');
  assert.ok(verify.includes('serverMasterInstanceActive(device, serverInstance)'));
});

test('server bootstrap requires strong secret, assigned role and live instance lease',()=>{
  const block=between(sync,"if (action === 'server-master-bootstrap'","if (action === 'controller-replacement-authorize'");
  assert.ok(block.includes('SERVER_MASTER_BOOTSTRAP_SECRET.length < 32'));
  assert.ok(block.includes("'SERVER_MASTER_ROLE_NOT_ASSIGNED'"));
  assert.ok(block.includes("'SERVER_MASTER_INSTANCE_LEASE_REQUIRED'"));
  assert.ok(block.includes('KEY_SERVER_MASTER_INSTANCE'));
  assert.ok(block.includes("deviceKind: 'server-master'"));
  assert.ok(block.includes('workerInstanceId: instanceId'));
  assert.ok(block.includes('setDeviceSessionCookie(res, token)'));
  assert.ok(block.includes("kind: 'SERVER_MASTER_SESSION_BOOTSTRAPPED'"));
  assert.equal(block.includes('bootstrapSecret,'),false,'bootstrap secret must not be written into audit/session payloads');
});

test('migration from device MASTER to server is fail-closed and drains real activity first',()=>{
  const block=between(sync,"if (action === 'master-migrate-to-server'","if (action === 'master-authorize'");
  for(const required of [
    'SERVER_MASTER_INSTANCE_OFFLINE',
    'MASTER_MUST_BE_PAUSED',
    'EMERGENCY_STOP_MUST_BE_ACTIVE',
    'PENDING_COMMAND',
    'PROCESSING_COMMAND',
    'USER_STREAM_MUTATION_IN_FLIGHT',
    'ACTIVE_POSITION',
    'OPEN_ORDER',
    'fetchLiveBinanceActivity()',
    "kind:'MASTER_MIGRATED_TO_SERVER'",
  ]){
    assert.ok(block.includes(required),'migration missing '+required);
  }
  const liveCheck=block.indexOf('fetchLiveBinanceActivity()');
  const roleWrite=block.indexOf("redis.call('SET', KEYS[9], ARGV[4])");
  assert.ok(liveCheck>=0&&roleWrite>liveCheck,'server role swap must follow live Binance drain check');
  assert.ok(block.includes("redis.call('DEL', KEYS[17])"),'real execution arm must be cleared during migration');
});

test('worker uses a single-instance Redis lease and stops on lease loss',()=>{
  assert.ok(worker.includes("['SET',INSTANCE_KEY,instanceId,'EX',String(LEASE_TTL_SECONDS),'NX']"));
  assert.ok(worker.includes("if current ~= ARGV[1] then return 0 end"));
  assert.ok(worker.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])"));
  assert.ok(worker.includes('SERVER_MASTER_INSTANCE_LEASE_LOST'));
  assert.ok(worker.includes("await shutdown(2)"));
  assert.ok(worker.includes("process.on('SIGTERM'"));
});

test('worker foundation only owns authority heartbeat and config sync, not trading execution yet',()=>{
  assert.ok(worker.includes("api('server-master-bootstrap'"));
  assert.ok(worker.includes("api('master-heartbeat'"));
  assert.ok(worker.includes("api('master-config-status'"));
  assert.ok(worker.includes("api('master-config-ack'"));
  assert.equal(worker.includes('BINANCE_API_KEY'),false);
  assert.equal(worker.includes('BINANCE_TRADING_API_KEY'),false);
  assert.equal(worker.includes('binance-entry-execute'),false);
  assert.equal(worker.includes('binance-protective-execute'),false);
});
