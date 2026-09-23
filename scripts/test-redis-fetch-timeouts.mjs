import fs from 'node:fs';
import path from 'node:path';

const files = fs.readdirSync('api')
  .filter(name => name.endsWith('.js'))
  .map(name => path.posix.join('api', name))
  .sort();

let checked = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const redisIndex = source.indexOf('async function redis');
  if (redisIndex < 0) continue;

  const fetchIndex = source.indexOf('fetch(REDIS_URL', redisIndex);
  if (fetchIndex < 0) throw new Error(file + ': Redis helper does not call REDIS_URL');

  const window = source.slice(fetchIndex, fetchIndex + 1400);
  if (!window.includes('AbortSignal.timeout(8000)')) {
    throw new Error(file + ': Redis fetch must use AbortSignal.timeout(8000)');
  }
  checked += 1;
}

if (checked === 0) throw new Error('No Redis helpers found to validate');
console.log('Redis fetch timeout guard passed for ' + checked + ' API files.');
