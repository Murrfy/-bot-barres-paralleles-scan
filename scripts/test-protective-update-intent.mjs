import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProtectiveAlgoPlan } from '../lib/protective-update-intent.mjs';

test('progressive protection is STOP + exact LIMIT GTC at the protected price',()=>{
  const p=buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'LONG',
    quantity:0.02,triggerPrice:50500,limitPrice:50500,protectionKind:'PROGRESSIVE'
  });
  assert.equal(p.params.type,'STOP');
  assert.equal(p.params.side,'SELL');
  assert.equal(p.params.timeInForce,'GTC');
  assert.equal(p.params.reduceOnly,'true');
  assert.equal(p.params.quantity,'0.02');
  assert.equal(p.params.triggerPrice,'50500');
  assert.equal(p.params.price,'50500');
  assert.equal('priceMatch' in p.params,false);
  assert.equal('closePosition' in p.params,false);
});

test('max-loss emergency protection is STOP IOC reduce-only with opponent price match',()=>{
  const p=buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'LONG',
    quantity:0.02,triggerPrice:48000,protectionKind:'MAX_LOSS'
  });
  assert.equal(p.params.type,'STOP');
  assert.equal(p.params.timeInForce,'IOC');
  assert.equal(p.params.quantity,'0.02');
  assert.equal(p.params.reduceOnly,'true');
  assert.equal(p.params.priceMatch,'OPPONENT');
  assert.equal('closePosition' in p.params,false);
});

test('protective algo ids are deterministic and direction maps to opposite side',()=>{
  const a=buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'SHORT',
    quantity:0.02,triggerPrice:51000,limitPrice:51000,protectionKind:'PROGRESSIVE'
  });
  const b=buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'SHORT',
    quantity:0.02,triggerPrice:51000,limitPrice:51000,protectionKind:'PROGRESSIVE'
  });
  assert.equal(a.params.clientAlgoId,b.params.clientAlgoId);
  assert.equal(a.params.side,'BUY');
  assert.ok(a.params.clientAlgoId.length<=36);
});


test('progressive protection refuses a LIMIT below or above the protected trigger',()=>{
  assert.throws(()=>buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'LONG',
    quantity:0.02,triggerPrice:50500,limitPrice:50499.9,protectionKind:'PROGRESSIVE'
  }),/PROGRESSIVE_TRIGGER_LIMIT_MUST_MATCH/);
});
