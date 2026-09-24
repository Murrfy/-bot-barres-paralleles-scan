import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const index=fs.readFileSync('index.html','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');

test('Binance USD-M user data uses the routed private WebSocket endpoint',()=>{
  const expected='wss://fstream.binance.com/private/ws?listenKey=';
  assert.ok(index.includes(expected));
  assert.ok(worker.includes(expected));
  assert.ok(index.includes('&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/ALGO_UPDATE/listenKeyExpired'));
  assert.ok(worker.includes('&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/ALGO_UPDATE/listenKeyExpired'));
  assert.equal(index.includes("new WebSocket('wss://fstream.binance.com/ws/'+encodeURIComponent(listenKey))"),false);
  assert.equal(worker.includes("new WebSocket('wss://fstream.binance.com/ws/'+encodeURIComponent(listenKey))"),false);
});

test('browser aggregate-trade market data uses the routed market endpoint',()=>{
  assert.ok(index.includes("new WebSocket('wss://fstream.binance.com/market/ws')"));
  assert.equal(index.includes("new WebSocket('wss://fstream.binance.com/ws')"),false);
});

test('CSP still permits the Binance WebSocket host without broadening to other hosts',()=>{
  const vercel=JSON.parse(fs.readFileSync('vercel.json','utf8'));
  const headers=vercel?.headers?.find(row=>row.source==='/(.*)')?.headers||[];
  const csp=headers.find(row=>String(row.key).toLowerCase()==='content-security-policy')?.value||'';
  assert.ok(csp.includes('wss://fstream.binance.com'));
  assert.equal(csp.includes('wss://*'),false);
});
