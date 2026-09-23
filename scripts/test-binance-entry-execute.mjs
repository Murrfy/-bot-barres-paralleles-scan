import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ZENITH_REAL_TRADING_ENABLED='1';
process.env.ZENITH_REAL_ENTRY_ENABLED='0';
process.env.ZENITH_BINANCE_WRITE_ENABLED='1';
process.env.ZENITH_PAIRING_DISABLED='1';
process.env.VERCEL_GIT_COMMIT_SHA='deploy-test-sha';

const {
  armReason,
  commandRequest,
  validateExistingEntry,
}=await import('../api/binance-entry-execute.js');

test('real entry has a dedicated release lock even when global trading locks are open',()=>{
  const reason=armReason({
    version:1,
    masterDeviceId:'master-1',
    deploymentSha:'deploy-test-sha',
  },'master-1');
  assert.equal(reason,'REAL_ENTRY_DISABLED');
});

test('entry execution accepts LIMIT only and enforces server risk caps',()=>{
  const q=commandRequest({
    commandId:'command-open-1234',
    symbol:'btcusdt',
    side:'BUY',
    orderType:'LIMIT',
    limitPrice:50000,
    margin:100,
    leverage:10,
    maxLoss:40,
  });
  assert.equal(q.symbol,'BTCUSDT');
  assert.equal(q.orderType,'LIMIT');

  assert.throws(()=>commandRequest({...q,commandId:'command-open-1234',orderType:'MARKET'}),/REAL_ENTRY_LIMIT_ONLY/);
  assert.throws(()=>commandRequest({...q,commandId:'command-open-1234',leverage:11}),/LEVERAGE_INVALID/);
  assert.throws(()=>commandRequest({...q,commandId:'command-open-1234',margin:1001}),/MARGIN_INVALID/);
  assert.throws(()=>commandRequest({...q,commandId:'command-open-1234',maxLoss:401}),/MAX_LOSS_INVALID/);
});

test('recovery accepts only the deterministic matching non-reduce-only entry',()=>{
  const request=commandRequest({
    commandId:'command-open-1234',
    symbol:'BTCUSDT',
    side:'BUY',
    orderType:'LIMIT',
    limitPrice:50000,
    margin:100,
    leverage:10,
    maxLoss:40,
  });
  const cid='zth-ENT-0123456789abcdef01234567';
  const base={
    symbol:'BTCUSDT',
    clientOrderId:cid,
    side:'BUY',
    positionSide:'BOTH',
    reduceOnly:false,
    type:'LIMIT',
    price:'50000',
    origQty:'0.02',
  };
  assert.equal(validateExistingEntry(base,request,cid),'');
  assert.equal(validateExistingEntry({...base,reduceOnly:true},request,cid),'ENTRY_EXISTING_REDUCE_ONLY');
  assert.equal(validateExistingEntry({...base,side:'SELL'},request,cid),'ENTRY_EXISTING_SIDE_MISMATCH');
  assert.equal(validateExistingEntry({...base,price:'50001'},request,cid),'ENTRY_EXISTING_PRICE_MISMATCH');
});
