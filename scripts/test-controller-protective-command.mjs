import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControllerUpdateExitCommand,
  buildControllerUpdateProtectionCommand,
} from '../lib/controller-real-command.mjs';

const longPosition={
  symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.02',
  entryPrice:'50000',updateTime:12345
};
const shortPosition={
  symbol:'ETHUSDT',positionSide:'BOTH',positionAmt:'-2',
  entryPrice:'3000',updateTime:54321
};

test('iPhone builds exact full-position exit update command',()=>{
  const c=buildControllerUpdateExitCommand(longPosition,51000,'zth-EXI-abcdef');
  assert.equal(c.type,'EXEC_UPDATE_EXIT');
  assert.equal(c.payload.symbol,'BTCUSDT');
  assert.equal(c.payload.direction,'LONG');
  assert.equal(c.payload.quantity,0.02);
  assert.equal(c.payload.targetPrice,51000);
  assert.equal(c.payload.previousClientOrderId,'zth-EXI-abcdef');
  assert.match(c.clientCommandId,/^[A-Za-z0-9._:-]{8,128}$/);
});

test('iPhone rejects wrong-side targets and non-Zenith replacement ids',()=>{
  assert.throws(()=>buildControllerUpdateExitCommand(longPosition,49000),/LONG_TARGET_MUST_BE_ABOVE_ENTRY/);
  assert.throws(()=>buildControllerUpdateExitCommand(shortPosition,3100),/SHORT_TARGET_MUST_BE_BELOW_ENTRY/);
  assert.throws(()=>buildControllerUpdateExitCommand(longPosition,51000,'manual-target'),/PREVIOUS_EXIT_ID_INVALID/);
});

test('iPhone builds progressive and max-loss protection updates',()=>{
  const progressive=buildControllerUpdateProtectionCommand(longPosition,50500,'PROGRESSIVE','zth-PRO-abcdef');
  assert.equal(progressive.payload.protectionKind,'PROGRESSIVE');
  assert.equal(progressive.payload.triggerPrice,50500);
  assert.equal(progressive.payload.limitPrice,50500);
  assert.equal(progressive.payload.previousClientAlgoId,'zth-PRO-abcdef');

  const maxLoss=buildControllerUpdateProtectionCommand(longPosition,48000,'MAX_LOSS','zth-MAX-abcdef');
  assert.equal(maxLoss.payload.protectionKind,'MAX_LOSS');
  assert.equal(maxLoss.payload.triggerPrice,48000);
});

test('protection trigger side is direction-safe',()=>{
  assert.throws(()=>buildControllerUpdateProtectionCommand(longPosition,49000,'PROGRESSIVE'),/LONG_PROGRESSIVE_TRIGGER_BELOW_ENTRY/);
  assert.throws(()=>buildControllerUpdateProtectionCommand(longPosition,51000,'MAX_LOSS'),/LONG_MAX_LOSS_TRIGGER_NOT_BELOW_ENTRY/);
  assert.throws(()=>buildControllerUpdateProtectionCommand(shortPosition,3100,'PROGRESSIVE'),/SHORT_PROGRESSIVE_TRIGGER_ABOVE_ENTRY/);
  assert.throws(()=>buildControllerUpdateProtectionCommand(shortPosition,2900,'MAX_LOSS'),/SHORT_MAX_LOSS_TRIGGER_NOT_ABOVE_ENTRY/);
});
