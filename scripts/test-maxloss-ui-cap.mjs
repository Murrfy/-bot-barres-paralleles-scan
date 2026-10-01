import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('MAX-LOSS input keeps the $2 minimum without a fixed global ceiling',()=>{
  assert.match(html,/id="tMaxLoss" type="number" min="2" step="1"/);
  assert.doesNotMatch(html,/id="tMaxLoss"[^>]*max="400"/);
});

test('controller refuses MAX-LOSS below minimum or above configured token margin',()=>{
  assert.match(html,/const requestedMaxLoss=n\(\$\('tMaxLoss'\)\.value,settings\.maxLoss\)/);
  assert.match(html,/requestedMaxLoss>=2/);
  assert.match(html,/requestedMaxLoss>configuredMargin/);
  assert.match(html,/maxLoss:requestedMaxLoss/);
});

test('local settings keep the locked $40 fallback without a fixed $400 clamp',()=>{
  assert.match(html,/targetProfit:40,maxLoss:40/);
  assert.doesNotMatch(html,/settings\.maxLoss=Math\.min\(400/);
  assert.doesNotMatch(html,/t\.maxLoss=Math\.min\(400/);
});
