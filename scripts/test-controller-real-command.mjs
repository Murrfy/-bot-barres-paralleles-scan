import test from 'node:test';
import assert from 'node:assert/strict';
import { buildControllerRealCloseCommand, realPositionKey, buildControllerCancelEntryCommand, realEntryOrderKey } from '../lib/controller-real-command.mjs';

const longPosition={
  symbol:'btcusdt',
  positionSide:'BOTH',
  positionAmt:'0.020',
  entryPrice:'50000.1',
  updateTime:1790161000000,
};

test('real LONG position maps to one protective close command',()=>{
  const c=buildControllerRealCloseCommand(longPosition);
  assert.equal(c.type,'EXEC_CLOSE_POSITION');
  assert.equal(c.payload.symbol,'BTCUSDT');
  assert.equal(c.payload.direction,'LONG');
  assert.equal(c.payload.quantity,0.02);
  assert.equal(c.payload.closeAll,true);
  assert.equal(c.payload.exitMode,'PROTECTIVE_IOC');
  assert.match(c.clientCommandId,/^[A-Za-z0-9._:-]{8,128}$/);
});

test('real SHORT position closes with absolute quantity and SHORT direction',()=>{
  const c=buildControllerRealCloseCommand({...longPosition,symbol:'ETHUSDT',positionAmt:'-1.25'});
  assert.equal(c.payload.direction,'SHORT');
  assert.equal(c.payload.quantity,1.25);
});

test('same live position snapshot produces same client command id for safe dedupe',()=>{
  const a=buildControllerRealCloseCommand(longPosition);
  const b=buildControllerRealCloseCommand({...longPosition});
  assert.equal(a.clientCommandId,b.clientCommandId);
  assert.equal(realPositionKey(longPosition),realPositionKey({...longPosition}));
});

test('quantity or update changes produce a new close intent id',()=>{
  const a=buildControllerRealCloseCommand(longPosition);
  const b=buildControllerRealCloseCommand({...longPosition,positionAmt:'0.01',updateTime:1790161001000});
  assert.notEqual(a.clientCommandId,b.clientCommandId);
});

test('hedge positions and invalid positions fail closed',()=>{
  assert.throws(()=>buildControllerRealCloseCommand({...longPosition,positionSide:'LONG'}),/HEDGE_MODE_UNSUPPORTED/);
  assert.throws(()=>buildControllerRealCloseCommand({...longPosition,positionAmt:'0'}),/POSITION_AMOUNT_INVALID/);
  assert.throws(()=>buildControllerRealCloseCommand({...longPosition,symbol:'!'}),/SYMBOL_INVALID/);
});

test('controller command builder cannot create an entry',()=>{
  const source=buildControllerRealCloseCommand(longPosition);
  assert.notEqual(source.type,'EXEC_OPEN_POSITION');
  assert.equal(source.payload.exitMode,'PROTECTIVE_IOC');
});


test('controller can construct only a stable cancel command for a visible non-reduce-only entry',()=>{
  const order={symbol:'BTCUSDT',clientOrderId:'entry-abc-123',positionSide:'BOTH',reduceOnly:false,updateTime:1790161000000};
  const a=buildControllerCancelEntryCommand(order);
  const b=buildControllerCancelEntryCommand({...order});
  assert.equal(a.type,'EXEC_CANCEL_ENTRY');
  assert.equal(a.payload.clientOrderId,'entry-abc-123');
  assert.equal(a.clientCommandId,b.clientCommandId);
  assert.equal(realEntryOrderKey(order),realEntryOrderKey({...order}));
});

test('controller refuses canceling reduce-only or hedge orders',()=>{
  const base={symbol:'BTCUSDT',clientOrderId:'entry-abc-123',positionSide:'BOTH',reduceOnly:false};
  assert.throws(()=>buildControllerCancelEntryCommand({...base,reduceOnly:true}),/CANCEL_TARGET_IS_REDUCE_ONLY/);
  assert.throws(()=>buildControllerCancelEntryCommand({...base,positionSide:'LONG'}),/HEDGE_MODE_UNSUPPORTED/);
});
