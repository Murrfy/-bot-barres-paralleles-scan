import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync('vercel.json','utf8'));
const declared = config?.functions || {};
const apiFiles = fs.readdirSync('api')
  .filter(name => name.endsWith('.js'))
  .map(name => path.posix.join('api', name))
  .sort();

for (const file of apiFiles) {
  const maxDuration = Number(declared?.[file]?.maxDuration);
  if (!Number.isFinite(maxDuration)) {
    throw new Error(file + ': maxDuration missing from vercel.json');
  }
  if (file === 'api/binance-read.js') {
    if (maxDuration > 10) throw new Error(file + ': maxDuration must stay <= 10s');
  } else if (maxDuration > 30) {
    throw new Error(file + ': maxDuration must stay <= 30s');
  }
  if (maxDuration <= 0) throw new Error(file + ': maxDuration must be positive');
}

for (const file of Object.keys(declared)) {
  if (file.startsWith('api/') && file.endsWith('.js') && !apiFiles.includes(file)) {
    throw new Error('Stale Vercel function config: ' + file);
  }
}

console.log('All Zenith Vercel functions have bounded execution durations.');
