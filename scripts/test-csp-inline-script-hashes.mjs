import fs from 'node:fs';
import crypto from 'node:crypto';

const pages = [
  'index.html',
  'master-admin.html',
  'master-standby.html',
  'pair-controller.html',
  'pair-master.html',
  'controller-status.html',
  'replace-controller.html',
];

const tokens = [];
for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[0].slice(0, match[0].indexOf('>') + 1)));
  if (scripts.length !== 1) {
    throw new Error(`${page}: expected exactly one inline script, found ${scripts.length}`);
  }
  const body = scripts[0][1];
  const hash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
  tokens.push(`'sha256-${hash}'`);
}

const unique = [...new Set(tokens)].sort();
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const headers = vercel?.headers?.find(row => row.source === '/(.*)')?.headers || [];
const csp = headers.find(row => String(row.key).toLowerCase() === 'content-security-policy')?.value || '';

if (!csp) throw new Error('Content-Security-Policy header missing');
if (csp.includes("script-src 'self' 'unsafe-inline'")) {
  console.error('CSP still allows unsafe inline scripts. Required exact script tokens:');
  for (const token of unique) console.error(token);
  process.exit(1);
}
if (csp.includes("'unsafe-inline'") && /script-src[^;]*'unsafe-inline'/.test(csp)) {
  throw new Error('script-src must not allow unsafe-inline');
}

const scriptSrc = /(?:^|;\s*)script-src\s+([^;]+)/.exec(csp)?.[1] || '';
for (const token of unique) {
  if (!scriptSrc.includes(token)) {
    console.error('Missing CSP script hash: ' + token);
    process.exit(1);
  }
}

const declared = [...scriptSrc.matchAll(/'sha256-[A-Za-z0-9+/=]+'/g)].map(m => m[0]).sort();
if (JSON.stringify(declared) !== JSON.stringify(unique)) {
  console.error('CSP contains stale or unexpected script hashes.');
  console.error('Expected:');
  for (const token of unique) console.error(token);
  console.error('Declared:');
  for (const token of declared) console.error(token);
  process.exit(1);
}

console.log('CSP inline-script hashes are exact and unsafe-inline is disabled for script-src.');
