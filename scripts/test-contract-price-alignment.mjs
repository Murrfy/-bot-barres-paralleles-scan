import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildProtectiveAlgoPlan } from '../lib/protective-update-intent.mjs';

test('progressive and MAX-LOSS protections use Binance CONTRACT_PRICE trigger reference',()=>{
  const progressive=buildProtectiveAlgoPlan({
    commandId:'price-ref-progressive-123',
    symbol:'BTCUSDT',direction:'LONG',quantity:1,
    triggerPrice:50500,limitPrice:50500,protectionKind:'PROGRESSIVE'
  });
  const maxLoss=buildProtectiveAlgoPlan({
    commandId:'price-ref-maxloss-123',
    symbol:'BTCUSDT',direction:'LONG',quantity:1,
    triggerPrice:49600,protectionKind:'MAX_LOSS'
  });
  assert.equal(progressive.params.workingType,'CONTRACT_PRICE');
  assert.equal(maxLoss.params.workingType,'CONTRACT_PRICE');
});

test('MASTER ATTEINT feed is based on Futures contract/trade price, never mark-price stream',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/@aggTrade/);
  assert.match(html,/processAggTrade\(s,q\).*onMark\(s,n\(q\.p\)\)/s);
  assert.match(html,/\/fapi\/v1\/ticker\/price/);
  assert.doesNotMatch(html,/@markPrice/);
  assert.doesNotMatch(html,/\/fapi\/v1\/premiumIndex/);
});
