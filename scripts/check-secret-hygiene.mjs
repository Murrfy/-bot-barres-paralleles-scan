import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

const gitignorePath = path.join(ROOT, '.gitignore');
const requiredIgnorePatterns = ['.env', '.env.*', '.vercel/', '*.pem', '*.key', '*.p12', '*.pfx'];
if (!fs.existsSync(gitignorePath)) {
  failures.push({ file: '.gitignore', line: 1, rule: 'missing secret ignore policy', source: 'working-tree' });
} else {
  const gitignoreLines = new Set(
    fs.readFileSync(gitignorePath, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  );
  for (const pattern of requiredIgnorePatterns) {
    if (!gitignoreLines.has(pattern)) {
      failures.push({
        file: '.gitignore',
        line: 1,
        rule: 'missing ignore pattern ' + pattern,
        source: 'working-tree'
      });
    }
  }
}

function explicitFakeTestCredential(file, ruleName, match) {
  if (ruleName !== 'hardcoded sensitive configuration') return false;
  const testFixture = String(file || '').startsWith(path.normalize('scripts/test-'));
  const assignedValue = String(match?.[1] || match?.[2] || '');
  return testFixture &&
    /^(?:test-only|api-key|api-key-test|secret|redis-token|https:\/\/redis\.test)$/.test(assignedValue);
}

function scanTextForRules({ text, file, source, lineOffset = 0 }) {
  const privateKeyMarker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const privateIndex = text.indexOf(privateKeyMarker);
  if (privateIndex >= 0) {
    failures.push({
      file,
      line: lineOffset + lineNumber(text, privateIndex),
      rule: 'private key material',
      source
    });
  }

  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      const full = String(match[0] || '');
      if (/process\.env\./.test(full)) continue;
      if (explicitFakeTestCredential(file, rule.name, match)) continue;

      failures.push({
        file,
        line: lineOffset + lineNumber(text, match.index || 0),
        rule: rule.name,
        source
      });
    }
  }
}

for (const file of filesUnder(ROOT)) {
  if (file.forceEnvFileFailure) {
    failures.push({ file: file.rel, line: 1, rule: 'committed environment file' });
    continue;
  }

  const text = fs.readFileSync(file.abs, 'utf8');
  scanTextForRules({
    text,
    file: file.rel,
    source: 'working-tree'
  });
}

function scanReachableHistory() {
  let patch = '';
  try {
    patch = execFileSync(
      'git',
      [
        'log',
        'HEAD',
        '--format=__ZENITH_COMMIT__%H',
        '--patch',
        '--no-ext-diff',
        '--unified=0',
        '--',
        '.',
        ':(exclude)scripts/check-secret-hygiene.mjs'
      ],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
    );
  } catch (e) {
    console.error('Historical secret scan could not read Git history.');
    process.exit(1);
  }

  let commit = '';
  let file = '';
  let newLine = 0;

  for (const rawLine of patch.split('\n')) {
    if (rawLine.startsWith('__ZENITH_COMMIT__')) {
      commit = rawLine.slice('__ZENITH_COMMIT__'.length).trim();
      file = '';
      newLine = 0;
      continue;
    }

    if (rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).trim();
      file = target === '/dev/null' ? '' : target.replace(/^b\//, '');
      if (
        file &&
        path.basename(file).startsWith('.env') &&
        path.basename(file) !== '.env.example'
      ) {
        failures.push({
          file,
          line: 1,
          rule: 'committed environment file',
          source: 'history:' + commit
        });
      }
      continue;
    }

    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      newLine = Number(hunk[1]) || 0;
      continue;
    }

    if (!file || rawLine.startsWith('--- ')) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const added = rawLine.slice(1);
      scanTextForRules({
        text: added,
        file: path.normalize(file),
        source: 'history:' + commit,
        lineOffset: Math.max(0, newLine - 1)
      });
      newLine += 1;
      continue;
    }

    if (!rawLine.startsWith('-') && !rawLine.startsWith('\\')) newLine += 1;
  }
}

scanReachableHistory();

if (failures.length) {
  console.error('Secret hygiene check FAILED.');
  for (const failure of failures) {
    console.error('- ' + failure.file + ':' + failure.line + ' — ' + failure.rule + ' [' + (failure.source || 'unknown') + ']');
  }
  console.error('Move secrets to server-side environment variables and rotate any exposed credential.');
  process.exit(1);
}

console.log('Secret hygiene check passed: working tree and reachable Git history contain no blocked secret patterns.');
