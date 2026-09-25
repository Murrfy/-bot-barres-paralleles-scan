import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildZenithClosedTradeHistory, mergeTradeHistory } from '../lib/real-trade-history.mjs';
import { windowsFor, zenithOrder } from '../api/binance-history.js';

function order(orderId,clientOrderId,symbol='BTCUSDT'){
  return {symbol,orderId,clientOrderId};
}
function trade({id,orderId,side,qty,price,realizedPnl=0,commission=0,commissionAsset='USDT',time,symbol='BTCUSDT'}){
  return {
    id,orderId,side,qty:String(qty),price:String(price),
    realizedPnl:String(realizedPnl),commission:String(commission),
    commissionAsset,time,symbol,positionSide:'BOTH'
  };
}

test('closed Zenith LONG uses actual fills, commissions and funding for exact net',()=>{
  const rows=buildZenithClosedTradeHistory({
    orders:[order(1,'zth-ENT-aaaaaaaaaaaaaaaaaaaaaaaa'),order(2,'zth-EXI-bbbbbbbbbbbbbbbbbbbbbbbb')],
    trades:[
      trade({id:1,orderId:1,side:'BUY',qty:1,price:100,commission:.04,time:1000}),
      trade({id:2,orderId:2,side:'SELL',qty:1,price:110,realizedPnl:10,commission:.044,time:2000}),
    ],
    funding:[{symbol:'BTCUSDT',incomeType:'FUNDING_FEE',income:'-0.20',asset:'USDT',time:1500}],
  });
  assert.equal(rows.length,1);
  const r=rows[0];
  assert.equal(r.entryPrice,100);
  assert.equal(r.exitPrice,110);
  assert.equal(r.grossRealizedPnl,10);
  assert.equal(r.commissionUsdt,.084);
  assert.equal(r.fundingUsdt,-.2);
  assert.ok(Math.abs(r.netUsdt-9.716)<1e-12);
  assert.equal(r.exactNetUsdt,true);
});

test('negative Binance commission is preserved as rebate and increases exact net',()=>{
  const rows=buildZenithClosedTradeHistory({
    orders:[order(3,'zth-ENT-cccccccccccccccccccccccc'),order(4,'zth-EXI-dddddddddddddddddddddddd')],
    trades:[
      trade({id:3,orderId:3,side:'BUY',qty:1,price:100,commission:-.01,time:1000}),
      trade({id:4,orderId:4,side:'SELL',qty:1,price:105,realizedPnl:5,commission:.02,time:2000}),
    ],
  });
  assert.equal(rows.length,1);
  assert.equal(rows[0].commissionUsdt,.01);
  assert.equal(rows[0].netUsdt,4.99);
});

test('partial entry and exit fills produce weighted actual prices and summed fees',()=>{
  const rows=buildZenithClosedTradeHistory({
    orders:[order(10,'zth-ENT-eeeeeeeeeeeeeeeeeeeeeeee'),order(11,'zth-EXI-ffffffffffffffffffffffff')],
    trades:[
      trade({id:10,orderId:10,side:'BUY',qty:1,price:100,commission:.02,time:1000}),
      trade({id:11,orderId:10,side:'BUY',qty:1,price:102,commission:.02,time:1100}),
      trade({id:12,orderId:11,side:'SELL',qty:.5,price:105,realizedPnl:2,commission:.01,time:1800}),
      trade({id:13,orderId:11,side:'SELL',qty:1.5,price:108,realizedPnl:10,commission:.03,time:2000}),
    ],
  });
  assert.equal(rows.length,1);
  const r=rows[0];
  assert.equal(r.entryPrice,101);
  assert.equal(r.exitPrice,(.5*105+1.5*108)/2);
  assert.equal(r.grossRealizedPnl,12);
  assert.equal(r.commissionUsdt,.08);
  assert.equal(r.netUsdt,11.92);
});

test('manual Binance positions are excluded from Zenith history',()=>{
  const rows=buildZenithClosedTradeHistory({
    orders:[order(20,'manual-entry'),order(21,'manual-exit')],
    trades:[
      trade({id:20,orderId:20,side:'BUY',qty:1,price:100,time:1000}),
      trade({id:21,orderId:21,side:'SELL',qty:1,price:105,realizedPnl:5,time:2000}),
    ],
  });
  assert.deepEqual(rows,[]);
});

