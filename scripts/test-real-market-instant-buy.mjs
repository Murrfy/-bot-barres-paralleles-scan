import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildControllerMarketEntryCommand } from '../lib/controller-real-command.mjs';
import { buildMasterCommandDispatch } from '../lib/master-command-dispatch.mjs';
import { buildEntryOrderPlan } from '../lib/order-intent.mjs';

const now=1_800_000_000_000;
const riskSnapshot={
  ready:true,
  observedAt:now-500,
  normalized:{
    symbol:'BTCUSDT',positionMode:'ONE_WAY',marginType:'ISOLATED',
    margin:100,leverage:10,maxLoss:40,referencePrice:50000,quantity:0.02,
  },
};

test('controller can build only an explicit BUY MARKET instant command',()=>{
  const command=buildControllerMarketEntryCommand('btcusdt',{margin:100,leverage:10,maxLoss:40},now);
  assert.equal(command.type,'EXEC_OPEN_MARKET_POSITION');
  assert.equal(command.payload.symbol,'BTCUSDT');
  assert.equal(command.payload.side,'BUY');
  assert.equal(command.payload.orderType,'MARKET');
  assert.equal(command.payload.requestedAt,now);
  assert.equal('limitPrice' in command.payload,false);
});

test('MARKET entry plan has no price and asks Binance for RESULT',()=>{
  const plan=buildEntryOrderPlan({
    command:{id:'market-command-123',symbol:'BTCUSDT',side:'BUY',orderType:'MARKET',margin:100,leverage:10,maxLoss:40},
    riskSnapshot,now,
  });
  assert.equal(plan.params.type,'MARKET');
  assert.equal(plan.params.newOrderRespType,'RESULT');
  assert.equal(plan.params.reduceOnly,'false');
  assert.equal('price' in plan.params,false);
  assert.equal('timeInForce' in plan.params,false);
});

test('MASTER dispatch preserves explicit MARKET semantics and click timestamp',()=>{
  const dispatch=buildMasterCommandDispatch({
    id:'market-command-123',
    type:'EXEC_OPEN_MARKET_POSITION',
    payload:{symbol:'BTCUSDT',side:'BUY',orderType:'MARKET',margin:100,leverage:10,maxLoss:40,requestedAt:now},
  });
  assert.equal(dispatch.supported,true);
  assert.equal(dispatch.endpoint,'/api/binance-entry-execute');
  assert.equal(dispatch.body.type,'EXEC_OPEN_MARKET_POSITION');
  assert.equal(dispatch.body.phase,'SUBMIT_MARKET_ENTRY');
  assert.equal(dispatch.body.requestedAt,now);
  assert.equal('limitPrice' in dispatch.body,false);
});

test('central queue accepts explicit MARKET only in RUNNING and expires it quickly',()=>{
  const source=fs.readFileSync('api/zenith-sync.js','utf8');
  const pauseStart=source.indexOf('const PAUSE_PENDING_ALLOWED_COMMANDS');
  const allowStart=source.indexOf('const ALLOWED_COMMAND_TYPES');
  const protectiveStart=source.indexOf('const PROTECTIVE_EXEC_COMMANDS');
  assert.ok(pauseStart>=0&&allowStart>pauseStart&&protectiveStart>allowStart);
  const pauseBlock=source.slice(pauseStart,allowStart);
  const allowBlock=source.slice(allowStart,protectiveStart);
  assert.doesNotMatch(pauseBlock,/EXEC_OPEN_MARKET_POSITION/);
  assert.match(allowBlock,/EXEC_OPEN_MARKET_POSITION/);
  assert.match(source,/type === 'EXEC_OPEN_MARKET_POSITION' \? 15 \* 1000 : COMMAND_MAX_AGE_MS/);
  assert.match(source,/MARKET_ENTRY_REQUEST_STALE/);
  assert.match(source,/age > 30000/);
});

test('entry API MARKET path bypasses LIMIT transition but keeps final dispatch gate',()=>{
  const source=fs.readFileSync('api/binance-entry-execute.js','utf8');
  const market=source.indexOf('if(marketEntry){');
  const limitPrepare=source.indexOf("if(phase==='PREPARE_PROTECTION')",market);
  assert.ok(market>=0&&limitPrepare>market);
  const block=source.slice(market,limitPrepare);
  assert.match(block,/finalEntryDispatchGate/);
  assert.match(block,/placeStandardOrderIdempotent/);
  assert.match(block,/BINANCE_MARKET_ENTRY_DISPATCH/);
  assert.match(block,/maxLossRepairRequired:true/);
  assert.doesNotMatch(block,/readEntryTransition/);
  assert.match(source,/requestedPrice:marketEntry\?0:limitPrice/);
});

test('Render ACK occurs only after fill, position, reconciliation and MAX-LOSS confirmation',()=>{
  const source=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  const start=source.indexOf('async function runMarketEntry');
  const end=source.indexOf('async function runProtectiveUpdate',start);
  assert.ok(start>=0&&end>start);
  const block=source.slice(start,end);
  const submit=block.indexOf('callEntryExecute(body)');
  const fill=block.indexOf('waitForStreamOrder');
  const position=block.indexOf('waitForLongPosition');
  const reconcile=block.indexOf('awaitReconciliation');
  const maxloss=block.indexOf('uniqueManagedMaxLoss');
  const ack=block.indexOf('ackCommand');
  assert.ok(submit>=0&&fill>submit&&position>fill&&reconcile>position&&maxloss>reconcile&&ack>maxloss);
  assert.match(block,/MARKET_ENTRY_AMBIGUOUS_/);
  assert.match(block,/scheduleReconcile\(100\)/);
  assert.match(block,/maxLossConfirmed:true/);
});

test('watched automatic entries remain LIMIT with pre-entry MAX-LOSS preparation',()=>{
  const source=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  const start=source.indexOf('async function executeWatchedEntry');
  const end=source.indexOf('async function processEntryWatchPrice',start);
  const block=source.slice(start,end);
  assert.match(block,/orderType:'LIMIT'/);
  assert.match(block,/phase:'PREPARE_PROTECTION'/);
  assert.match(block,/phase:'SUBMIT_ENTRY'/);
  assert.doesNotMatch(block,/orderType:'MARKET'/);
});

test('iPhone instant-buy path queues real MARKET and never creates a local position',()=>{
  const html=fs.readFileSync('index.html','utf8');
  const start=html.indexOf('async function instantBuySelected()');
  const end=html.indexOf('async function manualClose',start);
  const block=html.slice(start,end);
  assert.match(block,/buildControllerMarketEntryCommand/);
  assert.match(block,/\/api\/zenith-sync\?action=command/);
  assert.match(block,/ACHAT IMMÉDIAT MARKET/);
  assert.match(block,/Aucune simulation ne sera créée/);
  assert.match(block,/validated\[s\]/);
  assert.doesNotMatch(block,/createPosition\(/);
});

test('MARKET remains forbidden for every sell planner',()=>{
  const intent=fs.readFileSync('lib/order-intent.mjs','utf8');
  const close=fs.readFileSync('lib/protective-close-state.mjs','utf8');
  const protective=fs.readFileSync('api/binance-protective-execute.js','utf8');
  assert.doesNotMatch(close,/MARKET_LAST_RESORT/);
  assert.match(protective,/EXIT_MODE_LIMIT_REQUIRED/);
  assert.match(intent,/mode === 'NORMAL_LIMIT'/);
  assert.match(intent,/mode === 'PROTECTIVE_IOC'/);
  assert.doesNotMatch(intent,/EXIT_MARKET/);
});
