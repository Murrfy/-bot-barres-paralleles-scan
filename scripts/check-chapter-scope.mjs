import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CONTROL_FILE = 'zenith-chapter-scope.json';
const BOOTSTRAP_FILES = new Set([
  CONTROL_FILE,
  'scripts/check-chapter-scope.mjs',
  '.github/workflows/zenith-safety.yml',
]);

function fail(message) {
  console.error('Chapter scope check FAILED: ' + message);
  process.exit(1);
}

function parseConfig(raw, source) {
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    fail(source + ' is not valid JSON');
  }
  if (!config || config.version !== 1) fail(source + ' must use version 1');
  if (!/^[1-9][0-9]*-[a-z0-9-]+$/.test(String(config.activeChapter || ''))) {
    fail(source + ' has an invalid activeChapter');
  }
  if (!Number.isInteger(config.scopeRevision) || config.scopeRevision < 1) {
    fail(source + ' has an invalid scopeRevision');
  }
  if (!Array.isArray(config.allowedPaths) || config.allowedPaths.length === 0) {
    fail(source + ' must contain at least one allowed path');
  }
  for (const path of config.allowedPaths) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')) {
      fail(source + ' contains an unsafe allowed path: ' + String(path));
    }
  }
  return config;
}

function changedFiles(baseRef) {
  try {
    execFileSync(
      'git',
      ['fetch', '--no-tags', 'origin', baseRef + ':refs/remotes/origin/' + baseRef],
      { stdio: 'ignore' }
    );
  } catch {
    // actions/checkout with fetch-depth: 0 normally already provides the base.
  }
  try {
    return execFileSync(
      'git',
      ['diff', '--name-only', 'origin/' + baseRef + '...HEAD'],
      { encoding: 'utf8' }
    ).split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  } catch (error) {
    fail('cannot compute diff against origin/' + baseRef + ': ' + String(error?.message || error));
  }
}

function baseFile(baseRef, path) {
  try {
    return execFileSync(
      'git',
      ['show', 'origin/' + baseRef + ':' + path],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    return null;
  }
}

function allowed(path, config) {
  return config.allowedPaths.some(rule => {
    if (rule.endsWith('/**')) {
      const prefix = rule.slice(0, -3);
      return path === prefix || path.startsWith(prefix + '/');
    }
    return path === rule;
  });
}

if (!fs.existsSync(CONTROL_FILE)) fail(CONTROL_FILE + ' is missing');
const headConfig = parseConfig(fs.readFileSync(CONTROL_FILE, 'utf8'), CONTROL_FILE);

const baseRef = String(process.env.GITHUB_BASE_REF || '');
const headRef = String(process.env.GITHUB_HEAD_REF || '');

if (!baseRef) {
  console.log(
    'Chapter scope configuration valid: ' +
    headConfig.activeChapter + ' revision ' + headConfig.scopeRevision
  );
  process.exit(0);
}

if (headRef.startsWith('dependabot/')) {
  console.log('Dependabot PR: chapter scope file validated; dependency maintenance exempted.');
  process.exit(0);
}

const changed = changedFiles(baseRef);
const baseRaw = baseFile(baseRef, CONTROL_FILE);

if (baseRaw === null) {
  const unexpected = changed.filter(path => !BOOTSTRAP_FILES.has(path));
  if (unexpected.length) {
    fail('bootstrap PR touched files outside the governance bootstrap: ' + unexpected.join(', '));
  }
  console.log('Chapter scope governance bootstrap accepted.');
  process.exit(0);
}

const baseConfig = parseConfig(baseRaw, 'origin/' + baseRef + ':' + CONTROL_FILE);

if (changed.includes(CONTROL_FILE)) {
  if (changed.length !== 1) {
    fail(
      'chapter/scope transition must be isolated. Change only ' + CONTROL_FILE +
      ', merge it, then make chapter changes in a later PR.'
    );
  }
  if (headConfig.scopeRevision <= baseConfig.scopeRevision) {
    fail('scopeRevision must increase when changing chapter scope');
  }
  console.log(
    'Chapter scope transition accepted: ' +
    baseConfig.activeChapter + ' -> ' + headConfig.activeChapter +
    ' (revision ' + headConfig.scopeRevision + ')'
  );
  process.exit(0);
}

const forbidden = changed.filter(path => !allowed(path, baseConfig));
if (forbidden.length) {
  fail(
    'PR exceeds active chapter ' + baseConfig.activeChapter +
    ' scope. Forbidden paths: ' + forbidden.join(', ')
  );
}

console.log(
  'Chapter scope respected: ' + baseConfig.activeChapter +
  ' revision ' + baseConfig.scopeRevision +
  ' (' + changed.length + ' changed file(s))'
);
