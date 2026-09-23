import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const writeFiles = [
  'api/binance-entry-execute.js',
  'api/binance-protective-execute.js',
  'api/binance-protective-update-execute.js',
];

test('Vercel Binance writes require production on the main Git branch', () => {
  for (const file of writeFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes("process.env.VERCEL_ENV"), file + ' must inspect VERCEL_ENV');
    assert.ok(source.includes("VERCEL_PRODUCTION_WRITE_ALLOWED"), file + ' must define production write gate');
    assert.ok(
      source.includes("process.env.VERCEL_ENV==='production'&&process.env.VERCEL_GIT_COMMIT_REF==='main'") &&
      !source.includes("!process.env.VERCEL_ENV||"),
      file + ' must fail closed unless Vercel production main is explicit'
    );
    const compact = source.replace(/\s+/g, '');
    const writeGateUses = (compact.match(/writesEnabled=Boolean\([^)]*VERCEL_PRODUCTION_WRITE_ALLOWED/g) || []).length;
    assert.ok(writeGateUses >= 1, file + ' must include production gate in writesEnabled');
  }
});

test('central execution arm and command gate reject non-production Vercel deployments', () => {
  const source = fs.readFileSync('api/zenith-sync.js', 'utf8');
  assert.ok(source.includes("const VERCEL_PRODUCTION_WRITE_ALLOWED = process.env.VERCEL_ENV === 'production' && process.env.VERCEL_GIT_COMMIT_REF === 'main';"));
  assert.ok(source.includes('ZENITH_CONTROL_MUTATION_ALLOWED'));
  assert.ok(source.includes("process.env.VERCEL_ENV === 'development'"));
  assert.ok(source.includes("'NON_PRODUCTION_CONTROL_MUTATION'"));
  assert.ok(source.includes("reason:'NON_PRODUCTION_DEPLOYMENT'"));
  assert.ok(source.includes("reason: 'NON_PRODUCTION_DEPLOYMENT'"));
  assert.ok(source.includes("code:'NON_PRODUCTION_DEPLOYMENT'"));
});

test('Binance user-stream mutations require Vercel production main', () => {
  const source = fs.readFileSync('api/binance-user-stream-session.js', 'utf8');
  assert.ok(source.includes("const VERCEL_PRODUCTION_WRITE_ALLOWED = process.env.VERCEL_ENV === 'production' && process.env.VERCEL_GIT_COMMIT_REF === 'main';"));
  assert.equal(source.includes("!process.env.VERCEL_ENV ||"), false);
  assert.ok(source.includes("['start', 'keepalive', 'close'].includes(action)"));
  assert.ok(source.includes("'NON_PRODUCTION_DEPLOYMENT'"));
});
