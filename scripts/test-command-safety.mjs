import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

process.env.ZENITH_REAL_TRADING_ENABLED = '0';
process.env.ZENITH_PAIRING_DISABLED = '0';

const source = fs.readFileSync('api/zenith-sync.js', 'utf8');
const { commandTypeAllowed, commandExpired, executionGate } = await import(
  'data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { commandTypeAllowed, commandExpired, executionGate };').toString('base64')
);

test('only audited protective command types are accepted', () => {
  for (const type of [
    'UPDATE_EXIT',
    'UPDATE_PROTECTION',
    'CLOSE_POSITION',
    'CANCEL_ENTRY',
    'EXEC_UPDATE_EXIT',
    'EXEC_UPDATE_PROTECTION',
    'EXEC_CLOSE_POSITION',
    'EXEC_CANCEL_ENTRY',
  ]) assert.equal(commandTypeAllowed(type), true, type);

  for (const type of ['OPEN_POSITION', 'EXEC_OPEN_POSITION', 'BUY', 'EXEC_BUY', 'UNKNOWN']) {
    assert.equal(commandTypeAllowed(type), false, type);
  }
});

test('commands require a bounded explicit expiry', () => {
  const now = 1_000_000;
  assert.equal(commandExpired({ createdAt: now - 1_000, expiresAt: now + 1_000 }, now), false);
  assert.equal(commandExpired({ createdAt: now - 180_000, expiresAt: now + 1_000 }, now), true);
  assert.equal(commandExpired({ createdAt: now - 1_000, expiresAt: now - 1 }, now), true);
  assert.equal(commandExpired({ createdAt: now - 1_000 }, now), true);
});

test('execution gate fails closed while real trading is disabled', () => {
  const gate = executionGate('EXEC_CLOSE_POSITION', false);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'REAL_TRADING_DISABLED');
});
