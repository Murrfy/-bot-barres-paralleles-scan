import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('vercel.json','utf8'));
const globalHeaders = config.headers?.find(h => h.source === '/(.*)')?.headers || [];
const map = new Map(globalHeaders.map(h => [String(h.key).toLowerCase(), String(h.value)]));

test('Zenith enforces core browser security headers', () => {
  assert.equal(map.get('cache-control'), 'no-store, max-age=0');
  assert.equal(map.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(map.get('x-content-type-options'), 'nosniff');
  assert.equal(map.get('x-frame-options'), 'DENY');
  assert.equal(map.get('referrer-policy'), 'no-referrer');
  assert.equal(map.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(map.get('cross-origin-resource-policy'), 'same-origin');

  const permissions = map.get('permissions-policy') || '';
  for (const denied of ['camera=()','microphone=()','geolocation=()','payment=()','usb=()']) {
    assert.ok(permissions.includes(denied), denied);
  }

  const csp = map.get('content-security-policy') || '';
  for (const invariant of [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
  ]) {
    assert.ok(csp.includes(invariant), invariant);
  }

  const styleSrc = /(?:^|;\s*)style-src\s+([^;]+)/.exec(csp)?.[1] || '';
  assert.ok(styleSrc, 'style-src');
  assert.equal(styleSrc.includes("'unsafe-inline'"), false, 'style-src unsafe-inline must stay disabled');
});
