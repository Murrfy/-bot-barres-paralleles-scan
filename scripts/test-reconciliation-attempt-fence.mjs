import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/binance-reconcile.js','utf8');

const beginStart=source.indexOf('async function beginReconciliationAttempt');
const commitStart=source.indexOf('async function commitReconciliationAttempt');
const failStart=source.indexOf('async function failReconciliationAttempt');
const handlerStart=source.indexOf('export default async function handler');
assert.ok(beginStart>=0&&commitStart>beginStart&&failStart>commitStart&&handlerStart>failStart);

const begin=source.slice(beginStart,commitStart);
const commit=source.slice(commitStart,failStart);
const fail=source.slice(failStart,handlerStart);
const handler=source.slice(handlerStart);

test('reconciliation invalidates any older clean report before contacting Binance',()=>{
  assert.ok(handler.includes("status: 'IN_PROGRESS'"));
  assert.ok(handler.includes('failClosed: true'));
  assert.ok(handler.includes("reasons: ['BINANCE_RECONCILIATION_IN_PROGRESS']"));
  assert.ok(handler.includes('const begun = await beginReconciliationAttempt(attemptMarker, device)'));
  assert.ok(
    handler.indexOf('beginReconciliationAttempt(attemptMarker, device)') <
    handler.indexOf("jsonFetch(`${BASE}/fapi/v1/time`)")
  );
});

test('begin marker is monotonic so an older request cannot replace a newer reconciliation state',()=>{
  assert.ok(begin.includes("tonumber(value.observedAt or 0) >= tonumber(ARGV[1])"));
  assert.ok(begin.includes("redis.call('SET', KEYS[1], ARGV[2], 'EX', '30')"));
  assert.ok(handler.includes("'BINANCE_RECONCILIATION_SUPERSEDED'"));
});

test('begin marker is fenced by current MASTER role, lease and role epoch',()=>{
  assert.ok(begin.includes("if registered ~= ARGV[3] then return -1 end"));
  assert.ok(begin.includes("if lease ~= ARGV[3] then return -2 end"));
  assert.ok(begin.includes("if roleEpoch ~= ARGV[4] then return -3 end"));
  assert.ok(begin.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(handler.includes("'MASTER_ROLE_CHANGED_DURING_RECONCILE'"));
  assert.ok(handler.includes("'MASTER_LEASE_CHANGED_DURING_RECONCILE'"));
  assert.ok(handler.includes("'MASTER_ROLE_EPOCH_CHANGED_DURING_RECONCILE'"));
});

test('final clean report commits only for the same attempt and unchanged semantic runtime',()=>{
  assert.ok(commit.includes("tostring(value.attemptId or '') ~= ARGV[1]"));
  assert.ok(commit.includes("local currentRuntime = redis.call('GET', KEYS[2]) or ''"));
  assert.ok(commit.includes("local currentRuntimeOk, currentState = pcall(cjson.decode, currentRuntime)"));
  assert.ok(commit.includes("local expectedRuntimeOk, expectedState = pcall(cjson.decode, ARGV[2])"));
  assert.ok(commit.includes("currentState.updatedAt = nil"));
  assert.ok(commit.includes("expectedState.updatedAt = nil"));
  assert.ok(commit.includes("if not deepEqual(currentState, expectedState) then return -1 end"));
  assert.equal(commit.includes("(redis.call('GET', KEYS[2]) or '') ~= ARGV[2]"),false);
  assert.ok(commit.includes("redis.call('SET', KEYS[1], ARGV[3], 'EX', '30')"));
  assert.ok(handler.includes("commitReconciliationAttempt(stored, runtimeRaw || '', attemptId, device)"));
});

test('heartbeat-only timestamp refresh cannot invalidate reconciliation but all other runtime fields remain fenced',()=>{
  assert.ok(commit.includes("local function deepEqual(a, b)"));
  assert.ok(commit.includes("currentState.updatedAt = nil"));
  assert.ok(commit.includes("expectedState.updatedAt = nil"));
  assert.equal(commit.includes("currentState.data = nil"),false);
  assert.equal(commit.includes("expectedState.data = nil"),false);
  assert.equal(commit.includes("currentState.controllerRevision = nil"),false);
  assert.equal(commit.includes("currentState.appliedRevision = nil"),false);
});

test('final clean report cannot commit after MASTER authority changes',()=>{
  assert.ok(commit.includes("if registered ~= ARGV[4] then return -2 end"));
  assert.ok(commit.includes("if lease ~= ARGV[4] then return -3 end"));
  assert.ok(commit.includes("if roleEpoch ~= ARGV[5] then return -4 end"));
  assert.ok(commit.includes("roleAssignmentKey(PREFIX, 'master')"));
  assert.ok(handler.includes("'RECONCILIATION_RUNTIME_CHANGED'"));
});

test('failure cannot overwrite a newer reconciliation attempt',()=>{
  assert.ok(fail.includes("tostring(value.attemptId or '') ~= ARGV[1]"));
  assert.ok(handler.includes('failReconciliationAttempt({'));
  assert.ok(handler.includes("status: 'UNAVAILABLE'"));
  assert.ok(handler.includes("reasons: ['BINANCE_RECONCILE_FAILED']"));
  assert.ok(handler.includes('attemptId'));
});

test('authority-race rejection still degrades the owned attempt to fail-closed UNAVAILABLE',()=>{
  assert.ok(handler.includes('const committed = await commitReconciliationAttempt'));
  assert.ok(handler.includes('error.code = error.message'));
  assert.ok(handler.indexOf('failReconciliationAttempt({') > handler.indexOf('commitReconciliationAttempt'));
  assert.ok(fail.includes("redis.call('SET', KEYS[1], ARGV[2], 'EX', '30')"));
});

test('legacy direct persistReport path is removed',()=>{
  assert.equal(source.includes('async function persistReport('),false);
});
