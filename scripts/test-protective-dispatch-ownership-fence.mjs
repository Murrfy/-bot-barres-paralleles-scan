import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const protective=fs.readFileSync('api/binance-protective-execute.js','utf8');
const update=fs.readFileSync('api/binance-protective-update-execute.js','utf8');

function block(source,startNeedle,endNeedle){
  const start=source.indexOf(startNeedle);
  const end=source.indexOf(endNeedle,start);
  assert.ok(start>=0&&end>start,`block missing: ${startNeedle}`);
  return source.slice(start,end);
}

const protectiveGate=block(
  protective,
  'async function finalProtectiveDispatchGate',
  'export default async function handler'
);
const updateGate=block(
  update,
  'async function finalProtectiveDispatchGate',
  'async function finalOrphanCleanupGate'
);
const orphanGate=block(
  update,
  'async function finalOrphanCleanupGate',
  'function runtimePosition'
);

test('protective writes revalidate MASTER ownership, lease, mode, arm and role epoch',()=>{
  for(const gate of [protectiveGate,updateGate]){
    for(const required of [
      "if registered ~= ARGV[1] then return -1 end",
      "if lease ~= ARGV[1] then return -2 end",
      "if mode ~= 'RUNNING' and mode ~= 'PAUSE_PENDING' then return -3 end",
      "if arm ~= ARGV[3] then return -4 end",
      "if roleEpoch ~= ARGV[2] then return -5 end",
      "roleAssignmentKey(PREFIX,'master')",
    ]) assert.ok(gate.includes(required),required);
  }
});

test('protective final gate deliberately remains available during PANIC and PAUSE_PENDING',()=>{
  for(const gate of [protectiveGate,updateGate]){
    assert.ok(gate.includes("'PAUSE_PENDING'"));
    assert.equal(gate.includes('KEY_EMERGENCY_STOP'),false);
    assert.equal(gate.includes('panic'),false);
  }
});

test('protective execute gates both entry cancellation and full-position close before Binance',()=>{
  const calls=[...protective.matchAll(/finalProtectiveDispatchGate\(/g)].map(m=>m.index);
  assert.equal(calls.length,3,'expected helper plus two dispatch calls');
  const cancelWrite=protective.indexOf('const result=await cancelEntryOrderIdempotent({');
  const closeWrite=protective.indexOf('const result=await placeStandardOrderIdempotent({');
  assert.ok(calls.some(i=>i<cancelWrite&&i>protective.indexOf("if(type==='EXEC_CANCEL_ENTRY')")));
  assert.ok(calls.some(i=>i<closeWrite&&i>protective.indexOf('const livePosition=runtimePosition')));
  assert.ok(protective.includes("'PROTECTIVE_DISPATCH_BLOCKED'"));
});

test('protective update gates every normal Binance cancel/place operation',()=>{
  const calls=[...update.matchAll(/finalProtectiveDispatchGate\(/g)].map(m=>m.index);
  assert.equal(calls.length,5,'expected helper plus four normal dispatch calls');
  for(const writer of [
    'result=await cancelReduceOnlyOrderIdempotent({',
    'result=await placeStandardOrderIdempotent({',
    'result=await cancelAlgoOrderIdempotent({',
    'result=await placeAlgoOrderIdempotent({',
  ]){
    const pos=update.indexOf(writer);
    assert.ok(pos>0,writer);
    assert.ok(calls.some(i=>i<pos&&pos-i<1400),`gate must immediately precede ${writer}`);
  }
  assert.ok(update.includes("'PROTECTIVE_DISPATCH_BLOCKED'"));
});

test('orphan cleanup has its own ownership fence without requiring arm or RUNNING',()=>{
  for(const required of [
    "if registered ~= ARGV[1] then return -1 end",
    "if lease ~= ARGV[1] then return -2 end",
    "if roleEpoch ~= ARGV[2] then return -3 end",
  ]) assert.ok(orphanGate.includes(required),required);
  assert.equal(orphanGate.includes('KEY_REAL_EXECUTION_ARMED'),false);
  assert.equal(orphanGate.includes('KEY_MASTER_MODE'),false);
  const call=update.indexOf('const cleanupGate=await finalOrphanCleanupGate(');
  const standard=update.indexOf('result=await cancelReduceOnlyOrderIdempotent({');
  const algo=update.indexOf('result=await cancelAlgoOrderIdempotent({');
  assert.ok(call>0&&call<standard&&call<algo);
  assert.ok(update.includes("'ORPHAN_CLEANUP_DISPATCH_BLOCKED'"));
});

test('both protective APIs carry the verified MASTER role epoch from authentication',()=>{
  for(const source of [protective,update]){
    assert.ok(source.includes("return { ...device, roleIssuedAt: String(issuedAt || '') }"));
  }
  assert.ok(update.includes("armRaw:String(armRaw||'')"));
});
