import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');

function block(start,end){
  const a=html.indexOf(start);
  assert.ok(a>=0,`missing start: ${start}`);
  const b=html.indexOf(end,a+start.length);
  assert.ok(b>a,`missing end: ${end}`);
  return html.slice(a,b);
}

test('production UI is real-only and exposes no simulation controls',()=>{
  assert.match(html,/PERP USDT · réel uniquement/);
  assert.doesNotMatch(html,/id="resetSimBtn"/);
  assert.doesNotMatch(html,/id="activePositionsPanel"/);
  assert.doesNotMatch(html,/Positions actives — simulation/);
});

test('instant buy can never fall back to a local simulated position',()=>{
  const instant=block('async function instantBuySelected()','async function manualClose');
  assert.doesNotMatch(instant,/createPosition\(/);
  assert.match(instant,/buildControllerMarketEntryCommand/);
  assert.match(instant,/\/api\/zenith-sync\?action=command/);
  assert.match(instant,/ACHAT IMMÉDIAT MARKET/);
  assert.match(instant,/Aucune simulation ne sera créée/);
});

test('market data never creates or closes a browser-local position',()=>{
  const mark=block('function onMark(s,mark)','function processAggTrade');
  assert.doesNotMatch(mark,/tickPosition\(/);
  assert.doesNotMatch(mark,/createPosition\(/);
  assert.doesNotMatch(mark,/closePosition\(/);
});

test('legacy local position helpers fail closed',()=>{
  const create=block('function createPosition(s,entry,source)','function closePosition');
  assert.match(create,/Simulation supprimée/);
  assert.match(create,/return null/);
  assert.match(html,/function openBySymbol\(\)\{return null\}/);
});

test('real sells have no MARKET fallback',()=>{
  const orderIntent=fs.readFileSync('lib/order-intent.mjs','utf8');
  const closeState=fs.readFileSync('lib/protective-close-state.mjs','utf8');
  const protectiveApi=fs.readFileSync('api/binance-protective-execute.js','utf8');
  assert.doesNotMatch(orderIntent,/EXIT_MARKET|MARKET_LAST_RESORT/);
  assert.doesNotMatch(closeState,/MARKET_LAST_RESORT/);
  assert.match(protectiveApi,/EXIT_MODE_LIMIT_REQUIRED/);
});
