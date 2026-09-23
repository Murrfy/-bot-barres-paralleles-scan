import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProtectiveAlgoPlan } from '../lib/protective-update-intent.mjs';

test('progressive protection is LIMIT-first STOP reduce-only using OPPONENT',()=>{
  const p=buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'LONG',
    quantity:0.02,triggerPrice:50500,protectionKind:'PROGRESSIVE'
  });
  assert.equal(p.params.type,'STOP');
  assert.equal(p.params.side,'SELL');
  assert.equal(p.params.reduceOnly,'true');
  assert.equal(p.params.quantity,'0.02');
  assert.equal(p.params.priceMatch,'OPPONENT');
  assert.equal('closePosition' in p.params,false);
});

test('max-loss emergency protection is STOP_MARKET close-all without quantity or reduceOnly',()=>{
  const p=buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'LONG',
    quantity:0.02,triggerPrice:48000,protectionKind:'MAX_LOSS'
  });
  assert.equal(p.params.type,'STOP_MARKET');
  assert.equal(p.params.closePosition,'true');
  assert.equal('quantity' in p.params,false);
  assert.equal('reduceOnly' in p.params,false);
  assert.equal('priceMatch' in p.params,false);
});

test('protective algo ids are deterministic and direction maps to opposite side',()=>{
  const a=buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'SHORT',
    quantity:0.02,triggerPrice:51000,protectionKind:'PROGRESSIVE'
  });
  const b=buildProtectiveAlgoPlan({
    commandId:'protect-command-123',symbol:'BTCUSDT',direction:'SHORT',
    quantity:0.02,triggerPrice:51000,protectionKind:'PROGRESSIVE'
  });
  assert.equal(a.params.clientAlgoId,b.params.clientAlgoId);
  assert.equal(a.params.side,'BUY');
  assert.ok(a.params.clientAlgoId.length<=36);
});
