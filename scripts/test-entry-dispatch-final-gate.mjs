import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/binance-entry-execute.js','utf8');

const masterStart=source.indexOf('async function requireCurrentMaster(req)');
const masterEnd=source.indexOf('async function entryExecutionRateAllowed',masterStart);
assert.ok(masterStart>=0&&masterEnd>masterStart,'requireCurrentMaster block missing');
const masterBlock=source.slice(masterStart,masterEnd);

const stateStart=source.indexOf('async function readExecutionState()');
const stateEnd=source.indexOf('function entryReadinessReason',stateStart);
assert.ok(stateStart>=0&&stateEnd>stateStart,'entry state/gate block missing');
const stateBlock=source.slice(stateStart,stateEnd);

const handlerStart=source.indexOf('export default async function handler(req,res)');
assert.ok(handlerStart>=0,'entry handler missing');
const handler=source.slice(handlerStart);

test('entry MASTER authentication carries the verified role epoch into the final dispatch gate',()=>{
  assert.ok(masterBlock.includes("roleAssignmentKey(PREFIX,'master')"));
  assert.ok(masterBlock.includes('deviceRoleAssignmentActive(device,issuedAt)'));
  assert.ok(masterBlock.includes("return { ...device, roleIssuedAt: String(issuedAt || '') }"));
});

test('execution state preserves exact arm bytes for compare-and-dispatch fencing',()=>{
  assert.ok(stateBlock.includes("armRaw:String(armRaw||'')"));
});

test('final entry dispatch gate atomically revalidates MASTER, lease, mode, PANIC, arm and epoch',()=>{
  for(const required of [
    'async function finalEntryDispatchGate',
    "if registered ~= ARGV[1] then return -1 end",
    "if lease ~= ARGV[1] then return -2 end",
    "if mode ~= 'RUNNING' then return -3 end",
    "if panic ~= '0' then return -4 end",
    "if arm ~= ARGV[3] then return -5 end",
    "if roleEpoch ~= ARGV[2] then return -6 end",
    "'EVAL',script,'6'",
    'KEY_MASTER_DEVICE',
    'KEY_MASTER',
    'KEY_MASTER_MODE',
    'KEY_EMERGENCY_STOP',
    'KEY_REAL_EXECUTION_ARMED',
    "roleAssignmentKey(PREFIX,'master')",
  ]) assert.ok(stateBlock.includes(required),required);
});

test('no real entry reaches Binance unless the final gate commits first',()=>{
  const gateCall=handler.indexOf('const dispatchGate=await finalEntryDispatchGate(');
  const blocked=handler.indexOf("'ENTRY_EXECUTION_COMMIT_BLOCKED'");
  const write=handler.indexOf('const result=await placeStandardOrderIdempotent({');
  assert.ok(gateCall>=0,'final entry gate call missing');
  assert.ok(blocked>gateCall,'gate rejection missing');
  assert.ok(write>blocked,'Binance entry write must occur only after final gate');
  assert.ok(handler.includes('master.roleIssuedAt'));
  assert.ok(handler.includes('latest.armRaw'));
  assert.ok(handler.includes('writeAttempted:false'));
});

test('final gate fails closed for PANIC/revoke races without weakening entry write policy',()=>{
  for(const reason of [
    'MASTER_ROLE_CHANGED_DURING_ENTRY',
    'MASTER_LEASE_CHANGED_DURING_ENTRY',
    'MASTER_NOT_RUNNING_DURING_ENTRY',
    'EMERGENCY_STOP_ACTIVE',
    'REAL_EXECUTION_ARM_CHANGED_DURING_ENTRY',
    'MASTER_ROLE_EPOCH_CHANGED_DURING_ENTRY',
  ]) assert.ok(stateBlock.includes(reason),reason);
  assert.ok(handler.includes('REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&REAL_ENTRY_WRITE_ENABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED'));
});
