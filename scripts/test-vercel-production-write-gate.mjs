import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const writeFiles = [
  'api/binance-entry-execute.js',
  'api/binance-protective-execute.js',
  'api/binance-protective-update-execute.js',
];

test('Vercel previews and development deployments cannot enable Binance writes', () => {
  for (const file of writeFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes("process.env.VERCEL_ENV"), file + ' must inspect VERCEL_ENV');
    assert.ok(source.includes("VERCEL_PRODUCTION_WRITE_ALLOWED"), file + ' must define production write gate');
    assert.ok(
      source.includes("!process.env.VERCEL_ENV||process.env.VERCEL_ENV==='production'"),
      file + ' must allow writes only on Vercel production or outside Vercel'
    );
    const compact = source.replace(/\s+/g, '');
    const writeGateUses = (compact.match(/writesEnabled=Boolean\([^)]*VERCEL_PRODUCTION_WRITE_ALLOWED/g) || []).length;
    assert.ok(writeGateUses >= 1, file + ' must include production gate in writesEnabled');
  }
});

test('central execution arm and command gate reject non-production Vercel deployments', () => {
  const source = fs.readFileSync('api/zenith-sync.js', 'utf8');
  assert.ok(source.includes("const VERCEL_PRODUCTION_WRITE_ALLOWED = !process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'production';"));
  assert.ok(source.includes("reason:'NON_PRODUCTION_DEPLOYMENT'"));
  assert.ok(source.includes("reason: 'NON_PRODUCTION_DEPLOYMENT'"));
  assert.ok(source.includes("code:'NON_PRODUCTION_DEPLOYMENT'"));
});
