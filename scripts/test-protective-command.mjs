import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProtectiveUpdatePayload, validateUpdateAgainstLivePosition, triggeredMaxLossRemainderTargets, triggeredMaxLossRemainderRecoveryAllowed } from '../lib/protective-command.mjs';

const position={symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.02',entryPrice:50000};

test('exit update requires exact full live quantity and favorable target',()=>{
  const u=normalizeProtectiveUpdatePayload('EXEC_UPDATE_EXIT',{
    symbol:'btcusdt',direction:'LONG',quantity:0.02,targetPrice:51000,previousClientOrderId:'zth-EXI-abc123'
  });
  const live=validateUpdateAgainstLivePosition(u,position);
  assert.equal(live.liveQuantity,0.02);
  assert.throws(()=>validateUpdateAgainstLivePosition({...u,quantity:0.01},position),/FULL_POSITION_QUANTITY_REQUIRED/);
  assert.throws(()=>validateUpdateAgainstLivePosition({...u,targetPrice:49000},position),/LONG_TARGET_MUST_BE_ABOVE_ENTRY/);
});

test('progressive and max-loss triggers stay on their correct side of entry',()=>{
  const progressive=normalizeProtectiveUpdatePayload('EXEC_UPDATE_PROTECTION',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:50500,limitPrice:50500,protectionKind:'PROGRESSIVE'
  });
  validateUpdateAgainstLivePosition(progressive,position);
  assert.throws(()=>validateUpdateAgainstLivePosition({...progressive,triggerPrice:49000},position),/LONG_PROGRESSIVE_TRIGGER_BELOW_ENTRY/);

  const maxLoss=normalizeProtectiveUpdatePayload('EXEC_UPDATE_PROTECTION',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:48000,protectionKind:'MAX_LOSS'
  });
  validateUpdateAgainstLivePosition(maxLoss,position);
  assert.throws(()=>validateUpdateAgainstLivePosition({...maxLoss,triggerPrice:51000},position),/LONG_MAX_LOSS_TRIGGER_NOT_BELOW_ENTRY/);
});

test('only Zenith-managed previous ids may be replaced automatically',()=>{
  assert.throws(()=>normalizeProtectiveUpdatePayload('EXEC_UPDATE_EXIT',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,targetPrice:51000,previousClientOrderId:'manual-order-1'
  }),/PREVIOUS_EXIT_ID_INVALID/);
  assert.throws(()=>normalizeProtectiveUpdatePayload('EXEC_UPDATE_PROTECTION',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:50500,limitPrice:50500,protectionKind:'PROGRESSIVE',
    previousClientAlgoId:'manual-protection'
  }),/PREVIOUS_PROTECTION_ID_INVALID/);
});


test('progressive command requires the explicit LIMIT to equal the protected trigger',()=>{
  assert.throws(()=>normalizeProtectiveUpdatePayload('EXEC_UPDATE_PROTECTION',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,
    triggerPrice:50500,protectionKind:'PROGRESSIVE'
  }),/PROGRESSIVE_LIMIT_PRICE_REQUIRED/);
  assert.throws(()=>normalizeProtectiveUpdatePayload('EXEC_UPDATE_PROTECTION',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,
    triggerPrice:50500,limitPrice:50499.9,protectionKind:'PROGRESSIVE'
  }),/PROGRESSIVE_TRIGGER_LIMIT_MUST_MATCH/);
});


test('triggered MAX-LOSS remainder recovery is bound to exact deterministic next IOC attempt',()=>{
  const report={
    version:2,status:'MISMATCH',failClosed:true,
    reasons:['MISSING_BINANCE_PROTECTION','MISSING_BINANCE_MAX_LOSS_PROTECTION','TRIGGERED_MAX_LOSS_REMAINDER'],
    differences:{triggeredMaxLossRemainders:[{
      symbol:'BTCUSDT',direction:'LONG',
      remainingQuantity:0.3,originalQuantity:1,executedQuantity:0.7,
      clientAlgoId:'zth-MAX-0123456789abcdef01234567',
      algoId:'7788',actualOrderId:'9911',actualOrderStatus:'EXPIRED',
      recoveryCommandId:'maxloss-remainder:zth-MAX-0123456789abcdef01234567:9911',
      triggerPrice:49600,triggerTime:1700000000000,
      nextAttempt:2,priceMatch:'OPPONENT_10',
    }]}
  };
  const rows=triggeredMaxLossRemainderTargets(report);
  assert.equal(rows.length,1);
  assert.equal(rows[0].nextAttempt,2);
  assert.equal(rows[0].priceMatch,'OPPONENT_10');
  const payload={
    type:'EXEC_CLOSE_POSITION',symbol:'BTCUSDT',direction:'LONG',quantity:0.3,closeAll:true,
    commandId:rows[0].recoveryCommandId,recoveryReason:'TRIGGERED_MAX_LOSS_REMAINDER',
    attempt:2,priceMatch:'OPPONENT_10',
  };
  assert.equal(triggeredMaxLossRemainderRecoveryAllowed(report,payload),true);
  assert.equal(triggeredMaxLossRemainderRecoveryAllowed(report,{...payload,attempt:1,priceMatch:'OPPONENT_5'}),false);
  assert.equal(triggeredMaxLossRemainderRecoveryAllowed(report,{...payload,quantity:0.31}),false);
  const unsafe={...report,reasons:[...report.reasons,'INCONSISTENT_TRIGGERED_MAX_LOSS_RESULT']};
  assert.deepEqual(triggeredMaxLossRemainderTargets(unsafe),[]);
});
