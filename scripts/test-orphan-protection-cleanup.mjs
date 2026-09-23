import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { orphanZenithCleanupOrders } from '../lib/protective-command.mjs';

function report(rows,reasons=['ORPHAN_ZENITH_PROTECTIVE_ORDER']){
  return {
    version:2,status:'MISMATCH',failClosed:true,reasons,
    differences:{orphanZenithProtectiveOrders:rows}
  };
}

const standard={
  orderClass:'STANDARD',symbol:'BTCUSDT',clientOrderId:'zth-EXI-0123456789abcdef01234567',
  side:'SELL',positionSide:'BOTH',type:'LIMIT',reduceOnly:true,closePosition:false,
  price:'51000',timeInForce:'GTC'
};
const algo={
  orderClass:'ALGO',symbol:'BTCUSDT',clientAlgoId:'zth-PRO-0123456789abcdef01234567',
  side:'SELL',positionSide:'BOTH',type:'STOP',reduceOnly:true,closePosition:false,
  price:'50500',triggerPrice:'50500',timeInForce:'GTC'
};

test('cleanup targets are accepted only for the exact orphan-only reconciliation state',()=>{
  assert.equal(orphanZenithCleanupOrders(report([standard])).length,1);
  assert.equal(orphanZenithCleanupOrders(report([algo])).length,1);
  assert.deepEqual(orphanZenithCleanupOrders(report([standard],[
    'ORPHAN_ZENITH_PROTECTIVE_ORDER','RUNTIME_STATE_STALE'
  ])),[]);
});

test('external or malformed order ids are never eligible for automatic cleanup',()=>{
  assert.deepEqual(orphanZenithCleanupOrders(report([{...standard,clientOrderId:'manual-exit'}])),[]);
  assert.deepEqual(orphanZenithCleanupOrders(report([{...algo,clientAlgoId:'manual-stop'}])),[]);
});

test('orphan cleanup endpoint requires direct Binance flat-position proof before cancellation',async()=>{
  const api=await readFile(new URL('../api/binance-protective-update-execute.js',import.meta.url),'utf8');
  assert.match(api,/EXEC_CLEAN_ORPHAN_PROTECTION/);
  assert.match(api,/\/fapi\/v3\/positionRisk/);
  assert.match(api,/DIRECT_POSITION_PROOF_MISSING/);
  assert.match(api,/ORPHAN_CLEANUP_POSITION_NOT_FLAT/);
  assert.match(api,/cancelReduceOnlyOrderIdempotent/);
  assert.match(api,/cancelAlgoOrderIdempotent/);
});

test('MASTER only auto-cleans report-confirmed orphan targets and waits for stream terminal proof',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/orphanZenithCleanupOrders\(q\.report\)/);
  assert.match(html,/EXEC_CLEAN_ORPHAN_PROTECTION/);
  assert.match(html,/waitForStreamOrder\(\{/);
  assert.match(html,/ORPHAN_CLEANUP_STREAM_NOT_CONFIRMED/);
});

test('UI distinguishes private account access from public Binance market data',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/COMPTE BINANCE INACCESSIBLE/);
  assert.match(html,/prix publics Binance disponibles · compte Futures privé inaccessible/);
  assert.doesNotMatch(html,/BINANCE HORS LIGNE/);
});
