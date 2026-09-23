import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProtectiveUpdatePayload, validateUpdateAgainstLivePosition } from '../lib/protective-command.mjs';

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
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:50500,protectionKind:'PROGRESSIVE'
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
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:50500,protectionKind:'PROGRESSIVE',
    previousClientAlgoId:'manual-protection'
  }),/PREVIOUS_PROTECTION_ID_INVALID/);
});
