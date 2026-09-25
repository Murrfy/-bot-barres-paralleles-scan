import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildZenithClosedTradeHistory, mergeTradeHistory } from '../lib/real-trade-history.mjs';

function order(orderId,clientOrderId,symbol='BTCUSDT'){
  return {symbol,orderId,clientOrderId};
}
function trade({id,orderId,side,qty,price,realizedPnl=0,commission=0,commissionAsset='USDT',time,symbol='BTCUSDT'}){
  return {id,orderId,side,qty:String(qty),price:String(price),realizedPnl:String(realizedPnl),commission:String(commission),commissionAsset,time,symbol,positionSide:'BOTH'};
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
  assert.ok(Math.abs(r.commissionUsdt-.084)<1e-12);
  assert.equal(r.fundingUsdt,-.2);
  assert.ok(Math.abs(r.netUsdt-9.716)<1e-12);
  assert.equal(r.exactNetUsdt,true);
});

test('partial entry and exit fills produce weighted actual prices and summed fees',()=>{
  const rows=buildZenithClosedTradeHistory({
    orders:[order(10,'zth-ENT-cccccccccccccccccccccccc'),order(11,'zth-EXI-dddddddddddddddddddddddd')],
    trades:[
      trade({id:1,orderId:10,side:'BUY',qty:1,price:100,commission:.02,time:1000}),
      trade({id:2,orderId:10,side:'BUY',qty:1,price:102,commission:.02,time:1100}),
      trade({id:3,orderId:11,side:'SELL',qty:.5,price:105,realizedPnl:2,commission:.01,time:1800}),
      trade({id:4,orderId:11,side:'SELL',qty:1.5,price:108,realizedPnl:10,commission:.03,time:2000}),
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
      trade({id:1,orderId:20,side:'BUY',qty:1,price:100,time:1000}),
      trade({id:2,orderId:21,side:'SELL',qty:1,price:105,realizedPnl:5,time:2000}),
    ],
  });
  assert.deepEqual(rows,[]);
});

test('non-USDT fee is preserved exactly and prevents invented USDT net conversion',()=>{
  const rows=buildZenithClosedTradeHistory({
    orders:[order(30,'zth-ENT-eeeeeeeeeeeeeeeeeeeeeeee'),order(31,'zth-EXI-ffffffffffffffffffffffff')],
    trades:[
      trade({id:1,orderId:30,side:'BUY',qty:1,price:100,commission:.001,commissionAsset:'BNB',time:1000}),
      trade({id:2,orderId:31,side:'SELL',qty:1,price:110,realizedPnl:10,commission:.04,time:2000}),
    ],
  });
  assert.equal(rows.length,1);
  assert.equal(rows[0].exactNetUsdt,false);
  assert.equal(rows[0].netUsdt,null);
  assert.equal(rows[0].feesByAsset.BNB,.001);
  assert.equal(rows[0].feesByAsset.USDT,.04);
});

test('history merge is stable and keeps newest unique cycles',()=>{
  const a={id:'A',closedAt:100,netUsdt:1};
  const b={id:'B',closedAt:200,netUsdt:2};
  const newerA={id:'A',closedAt:300,netUsdt:3};
  assert.deepEqual(mergeTradeHistory([a,b],[newerA],10),[newerA,b]);
});

test('UI history is Binance-real only and never displays protection level numbers',()=>{
  const html=fs.readFileSync('index.html','utf8');
  const helpersStart=html.indexOf('function historyFeeText');
  const start=html.indexOf('function renderHistory(){',helpersStart);
  const end=html.indexOf('function applyTheme()',start);
  assert.ok(helpersStart>=0&&start>helpersStart&&end>start);
  const helpers=html.slice(helpersStart,start);
  const block=html.slice(start,end);
  assert.match(helpers,/commissionUsdt/);
  assert.match(helpers,/fundingUsdt/);
  assert.match(block,/binanceHistory\.history/);
  assert.match(block,/grossRealizedPnl/);
  assert.match(block,/historyFeeText\(row\)/);
  assert.match(block,/historyFundingText\(row\)/);
  assert.match(block,/netUsdt/);
  assert.doesNotMatch(helpers+block,/Niveau|Protection|level/i);
  assert.ok(html.includes('id="refreshHistoryBtn"'));
  assert.equal(html.includes('id="resetClosedBtn"'),false);
});

test('history API is read-only and uses official Futures trade/order/income sources',()=>{
  const source=fs.readFileSync('api/binance-history.js','utf8');
  assert.match(source,/\/fapi\/v1\/userTrades/);
  assert.match(source,/\/fapi\/v1\/allOrders/);
  assert.match(source,/\/fapi\/v1\/income/);
  assert.match(source,/incomeType:'FUNDING_FEE'/);
  assert.match(source,/KEY_ARCHIVE/);
  assert.match(source,/BINANCE_HISTORY_WINDOW_TRUNCATED/);
  assert.doesNotMatch(source,/method:'POST'.*fapi\/v1\/order/s);
});
