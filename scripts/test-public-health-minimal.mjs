import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('api/zenith-sync.js', 'utf8');

test('public health response exposes no operational security posture', () => {
  const start = source.indexOf("if (action === 'health' && req.method === 'GET')");
  const end = source.indexOf('\n\n  try {', start);
  assert.ok(start >= 0 && end > start, 'health block must exist');
  const block = source.slice(start, end);

  assert.match(block, /ok:\s*true/);
  assert.match(block, /service:\s*'zenith-sync'/);

  for (const forbidden of [
    'redisConfigured',
    'pairingConfigured',
    'masterPairingConfigured',
    'masterAdminConfigured',
    'pairingDisabled',
    'realTradingEnabled',
    'binanceWriteEnabled',
    'realExecutionEnvironmentReady',
    'executionMode',
    'masterTtlSeconds',
    'masterActivationTtlSeconds',
    'commandClaimTtlMs',
    'commandMaxAgeMs',
    'commandQueueMax',
    'commandPayloadMaxBytes',
  ]) {
    assert.equal(block.includes(forbidden), false, forbidden + ' must not be public');
  }
});
