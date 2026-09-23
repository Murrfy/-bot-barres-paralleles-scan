import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'bundleDependencies',
];

const unexpected = [];
for (const field of dependencyFields) {
  const value = pkg[field];
  if (!value) continue;
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (count > 0) unexpected.push(field + '=' + count);
}

const forbiddenLockfiles = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

for (const file of forbiddenLockfiles) {
  if (fs.existsSync(file)) unexpected.push('lockfile=' + file);
}

if (unexpected.length) {
  console.error('Dependency surface check FAILED.');
  for (const item of unexpected) console.error('- ' + item);
  console.error('Zenith currently requires no third-party runtime/build dependencies. Review and explicitly update this guard before adding any.');
  process.exit(1);
}

console.log('Dependency surface check passed: Zenith remains third-party dependency free.');
