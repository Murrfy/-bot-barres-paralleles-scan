import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const apiDir='api';
const apiFiles=fs.readdirSync(apiDir).filter(name=>name.endsWith('.js')).sort();

test('Vercel Node functions stay in native ESM mode',()=>{
  assert.equal(pkg.type,'module');
  assert.ok(apiFiles.length>0);
  for(const name of apiFiles){
    const source=fs.readFileSync(path.join(apiDir,name),'utf8');
    assert.match(source,/\bexport\s+default\b|\bexport\s+(async\s+)?function\b/);
    assert.equal(/\brequire\s*\(/.test(source),false,name+' must not use CommonJS require()');
    assert.equal(/\bmodule\.exports\b/.test(source),false,name+' must not use module.exports');
  }
});

test('shared device session module remains ESM-importable',async()=>{
  const mod=await import('../lib/device-session.mjs');
  assert.equal(typeof mod.cookieToken,'function');
  assert.equal(typeof mod.deviceSessionRecordActive,'function');
  assert.equal(typeof mod.setDeviceSessionCookie,'function');
});
