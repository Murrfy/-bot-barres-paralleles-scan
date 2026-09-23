import { execFileSync } from 'node:child_process';

const SAFE_TEST_VALUES = new Set([
  'test-only',
  'api-key',
  'api-key-test',
  'secret',
  'redis-token',
  'pairing-code',
  'master-pairing-code',
  'master-admin-code',
  'dummy',
  'example',
]);

const sensitiveAssignment = new RegExp(
  String.raw`(?:BINANCE_API_KEY|BINANCE_API_SECRET|UPSTASH_REDIS_REST_TOKEN|KV_REST_API_TOKEN|ZENITH_MASTER_ADMIN_CODE|ZENITH_MASTER_PAIRING_CODE|ZENITH_PAIRING_CODE|VERCEL_TOKEN)\s*[:=]\s*['"]([^'"]{4,})['"]`,
  'g'
);

const highConfidence = [
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'OpenAI-style API key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'private key material', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
];

function historyPatch() {
  return execFileSync(
    'git',
    ['log', '--all', '--format=@@ZENITH_COMMIT@@%H', '--patch', '--no-color', '--unified=0', '--no-ext-diff'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
}

let commit = '';
let file = '';
const failures = [];

for (const rawLine of historyPatch().split('\n')) {
  if (rawLine.startsWith('@@ZENITH_COMMIT@@')) {
    commit = rawLine.slice('@@ZENITH_COMMIT@@'.length).trim();
    continue;
  }
  if (rawLine.startsWith('+++ b/')) {
    file = rawLine.slice(6).trim();
    continue;
  }
  if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;

  const line = rawLine.slice(1);

  sensitiveAssignment.lastIndex = 0;
  for (const match of line.matchAll(sensitiveAssignment)) {
    const value = String(match[1] || '').trim();
    if (SAFE_TEST_VALUES.has(value)) continue;
    if (/^(?:test|fake|dummy|example)[-_]/i.test(value)) continue;
    failures.push({ commit, file, rule: 'hardcoded sensitive configuration' });
  }

  for (const rule of highConfidence) {
    rule.re.lastIndex = 0;
    if (rule.re.test(line)) failures.push({ commit, file, rule: rule.name });
  }
}

const unique = [];
const seen = new Set();
for (const failure of failures) {
  const key = [failure.commit, failure.file, failure.rule].join('|');
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(failure);
}

if (unique.length) {
  console.error('Secret history scan FAILED.');
  for (const failure of unique) {
    console.error(
      '- ' + (failure.commit || 'unknown').slice(0, 12) +
      ' ' + (failure.file || 'unknown-file') +
      ' — ' + failure.rule
    );
  }
  console.error('Rotate any exposed credential before rewriting or cleaning Git history.');
  process.exit(1);
}

console.log('Secret history scan passed: no high-confidence committed secret found in reachable history.');
