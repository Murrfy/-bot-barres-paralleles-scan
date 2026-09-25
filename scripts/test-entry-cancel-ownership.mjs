import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const api=fs.readFileSync('api/binance-protective-execute.js','utf8');
const dispatch=fs.readFileSync('lib/master-command-dispatch.mjs','utf8');
const controller=fs.readFileSync('lib/controller-real-command.mjs','utf8');
const writer=fs.readFileSync('lib/binance-order-writer.mjs','utf8');

test('controller UI keeps external entry orders visible but read-only',()=>{
  const start=html.indexOf('function renderRealEntryOrders()');
  const end=html.indexOf('function renderRealPositions()',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);
  assert.match(block,/\^zth-ENT-\[a-f0-9\]\{24\}\$\/i/);
  assert.match(block,/String\(o\?\.side\|\|''\)\.toUpperCase\(\)==='BUY'/);
  assert.match(block,/String\(o\?\.type\|\|''\)\.toUpperCase\(\)==='LIMIT'/);
  assert.match(block,/String\(o\?\.timeInForce\|\|''\)\.toUpperCase\(\)==='GTC'/);
  assert.match(block,/EXTERNE · LECTURE SEULE/);
  assert.match(block,/controller&&managed&&!pending/);
});

test('controller command builder and dispatcher both fence cancellation to Zenith entry ids',()=>{
  assert.match(controller,/CANCEL_TARGET_NOT_ZENITH_ENTRY/);
  assert.match(controller,/CANCEL_TARGET_NOT_BUY/);
  assert.match(controller,/CANCEL_TARGET_NOT_LIMIT/);
  assert.match(controller,/CANCEL_TARGET_NOT_GTC/);
  assert.match(dispatch,/\^zth-ENT-\[a-f0-9\]\{24\}\$\/i/);
  assert.match(dispatch,/CANCEL_TARGET_NOT_ZENITH_ENTRY/);
});

test('Binance protective API independently revalidates exact Zenith BUY LIMIT GTC',()=>{
  const start=api.indexOf("if(type==='EXEC_CANCEL_ENTRY')");
  const end=api.indexOf("const symbol=String(req.body?.symbol||'').toUpperCase();",start+40);
  const block=api.slice(start,end>start?end:start+6500);
  assert.match(block,/CANCEL_TARGET_NOT_ZENITH_ENTRY/);
  assert.match(block,/CANCEL_TARGET_NOT_BUY/);
  assert.match(block,/CANCEL_TARGET_NOT_LIMIT/);
  assert.match(block,/CANCEL_TARGET_NOT_GTC/);
  assert.match(block,/CANCEL_TARGET_IS_REDUCE_ONLY/);
  assert.match(block,/HEDGE_MODE_UNSUPPORTED/);
});

test('deepest Binance writer also rejects non-Zenith ids before lookup',()=>{
  const start=writer.indexOf('export async function cancelEntryOrderIdempotent');
  const end=writer.indexOf('\nexport ',start+20);
  const block=writer.slice(start,end>start?end:writer.length);
  const ownership=block.indexOf("CANCEL_TARGET_NOT_ZENITH_ENTRY");
  const query=block.indexOf('queryOrderByClientId');
  assert.ok(ownership>=0&&query>ownership);
  assert.match(block,/CANCEL_TARGET_NOT_BUY/);
  assert.match(block,/CANCEL_TARGET_NOT_LIMIT/);
  assert.match(block,/CANCEL_TARGET_NOT_GTC/);
});
