import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/zenith-sync.js','utf8');

function block(startMarker,endMarker){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing block '+startMarker);
  return source.slice(start,end);
}

test('auth counters use one atomic Redis EVAL for INCR plus EXPIRE',()=>{
  const helper=block('async function incrementWithExpiry','async function pairRateAllowed');
  assert.ok(helper.includes("redis(['EVAL'"));
  assert.ok(helper.includes("redis.call('INCR', KEYS[1])"));
  assert.ok(helper.includes("redis.call('EXPIRE', KEYS[1], ARGV[1])"));
});

test('pair and controller replacement rate limits use the atomic helper',()=>{
  const pair=block('async function pairRateAllowed','async function controllerReplacementRateAllowed');
  const replacement=block('async function controllerReplacementRateAllowed','function masterAdminFailureKey');
  for(const [name,src] of [['pair',pair],['replacement',replacement]]){
    assert.ok(src.includes('incrementWithExpiry'),name+' must use atomic counter');
    assert.equal(src.includes("redis(['INCR'"),false,name+' must not use split INCR');
    assert.equal(src.includes("redis(['EXPIRE'"),false,name+' must not use split EXPIRE');
  }
});

test('MASTER admin failure lock uses the same atomic counter',()=>{
  const admin=block('async function verifyMasterAdminCode','function normalizeReplacementCode');
  assert.ok(admin.includes('incrementWithExpiry(key, MASTER_ADMIN_LOCK_SECONDS)'));
  assert.equal(admin.includes("redis(['INCR', key])"),false);
  assert.equal(admin.includes("redis(['EXPIRE', key"),false);
});


test('pairing and controller replacement also enforce global anti-botnet ceilings',()=>{
  assert.ok(source.includes('const PAIR_GLOBAL_RATE_LIMIT = 30;'));
  assert.ok(source.includes('const CONTROLLER_REPLACEMENT_GLOBAL_RATE_LIMIT = 30;'));

  const pair=block('async function pairRateAllowed','async function controllerReplacementRateAllowed');
  assert.ok(pair.includes(':pair-rate:global:'));
  assert.ok(pair.includes('globalCount <= PAIR_GLOBAL_RATE_LIMIT'));
  assert.ok((pair.match(/incrementWithExpiry\(/g)||[]).length >= 2);

  const replacement=block('async function controllerReplacementRateAllowed','function masterAdminFailureKey');
  assert.ok(replacement.includes(':controller-replacement-rate:global:'));
  assert.ok(replacement.includes('globalCount <= CONTROLLER_REPLACEMENT_GLOBAL_RATE_LIMIT'));
  assert.ok((replacement.match(/incrementWithExpiry\(/g)||[]).length >= 2);
});
