import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClosedZenithTradeHistory, managedOrderIndex } from '../lib/binance-trade-history.mjs';

test('closed Zenith LONG uses actual fill prices and Binance net values',()=>{
  const orders=[
    {symbol:'BTCUSDT',orderId:1,clientOrderId:'zth-ENT-aaaaaaaaaaaaaaaaaaaaaaaa',side:'BUY',type:'LIMIT',time:1000},
    {symbol:'BTCUSDT',orderId:2,clientOrderId:'zth-EXI-bbbbbbbbbbbbbbbbbbbbbbbb',side:'SELL',type:'LIMIT',time:2000},
  ];
  const trades=[
    {symbol:'BTCUSDT',id:11,orderId:1,side:'BUY',price:'100',qty:'1',realizedPnl:'0',commission:'0.10',commissionAsset:'USDT',time:1000},
    {symbol:'BTCUSDT',id:12,orderId:2,side:'SELL',price:'110',qty:'1',realizedPnl:'10',commission:'0.11',commissionAsset:'USDT',time:2000},
  ];
  const incomes=[
    {symbol:'BTCUSDT',incomeType:'FUNDING_FEE',income:'-0.20',asset:'USDT',time:1500},
  ];
  const [row]=buildClosedZenithTradeHistory({orders,trades,incomes});
  assert.equal(row.entryPrice,100);
  assert.equal(row.exitPrice,110);
  assert.equal(row.realizedPnl,10);
  assert.equal(row.commission,0.21);
  assert.equal(row.funding,-0.20);
  assert.ok(Math.abs(row.netPnl-9.59)<1e-10);
  assert.equal(row.exactNet,true);
  assert.equal(row.reason,'VENTE LIMIT');
  assert.doesNotMatch(row.reason,/niveau/i);
});

test('partial fills produce quantity-weighted actual entry and exit prices',()=>{
  const orders=[
    {symbol:'ETHUSDT',orderId:10,clientOrderId:'zth-ENT-cccccccccccccccccccccccc',side:'BUY'},
    {symbol:'ETHUSDT',orderId:20,clientOrderId:'zth-EXI-dddddddddddddddddddddddd',side:'SELL'},
  ];
  const trades=[
    {symbol:'ETHUSDT',id:1,orderId:10,side:'BUY',price:'100',qty:'1',realizedPnl:'0',commission:'0.01',commissionAsset:'USDT',time:1000},
    {symbol:'ETHUSDT',id:2,orderId:10,side:'BUY',price:'102',qty:'1',realizedPnl:'0',commission:'0.01',commissionAsset:'USDT',time:1100},
    {symbol:'ETHUSDT',id:3,orderId:20,side:'SELL',price:'109',qty:'0.5',realizedPnl:'4',commission:'0.01',commissionAsset:'USDT',time:2000},
    {symbol:'ETHUSDT',id:4,orderId:20,side:'SELL',price:'111',qty:'1.5',realizedPnl:'16',commission:'0.02',commissionAsset:'USDT',time:2100},
  ];
  const [row]=buildClosedZenithTradeHistory({orders,trades,incomes:[]});
  assert.equal(row.entryPrice,101);
  assert.equal(row.exitPrice,110.5);
  assert.equal(row.quantity,2);
  assert.equal(row.realizedPnl,20);
  assert.ok(Math.abs(row.netPnl-19.95)<1e-10);
});

test('non-USDT commission is never presented as exact net',()=>{
  const orders=[
    {symbol:'SOLUSDT',orderId:30,clientOrderId:'zth-ENT-eeeeeeeeeeeeeeeeeeeeeeee',side:'BUY'},
    {symbol:'SOLUSDT',orderId:31,clientOrderId:'zth-EXI-ffffffffffffffffffffffff',side:'SELL'},
  ];
  const trades=[
    {symbol:'SOLUSDT',id:1,orderId:30,side:'BUY',price:'10',qty:'1',realizedPnl:'0',commission:'0.001',commissionAsset:'BNB',time:1000},
    {symbol:'SOLUSDT',id:2,orderId:31,side:'SELL',price:'12',qty:'1',realizedPnl:'2',commission:'0.01',commissionAsset:'USDT',time:2000},
  ];
  const [row]=buildClosedZenithTradeHistory({orders,trades,incomes:[]});
  assert.equal(row.exactNet,false);
  assert.deepEqual(row.otherCommissions,[{asset:'BNB',amount:0.001}]);
  assert.equal(row.netPnl,1.99);
});

test('cycles with no Zenith order are excluded from Zenith history',()=>{
  const orders=[
    {symbol:'XRPUSDT',orderId:40,clientOrderId:'manual-order',side:'BUY'},
    {symbol:'XRPUSDT',orderId:41,clientOrderId:'manual-close',side:'SELL'},
  ];
  const trades=[
    {symbol:'XRPUSDT',id:1,orderId:40,side:'BUY',price:'1',qty:'100',realizedPnl:'0',commission:'0',commissionAsset:'USDT',time:1000},
    {symbol:'XRPUSDT',id:2,orderId:41,side:'SELL',price:'1.1',qty:'100',realizedPnl:'10',commission:'0',commissionAsset:'USDT',time:2000},
  ];
  assert.deepEqual(buildClosedZenithTradeHistory({orders,trades,incomes:[]}),[]);
});

test('managed order index accepts only Zenith deterministic client ids',()=>{
  const idx=managedOrderIndex([
    {symbol:'BTCUSDT',orderId:1,clientOrderId:'zth-ENT-aaaaaaaaaaaaaaaaaaaaaaaa'},
    {symbol:'ETHUSDT',orderId:2,clientOrderId:'someone-else'},
  ]);
  assert.equal(idx.ids.has('1'),true);
  assert.equal(idx.ids.has('2'),false);
  assert.deepEqual(idx.symbols,['BTCUSDT']);
});
