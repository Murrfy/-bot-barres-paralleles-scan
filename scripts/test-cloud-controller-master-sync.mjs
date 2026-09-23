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
