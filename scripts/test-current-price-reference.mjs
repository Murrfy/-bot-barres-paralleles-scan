import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('determined buy settings show a red bordered live Binance price reference',()=>{
  assert.match(html,/class="currentPriceBadge"/);
  assert.match(html,/id="tCurrentMarketPrice"/);
  assert.match(html,/PRIX ACTUEL BINANCE/);
  assert.match(html,/\.currentPriceBadge\{[^}]*border:2px solid var\(--red\)/);
});

test('selected current price preserves Binance tick decimals for zero checking',()=>{
  assert.match(html,/function fullCurrentPrice\(v,symbol=''/);
  assert.match(html,/PRICE_FILTER/);
  assert.match(html,/const rawTick=rules\?\.filters\?\.PRICE_FILTER\?\.tickSize/);
  assert.match(html,/tick>0\?stepDecimals\(rawTick\)/);
  assert.match(html,/value\.toFixed\(decimals\)/);
});

test('selected symbol stays subscribed and refreshes the price badge live',()=>{
  assert.match(html,/if\(selectedSymbol\)out\.add\(String\(selectedSymbol\)\.toUpperCase\(\)\)/);
  assert.match(html,/renderSelectedCurrentPrice\(\)/);
  assert.match(html,/String\(s\)\.toUpperCase\(\)===String\(selectedSymbol\|\|''\)\.toUpperCase\(\).*renderSelectedCurrentPrice\(\)/);
  assert.match(html,/openTokenSettings[\s\S]*?syncRealtime\(\)/);
});
