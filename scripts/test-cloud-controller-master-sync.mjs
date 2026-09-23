import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

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
