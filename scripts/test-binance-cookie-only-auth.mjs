import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const files=[
  'api/binance-entry-execute.js',
  'api/binance-entry-preflight.js',
  'api/binance-order-test.js',
  'api/binance-protective-execute.js',
  'api/binance-protective-update-execute.js',
  'api/binance-read.js',
  'api/binance-reconcile.js',
  'api/binance-runtime-snapshot.js',
  'api/binance-user-stream-session.js',
];

test('all Binance APIs require the HttpOnly device cookie and reject legacy Bearer auth paths',()=>{
  for(const file of files){
    const source=fs.readFileSync(file,'utf8');
    assert.match(source,/\bcookieToken\b/,file+' must import/use cookieToken');
    assert.doesNotMatch(source,/\bdeviceTokenCandidates\b/,file+' must not accept Bearer migration tokens');
  }
});
