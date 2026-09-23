import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('MAX-LOSS input exposes the hard $400 ceiling',()=>{
  assert.match(html,/id="tMaxLoss" type="number" min="2" max="400" step="1"/);
});

test('controller refuses to save MAX-LOSS outside the real safety range',()=>{
  assert.match(html,/const requestedMaxLoss=n\(\$\('tMaxLoss'\)\.value,settings\.maxLoss\)/);
  assert.match(html,/requestedMaxLoss>=2&&requestedMaxLoss<=400/);
  assert.match(html,/plafond de 400 \$/);
  assert.match(html,/maxLoss:requestedMaxLoss/);
});

test('legacy local settings are migrated down to the hard cap',()=>{
  assert.match(html,/settings\.maxLoss=Math\.min\(400,Math\.max\(2,n\(settings\.maxLoss,400\)\)\)/);
  assert.match(html,/t\.maxLoss=Math\.min\(400,Math\.max\(2,n\(t\?\.maxLoss,settings\.maxLoss\)\)\)/);
});
