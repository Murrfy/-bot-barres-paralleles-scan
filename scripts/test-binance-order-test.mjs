import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cleanParams, signedBody } from '../api/binance-order-test.js';

test('protective IOC price-match order is accepted for test endpoint',()=>{
  const p=cleanParams({symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',timeInForce:'IOC',quantity:'0.02',reduceOnly:'true',priceMatch:'OPPONENT',newClientOrderId:'zth-EXT-abcdef1234567890'});
  assert.equal(p.priceMatch,'OPPONENT');
  assert.equal('price' in p,false);
});
test('exact GTC LIMIT price is accepted and cannot also use priceMatch',()=>{
  const p=cleanParams({symbol:'BTCUSDT',side:'SELL',type:'LIMIT',timeInForce:'GTC',quantity:'0.02',reduceOnly:'true',price:'51000',newClientOrderId:'zth-EXT-abcdef1234567890'});
  assert.equal(p.price,'51000');
  assert.throws(()=>cleanParams({...p,priceMatch:'OPPONENT'}),/LIMIT_REQUIRES_PRICE_XOR_PRICE_MATCH/);
});
test('test endpoint refuses entries, hedge mode, conditionals and arbitrary client IDs',()=>{
  const base={symbol:'BTCUSDT',side:'SELL',type:'MARKET',quantity:'0.02',reduceOnly:'true',newClientOrderId:'zth-EXT-abcdef1234567890'};
  assert.throws(()=>cleanParams({...base,reduceOnly:'false'}),/TEST_MUST_BE_REDUCE_ONLY/);
  assert.throws(()=>cleanParams({...base,positionSide:'LONG'}),/ONLY_ONE_WAY_SUPPORTED/);
  assert.throws(()=>cleanParams({...base,type:'STOP_MARKET'}),/ORDER_TYPE_NOT_ALLOWED/);
  assert.throws(()=>cleanParams({...base,newClientOrderId:'external'}),/CLIENT_ORDER_ID_INVALID/);
});
test('signed form payload is deterministic and contains no secret',()=>{
  const params=cleanParams({symbol:'BTCUSDT',side:'BUY',type:'MARKET',quantity:'0.02',reduceOnly:'true',newClientOrderId:'zth-EXT-abcdef1234567890'});
  const body=signedBody(params,'secret-test',1234567890);
  assert.ok(body.includes('timestamp=1234567890'));
  assert.ok(body.includes('signature='));
  assert.equal(body.includes('secret-test'),false);
  const unsigned=body.split('&signature=')[0];
  const expected=crypto.createHmac('sha256','secret-test').update(unsigned).digest('hex');
  assert.equal(new URLSearchParams(body).get('signature'),expected);
});
