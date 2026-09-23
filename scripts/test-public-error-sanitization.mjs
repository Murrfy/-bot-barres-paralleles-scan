import fs from 'node:fs';

const files = [
  'api/binance-entry-execute.js',
  'api/binance-entry-preflight.js',
  'api/binance-order-test.js',
  'api/binance-protective-execute.js',
  'api/binance-protective-update-execute.js',
  'api/binance-read.js',
  'api/binance-reconcile.js',
  'api/binance-runtime-snapshot.js',
  'api/binance-user-stream-session.js',
  'api/zenith-sync.js',
];

const forbidden = [
  /error\s*:\s*e\?\.message/g,
  /error\s*:\s*e\.message/g,
];

const failures = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) failures.push(file);
  }
}

if (failures.length) {
  console.error('Public error sanitization FAILED: raw internal exception messages are exposed.');
  for (const file of [...new Set(failures)]) console.error('- ' + file);
  process.exit(1);
}

console.log('Public API error responses are sanitized.');
