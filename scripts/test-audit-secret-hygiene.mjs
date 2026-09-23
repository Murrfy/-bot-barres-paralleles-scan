import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const apiDir = path.join(process.cwd(), 'api');
const files = fs.readdirSync(apiDir).filter(name => name.endsWith('.js'));

const forbiddenFields = [
  'adminCode',
  'recoveryCode',
  'sessionToken',
  'tokenHash',
  'BINANCE_API_KEY',
  'BINANCE_API_SECRET',
  'REDIS_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_TOKEN',
];

test('audit events never persist authentication or infrastructure secrets', () => {
  const violations = [];
  let auditedWrites = 0;

  for (const file of files) {
    const source = fs.readFileSync(path.join(apiDir, file), 'utf8');
    const auditWrite = /LPUSH['"],\s*KEY_AUDIT,\s*JSON\.stringify\(\{([\s\S]*?)\}\)\s*\]/g;

    for (const match of source.matchAll(auditWrite)) {
      auditedWrites++;
      const body = match[1] || '';
      for (const field of forbiddenFields) {
        if (body.includes(field)) {
          const line = source.slice(0, match.index || 0).split('\n').length;
          violations.push(file + ':' + line + ' -> ' + field);
        }
      }
    }
  }

  assert.ok(auditedWrites > 0, 'expected at least one audit write to inspect');
  assert.deepEqual(violations, []);
});