test('non-USDT commission is preserved and prevents invented USDT conversion',()=>{
  const rows=buildZenithClosedTradeHistory({
    orders:[order(30,'zth-ENT-gggggggggggggggggggggggg'),order(31,'zth-EXI-hhhhhhhhhhhhhhhhhhhhhhhh')],
    trades:[
      trade({id:30,orderId:30,side:'BUY',qty:1,price:100,commission:.001,commissionAsset:'BNB',time:1000}),
      trade({id:31,orderId:31,side:'SELL',qty:1,price:110,realizedPnl:10,commission:.04,time:2000}),
    ],
  });
  assert.equal(rows.length,1);
  assert.equal(rows[0].exactNetUsdt,false);
  assert.equal(rows[0].netUsdt,null);
  assert.equal(rows[0].commissionByAsset.BNB,.001);
  assert.equal(rows[0].commissionByAsset.USDT,.04);
});

test('history merge keeps newest unique cycles',()=>{
  const a={id:'A',closedAt:100,netUsdt:1};
  const b={id:'B',closedAt:200,netUsdt:2};
  const newerA={id:'A',closedAt:300,netUsdt:3};
  assert.deepEqual(mergeTradeHistory([a,b],[newerA],10),[newerA,b]);
});

test('30-day history windows never overlap and each stays within Binance 7-day limit',()=>{
  const now=30*24*60*60*1000+12345;
  const windows=windowsFor(now);
  assert.ok(windows.length>=5);
  for(let i=0;i<windows.length;i++){
    const w=windows[i];
    assert.ok(w.endTime>=w.startTime);
    assert.ok(w.endTime-w.startTime<7*24*60*60*1000);
    if(i>0)assert.equal(w.startTime,windows[i-1].endTime+1);
  }
  assert.equal(windows.at(-1).endTime,now);
});

test('Zenith order discovery accepts deterministic Zenith client ids only',()=>{
  assert.equal(zenithOrder({clientOrderId:'zth-ENT-aaaaaaaaaaaaaaaaaaaaaaaa'}),true);
  assert.equal(zenithOrder({clientOrderId:'zth-EXI-bbbbbbbbbbbbbbbbbbbbbbbb'}),true);
  assert.equal(zenithOrder({clientOrderId:'manual-order'}),false);
});

test('history API discovers symbols first and calls userTrades with mandatory symbol',()=>{
  const source=fs.readFileSync('api/binance-history.js','utf8');
  assert.match(source,/\/fapi\/v1\/allOrders/);
  assert.match(source,/orders\.filter\(zenithOrder\)/);
  assert.match(source,/\/fapi\/v1\/userTrades/);
  assert.match(source,/symbol:job\.symbol/);
  assert.match(source,/\/fapi\/v1\/income/);
  assert.match(source,/incomeType:'FUNDING_FEE'/);
  assert.match(source,/BINANCE_HISTORY_WINDOW_TRUNCATED/);
  assert.doesNotMatch(source,/method:'POST'.*fapi\/v1\/order/s);
});


test('UI history is Binance-real only and never displays protection level numbers',()=>{
  const html=fs.readFileSync('index.html','utf8');
  const start=html.indexOf('function renderHistory(){');
  const end=html.indexOf('function applyTheme()',start);
  assert.ok(start>=0&&end>start);
  const block=html.slice(start,end);
  assert.match(block,/binanceHistory\.history/);
  assert.match(block,/grossRealizedPnl/);
  assert.match(block,/commissionUsdt/);
  assert.match(block,/fundingUsdt/);
  assert.match(block,/netUsdt/);
  assert.doesNotMatch(block,/Niveau|Protection|level/i);
  assert.ok(html.includes('id="refreshHistoryBtn"'));
  assert.equal(html.includes('id="resetClosedBtn"'),false);
  assert.match(html,/Historique réel Binance/);
  assert.match(html,/Achat exécuté/);
  assert.match(html,/Vente exécutée/);
  assert.match(html,/Net encaissé/);
  assert.ok(html.trimEnd().endsWith('</html>'));
});
