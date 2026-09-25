import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api=fs.readFileSync('api/binance-trade-history.js','utf8');
const html=fs.readFileSync('index.html','utf8');

test('real history API is read-only and uses Binance execution/accounting endpoints',()=>{
  assert.match(api,/req\.method!=='GET'/);
  assert.match(api,/path:'\/fapi\/v1\/allOrders'/);
  assert.match(api,/path:'\/fapi\/v1\/userTrades'/);
  assert.match(api,/path:'\/fapi\/v1\/income'/);
  assert.match(api,/FUNDING_FEE/);
  assert.match(api,/COMMISSION_REBATE/);
  assert.doesNotMatch(api,/method:'POST'.*\/fapi\/v1\/order/s);
  assert.doesNotMatch(api,/BINANCE_TRADING_API_KEY|BINANCE_TRADING_API_SECRET/);
  assert.match(api,/process\.env\.BINANCE_API_KEY/);
  assert.match(api,/process\.env\.BINANCE_API_SECRET/);
});

test('real history is cached and rate-limited independently from 15-second account refresh',()=>{
  assert.match(api,/CACHE_TTL_SECONDS=60/);
  assert.match(api,/RATE_LIMIT_MAX=3/);
  assert.match(api,/RATE_LIMIT_WINDOW_SECONDS=300/);
  assert.match(html,/binanceHistoryTimer=setInterval\(\(\)=>refreshRealHistory\(\),180000\)/);
});

test('UI renders actual Binance entry/exit and net, never a protection level number',()=>{
  assert.match(html,/Achat réel/);
  assert.match(html,/Vente réelle/);
  assert.match(html,/Net Binance/);
  assert.match(html,/h\.entryPrice/);
  assert.match(html,/h\.exitPrice/);
  assert.match(html,/h\.netPnl/);
  assert.match(html,/replace\(\/niveau/);
  assert.doesNotMatch(html,/Réinitialiser gains \/ fermés/);
  assert.match(html,/Rafraîchir historique Binance/);
  assert.match(html,/refreshHistoryBtn/);
});

test('UI visibly marks an inexact net if commission cannot be converted exactly',()=>{
  assert.match(html,/const exact=h\.exactNet===true/);
  assert.match(html,/\(exact\?'':'≈ '\)\+money\(net\)/);
});
