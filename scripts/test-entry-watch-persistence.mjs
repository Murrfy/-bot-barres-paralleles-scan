import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');

function block(start,end){
  const a=sync.indexOf(start),b=sync.indexOf(end,a);
  assert.ok(a>=0&&b>a,'missing block '+start);
  return sync.slice(a,b);
}

test('entry watch persistence uses a dedicated server-owned Redis key',()=>{
  assert.match(sync,/KEY_ENGINE_ENTRY_WATCH_STATE = .*engine-entry-watch-state/);
});

test('entry watch state GET is engine-only and fenced by instance, master lease and restart authorization',()=>{
  const get=block("if (action === 'engine-entry-watch-state' && req.method === 'GET')","if (action === 'engine-entry-watch-state' && req.method === 'POST')");
  assert.match(get,/requireDevice\(req, res, \['master'\]\)/);
  assert.match(get,/device\.principal !== 'engine'/);
  assert.match(get,/KEY_ENGINE_INSTANCE/);
  assert.match(get,/KEY_MASTER_DEVICE/);
  assert.match(get,/KEY_MASTER/);
  assert.match(get,/KEY_ENGINE_AUTHORIZED/);
  assert.match(get,/ENGINE_RESTART_AUTHORIZATION_REQUIRED/);
});

test('entry watch state POST is bounded, validates identities and replaces the complete state set',()=>{
  const post=block("if (action === 'engine-entry-watch-state' && req.method === 'POST')","if (action === 'engine-protection-high-water' && req.method === 'GET')");
  assert.match(post,/keys\.length > 100/);
  assert.match(post,/64 \* 1024/);
  assert.match(post,/identity !== symbol \+ ':' \+ String\(validatedAt\) \+ ':' \+ String\(buy\)/);
  assert.match(post,/states=incoming/);
  assert.doesNotMatch(post,/previous\[key\]/);
});

test('entry watch writes are rejected if engine authorization changes',()=>{
  const post=block("if (action === 'engine-entry-watch-state' && req.method === 'POST')","if (action === 'engine-protection-high-water' && req.method === 'GET')");
  assert.match(post,/authorization\['authorizedAt'\]/);
  assert.match(post,/ENGINE_ENTRY_WATCH_AUTHORIZATION_CHANGED/);
  assert.match(post,/MASTER_LEASE_REQUIRED/);
  assert.match(post,/MASTER_SESSION_REVOKED/);
});
