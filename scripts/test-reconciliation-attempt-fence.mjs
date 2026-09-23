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
  assert.ok(handler.includes('const begun = await beginReconciliationAttempt(attemptMarker)'));
  assert.ok(
    handler.indexOf('beginReconciliationAttempt(attemptMarker)') <
    handler.indexOf("jsonFetch(`${BASE}/fapi/v1/time`)")
  );
});

test('begin marker is monotonic so an older request cannot replace a newer reconciliation state',()=>{
  assert.ok(begin.includes("tonumber(value.observedAt or 0) >= tonumber(ARGV[1])"));
  assert.ok(begin.includes("redis.call('SET', KEYS[1], ARGV[2], 'EX', '30')"));
  assert.ok(handler.includes("'BINANCE_RECONCILIATION_SUPERSEDED'"));
});

test('final clean report commits only for the same attempt and unchanged runtime',()=>{
  assert.ok(commit.includes("tostring(value.attemptId or '') ~= ARGV[1]"));
  assert.ok(commit.includes("(redis.call('GET', KEYS[2]) or '') ~= ARGV[2]"));
  assert.ok(commit.includes("redis.call('SET', KEYS[1], ARGV[3], 'EX', '30')"));
  assert.ok(handler.includes("commitReconciliationAttempt(stored, runtimeRaw || '', attemptId)"));
});

test('failure cannot overwrite a newer reconciliation attempt',()=>{
  assert.ok(fail.includes("tostring(value.attemptId or '') ~= ARGV[1]"));
  assert.ok(handler.includes('failReconciliationAttempt({'));
  assert.ok(handler.includes("status: 'UNAVAILABLE'"));
  assert.ok(handler.includes("reasons: ['BINANCE_RECONCILE_FAILED']"));
  assert.ok(handler.includes('attemptId'));
});

test('legacy direct persistReport path is removed',()=>{
  assert.equal(source.includes('async function persistReport('),false);
});
