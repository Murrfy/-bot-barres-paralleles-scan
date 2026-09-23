import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SELF = path.normalize('scripts/check-secret-hygiene.mjs');
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.vercel', 'dist', 'build', 'coverage']);
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.html', '.json', '.yml', '.yaml', '.txt', '.md'
]);

const sensitiveNames = [
  'BINANCE_API_KEY',
  'BINANCE_API_SECRET',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_TOKEN',
  'ZENITH_MASTER_PAIRING_CODE',
  'ZENITH_MASTER_ADMIN_CODE',
  'MASTER_PAIRING_CODE',
  'MASTER_ADMIN_CODE',
  'VERCEL_TOKEN'
];

const escapedNames = sensitiveNames
  .map(name => name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
  .join('|');

const rules = [
  {
    name: 'hardcoded sensitive configuration',
    re: new RegExp(
      '(?:' + escapedNames + ')\\s*[:=]\\s*(?:["\']([^"\'\\n]{4,})["\']|([0-9]{4,}))',
      'g'
    )
  },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'OpenAI-style API key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{30,}/g }
];

function filesUnder(dir, relative = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.normalize(path.join(relative, entry.name));
    if (entry.isDirectory()) {
      out.push(...filesUnder(abs, rel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (rel === SELF) continue;

    const base = path.basename(entry.name);
    if (base.startsWith('.env') && base !== '.env.example') {
      out.push({ abs, rel, forceEnvFileFailure: true });
      continue;
    }

    if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push({ abs, rel, forceEnvFileFailure: false });
    }
  }
  return out;
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

const failures = [];

for (const file of filesUnder(ROOT)) {
  if (file.forceEnvFileFailure) {
    failures.push({ file: file.rel, line: 1, rule: 'committed environment file' });
    continue;
  }

  const text = fs.readFileSync(file.abs, 'utf8');

  const privateKeyMarker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const privateIndex = text.indexOf(privateKeyMarker);
  if (privateIndex >= 0) {
    failures.push({
      file: file.rel,
      line: lineNumber(text, privateIndex),
      rule: 'private key material'
    });
  }

  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      const full = String(match[0] || '');
      if (/process\.env\./.test(full)) continue;

      const testFixture = file.rel.startsWith(path.normalize('scripts/test-'));
      const assignedValue = String(match[1] || match[2] || '');
      const explicitTestSentinel = /^(?:test-only|api-key|api-key-test|secret|redis-token|https:\/\/redis\.test)$/.test(assignedValue);
      if (rule.name === 'hardcoded sensitive configuration' && testFixture && explicitTestSentinel) continue;

      failures.push({
        file: file.rel,
        line: lineNumber(text, match.index || 0),
        rule: rule.name
      });
    }
  }
}

if (failures.length) {
  console.error('Secret hygiene check FAILED.');
  for (const failure of failures) {
    console.error('- ' + failure.file + ':' + failure.line + ' — ' + failure.rule);
  }
  console.error('Move secrets to server-side environment variables and rotate any exposed credential.');
  process.exit(1);
}

console.log('Secret hygiene check passed: no committed secret patterns detected.');
