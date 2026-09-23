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
  const inlineAttrs = [...html.matchAll(/\sstyle\s*=\s*(["'])/gi)];
  if (inlineAttrs.length) {
    throw new Error(`${page}: inline style attributes remain (${inlineAttrs.length})`);
  }

  const blocks = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)];
  if (blocks.length !== 1) {
    throw new Error(`${page}: expected exactly one style block, found ${blocks.length}`);
  }

  const hash = crypto.createHash('sha256').update(blocks[0][1], 'utf8').digest('base64');
  tokens.push(`'sha256-${hash}'`);
}

const unique = [...new Set(tokens)].sort();
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const headers = vercel?.headers?.find(row => row.source === '/(.*)')?.headers || [];
const csp = headers.find(row => String(row.key).toLowerCase() === 'content-security-policy')?.value || '';

if (!csp) throw new Error('Content-Security-Policy header missing');

const styleSrc = /(?:^|;\s*)style-src\s+([^;]+)/.exec(csp)?.[1] || '';
if (!styleSrc) throw new Error('style-src missing from CSP');

if (styleSrc.includes("'unsafe-inline'")) {
  console.error('style-src still allows unsafe-inline. Required exact style hashes:');
  for (const token of unique) console.error(token);
  process.exit(1);
}

const declared = [...styleSrc.matchAll(/'sha256-[A-Za-z0-9+/=]+'/g)].map(m => m[0]).sort();

const missing = unique.filter(token => !declared.includes(token));
const stale = declared.filter(token => !unique.includes(token));

if (missing.length || stale.length) {
  if (missing.length) {
    console.error('Missing CSP style hashes:');
    for (const token of missing) console.error(token);
  }
  if (stale.length) {
    console.error('Stale CSP style hashes:');
    for (const token of stale) console.error(token);
  }
  console.error('Expected exact style hashes:');
  for (const token of unique) console.error(token);
  console.error('Currently declared style hashes:');
  for (const token of declared) console.error(token);
  process.exit(1);
}

console.log('CSP style hashes are exact and unsafe-inline is disabled for style-src.');
