import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildControllerMarketEntryCommand } from '../lib/controller-real-command.mjs';
import { buildEntryOrderPlan, buildExitOrderPlan } from '../lib/order-intent.mjs';

const now=1_800_000_000_000;
const riskSnapshot={
  ready:true,
  observedAt:now-500,
  normalized:{
    symbol:'BTCUSDT',
    positionMode:'ONE_WAY',
    marginType:'ISOLATED',
    margin:100,
    leverage:10,
    maxLoss:40,
    referencePrice:50000,
    quantity:0.02,
  },
};

test('controller MARKET command is explicit BUY-only real intent',()=>{
  const command=buildControllerMarketEntryCommand('btcusdt',{margin:100,leverage:10,maxLoss:40},now);
  assert.equal(command.type,'EXEC_OPEN_MARKET_POSITION');
  assert.equal(command.payload.symbol,'BTCUSDT');
  assert.equal(command.payload.side,'BUY');
  assert.equal(command.payload.orderType,'MARKET');
  assert.equal(command.payload.requestedAt,now);
  assert.match(command.clientCommandId,/^realmarket:BTCUSDT:/);
});

test('MARKET entry planner never adds a limit price and asks Binance for RESULT',()=>{
  const plan=buildEntryOrderPlan({
    command:{id:'market-cmd-12345',symbol:'BTCUSDT',side:'BUY',orderType:'MARKET',margin:100,leverage:10,maxLoss:40},
    riskSnapshot,
    now,
  });
  assert.equal(plan.params.type,'MARKET');
  assert.equal(plan.params.newOrderRespType,'RESULT');
  assert.equal('price' in plan.params,false);
  assert.equal('timeInForce' in plan.params,false);
  assert.equal(plan.params.reduceOnly,'false');
});

test('MARKET is still impossible on every exit plan',()=>{
  assert.throws(
    ()=>buildExitOrderPlan({commandId:'exit-cmd-12345',symbol:'BTCUSDT',direction:'LONG',quantity:0.02,exitMode:'MARKET_LAST_RESORT'}),
    /EXIT_MODE_INVALID/
  );
});

test('Render does not ACK an instant MARKET buy before live fill and MAX-LOSS reconciliation',()=>{
  const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  const start=worker.indexOf('async function runMarketEntry');
  const end=worker.indexOf('async function runProtectiveUpdate',start);
  assert.ok(start>=0&&end>start);
  const fn=worker.slice(start,end);
  assert.match(fn,/waitForStreamOrder\(\{kind:'STANDARD',clientId:clientOrderId,terminal:true\}/);
  assert.match(fn,/waitForLongPosition\(symbol,5000\)/);
  assert.match(fn,/await awaitReconciliation\(15000\)/);
  assert.match(fn,/uniqueManagedMaxLoss\(confirmedPosition,projection\.binanceOrders\|\|\[\],configuredMaxLoss\)/);
  assert.ok(fn.indexOf('await awaitReconciliation(15000)')<fn.indexOf('await ackCommand(raw'));
  assert.ok(fn.indexOf('maxLossConfirmed')<fn.indexOf('await ackCommand(raw'));
});

test('ambiguous MARKET write is never blindly retried',()=>{
  const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  const start=worker.indexOf('async function runMarketEntry');
  const end=worker.indexOf('async function runProtectiveUpdate',start);
  const fn=worker.slice(start,end);
  assert.match(fn,/MARKET_ENTRY_AMBIGUOUS_/);
  const ambiguousBlock=fn.slice(fn.indexOf('if\(ambiguous\|\|wrote\)'),fn.indexOf("if\(\[409,423,429,503\]"));
  assert.doesNotMatch(ambiguousBlock,/requeueCommand\(/);
  assert.match(ambiguousBlock,/scheduleReconcile\(100\)/);
});

test('central ACK independently requires live MARKET position and configured MAX-LOSS coverage',()=>{
  const sync=fs.readFileSync('api/zenith-sync.js','utf8');
  assert.match(sync,/if \(commandType === 'EXEC_OPEN_MARKET_POSITION'\)/);
  assert.match(sync,/EXECUTION_ACK_MARKET_POSITION_MISMATCH/);
  assert.match(sync,/EXECUTION_ACK_MARGIN_NOT_ISOLATED/);
  assert.match(sync,/EXECUTION_ACK_AUTO_ADD_MARGIN_ENABLED/);
  assert.match(sync,/EXECUTION_ACK_EMERGENCY_PROTECTION_MISSING/);
  assert.match(sync,/EXECUTION_ACK_MAX_LOSS_EXCEEDS_CONFIGURED_LIMIT/);
  assert.match(sync,/kind:'EXEC_MARKET_ENTRY_CONFIRMED'/);
  assert.match(sync,/type === 'EXEC_OPEN_MARKET_POSITION' \? 30 \* 1000/);
});

test('iPhone instant-buy path queues real MARKET only and never creates a local position',()=>{
  const html=fs.readFileSync('index.html','utf8');
  const start=html.indexOf('async function instantBuySelected()');
  const end=html.indexOf('async function manualClose',start);
  assert.ok(start>=0&&end>start);
  const fn=html.slice(start,end);
  assert.match(fn,/buildControllerMarketEntryCommand/);
  assert.match(fn,/\/api\/zenith-sync\?action=command/);
  assert.match(fn,/realMarketEntryPending/);
  assert.match(fn,/ARGENT RÉEL — ACHAT IMMÉDIAT MARKET/);
  assert.doesNotMatch(fn,/createPosition\(/);
});
