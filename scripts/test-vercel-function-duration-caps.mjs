import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const config = JSON.parse(fs.readFileSync('vercel.json','utf8'));
const functions = config.functions || {};

const expected = new Map([
  ['api/binance-read.js', 10],
  ['api/binance-reconcile.js', 30],
  ['api/binance-entry-preflight.js', 30],
  ['api/binance-entry-execute.js', 30],
  ['api/binance-order-test.js', 30],
  ['api/binance-protective-execute.js', 30],
  ['api/binance-protective-update-execute.js', 30],
  ['api/binance-runtime-snapshot.js', 30],
  ['api/binance-user-stream-session.js', 30],
  ['api/zenith-sync.js', 30],
]);

test('all Zenith Vercel APIs have bounded execution duration', () => {
  const declared = Object.keys(functions).sort();
  const required = [...expected.keys()].sort();
  assert.deepEqual(declared, required);

  for (const [path, maxDuration] of expected) {
    assert.equal(functions[path]?.maxDuration, maxDuration, path);
    assert.ok(maxDuration <= 30, path + ' exceeds Zenith 30s safety cap');
  }
});
