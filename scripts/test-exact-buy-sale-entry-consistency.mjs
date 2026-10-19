import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

test('token settings reject an exact sale at or below the exact buy',()=>{
  assert.match(
    html,
    /buyEnabled&&saleEnabled&&salePrice<=buyPrice[\s\S]{0,180}strictement supérieur au prix d’achat déterminé/
  );
});

test('active real position rejects an exact sale at or below Binance entry price',()=>{
  assert.match(
    html,
    /saleEnabled&&n\(position\?\.entryPrice,0\)>0&&salePrice<=n\(position\.entryPrice\)[\s\S]{0,180}supérieur au prix d’entrée réel Binance/
  );
});

test('instant MARKET buy checks Binance best ask against exact sale before queuing',()=>{
  const start=html.indexOf('async function instantBuySelected()');
  const end=html.indexOf('async function manualClose',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);
  assert.match(block,/tokenExactSale\(s\)/);
  assert.match(block,/\/fapi\/v1\/ticker\/bookTicker\?symbol=/);
  assert.match(block,/ask>=exactSale/);
  const check=block.indexOf('ask>=exactSale');
  const queue=block.indexOf("fetch('/api/zenith-sync?action=command'");
  assert.ok(check>=0&&queue>check);
});

test('worker refuses any watched LIMIT whose effective buy is not below exact sale',()=>{
  assert.match(worker,/const exactSaleEnabled=token\.exactSaleEnabled===true/);
  assert.match(worker,/exactSaleEnabled,exactSalePrice/);
  const start=worker.indexOf('async function executeWatchedEntry');
  const end=worker.indexOf('async function processEntryWatchPrice',start);
  const block=worker.slice(start,end);
  assert.match(block,/config\.exactSaleEnabled===true&&!\(n\(config\.exactSalePrice,0\)>effectiveLimitPrice\)/);
  assert.match(block,/ENTRY_EXACT_SALE_NOT_ABOVE_LIMIT/);
});

test('no delayed purchase exists: exact sale is only checked on the normal LIMIT entry',()=>{
  assert.doesNotMatch(worker,/ENTRY_WAITING_EXACT_SALE_PRICE/);
  assert.doesNotMatch(worker,/currentBestAsk/);
  assert.doesNotMatch(worker,/delayedCurrentPrice/);
});
test('controller UI shows STAND-BY and the price-above-sale reason',()=>{
  assert.match(html,/STAND-BY — PRIX ≥ VENTE/);
  assert.doesNotMatch(html,/ATTENTE PRIX|ATTENTE PLACE/);
});
test('exact-price profit target drives protection normalization in runtime config',()=>{
  const cfgStart=html.indexOf('function cfg(symbol)');
  const cfgEnd=html.indexOf('function exactProfitFor',cfgStart);
  assert.ok(cfgStart>=0&&cfgEnd>cfgStart);
  const block=html.slice(cfgStart,cfgEnd);
  const exactTarget=block.indexOf('base.targetProfit=');
  const protectionTarget=block.indexOf('const protectionTarget=',exactTarget);
  const normalize=block.indexOf('base.protectionStages=normalizeProtections',protectionTarget);
  assert.ok(exactTarget>=0&&protectionTarget>exactTarget&&normalize>protectionTarget);
  assert.match(block,/normalizeProtections\(t\.protectionStages\|\|settings\.protectionStages,protectionTarget\)/);
});

test('saving exact buy and sale adds required default protection stages without deleting existing rows',()=>{
  const start=html.indexOf('async function saveToken()');
  const end=html.indexOf('function devalidateSelected',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);
  assert.match(block,/const savedProtections=buyEnabled&&saleEnabled\?protectionsForTarget\(protections,shown\):protections/);
  assert.match(block,/protectionStages:savedProtections/);
  assert.match(html,/function protectionsForTarget\(stages,target,minCount=0\)[\s\S]{0,220}Math\.max\(protectionCountForTarget\(target\),src\.length/);
});
