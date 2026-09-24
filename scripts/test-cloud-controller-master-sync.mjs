import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const syncSource=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');

test('iPhone controller state is synchronized through Zenith cloud API, not LAN',()=>{
  assert.match(html,/fetch\('\/api\/zenith-sync\?action=controller-state'/);
  assert.match(html,/masterRuntimeApi\('master-config-status'\)/);
  assert.match(html,/masterRuntimeApi\('master-config-ack','POST'/);
});

test('legacy array-shaped controller records are normalized before cloud sync',()=>{
  assert.match(html,/function normalizeRecordBlock\(value\)/);
  assert.match(html,/tokenSettings=normalizeRecordBlock\(x\.tokenSettings\)/);
  assert.match(html,/manualTokens=normalizeRecordBlock\(x\.manualTokens\)/);
  assert.match(html,/validated=normalizeRecordBlock\(x\.validated\)/);
  assert.match(html,/tokenSettings:clone\(normalizeRecordBlock\(tokenSettings\)\)/);
  assert.match(html,/manualTokens:clone\(normalizeRecordBlock\(manualTokens\)\)/);
  assert.match(html,/validated:clone\(normalizeRecordBlock\(validated\)\)/);
});

test('controller self-heals an internally invalid remote state hash using the authenticated iPhone payload',()=>{
  assert.match(html,/const remoteStateHash=remoteState\?await sha256Hex\(stableStringify\(remoteState\?\.data\|\|\{\}\)\):''/);
  assert.match(html,/String\(remoteState\?\.stateHash\|\|''\)!==remoteStateHash/);
  assert.match(html,/JSON\.stringify\(\{expectedRevision:remoteRevision,data:payload\}\)/);
  assert.match(html,/localStorage\.setItem\(ZENITH_CONTROLLER_REV_KEY,String\(Math\.max\(0,n\(repaired\.state\.revision,remoteRevision\)\)\)\)/);
});

test('controller-to-MASTER critical sync has no same-WiFi dependency',()=>{
  const critical=['controller-state','master-config-status','master-config-ack','command','command-next','command-ack'];
  for(const action of critical) assert.ok(html.includes(action),action);
  assert.doesNotMatch(html,/RTCPeerConnection|BroadcastChannel\(/);
  assert.doesNotMatch(html,/https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.|10\.\d+\.|172\.(?:1[6-9]|2\d|3[01])\.)/);
});


test('controller state writes are rate-limited before revision mutation',()=>{
  const start=syncSource.indexOf("if (action === 'controller-state' && req.method === 'POST')");
  const end=syncSource.indexOf("if (action === 'state' && req.method === 'GET')",start);
  assert.ok(start>=0&&end>start,'controller-state POST block missing');
  const block=syncSource.slice(start,end);
  assert.ok(block.includes('CONTROLLER_STATE_WRITE_RATE_LIMIT'));
  assert.ok(block.includes('controllerStateWriteRateAllowed(device.deviceId)'));
  assert.ok(block.includes("res.setHeader('Retry-After'"));
  assert.ok(block.indexOf('controllerStateWriteRateAllowed(device.deviceId)') < block.indexOf('const expectedRevision'));
  assert.ok(block.indexOf("'CONTROLLER_STATE_WRITE_RATE_LIMIT'") < block.indexOf('const updatedAt = Date.now()'));
});
