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

test('50-second delayed slot keeps waiting when best ask has reached exact sale',()=>{
  const start=worker.indexOf("if(result.action==='TRIGGER'&&result.signal?.delayedCurrentPrice===true)");
  const end=worker.indexOf('entryWatch.states.set(wanted,result.state)',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.match(block,/currentBestAsk\(wanted\)/);
  assert.match(block,/delayedConfig\.exactSaleEnabled===true/);
  assert.match(block,/exactSalePrice,0\)>quote\.askPrice/);
  assert.match(block,/triggeredAt:0/);
  assert.match(block,/pendingUntil:Math\.max\(n\(previous\?\.pendingUntil,0\)/);
  assert.match(block,/ENTRY_WAITING_EXACT_SALE_PRICE/);
  const incompatible=block.indexOf('ENTRY_WAITING_EXACT_SALE_PRICE');
  const configured=block.indexOf('result.signal.limitPrice=quote.askPrice');
  assert.ok(incompatible>=0&&configured>incompatible);
});

test('controller UI distinguishes price waiting from slot waiting',()=>{
  assert.match(html,/function realEntryWaitingExactSale\(s\)/);
  assert.match(html,/ATTENTE PRIX/);
  assert.match(html,/N’A PAS DÉMARRÉ — PRIX ≥ VENTE/);
});
