import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRealProtectionLevels,
  pnlAtLinearPrice,
  priceForLinearPnl,
  validateMaxLossTrigger,
} from '../lib/real-protection-levels.mjs';

const filter={filterType:'PRICE_FILTER',minPrice:'0.1',maxPrice:'1000000',tickSize:'0.1'};

test('LONG automatic levels use exact quantity and conservative tick rounding',()=>{
  const levels=buildRealProtectionLevels({
    position:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'3',entryPrice:'100'},
    targetProfitUsd:1,
    maxLossUsd:1,
    priceFilter:filter,
  });
  assert.equal(levels.direction,'LONG');
  assert.equal(levels.targetPrice,100.4);
  assert.equal(levels.maxLossTriggerPrice,99.7);
  assert.ok(levels.actualTargetProfitUsd>=1);
  assert.ok(levels.actualMaxLossUsd<=1);
});

test('SHORT automatic levels round in the opposite market direction but remain conservative',()=>{
  const levels=buildRealProtectionLevels({
    position:{symbol:'ETHUSDT',positionSide:'BOTH',positionAmt:'-3',entryPrice:'100'},
    targetProfitUsd:1,
    maxLossUsd:1,
    priceFilter:filter,
  });
  assert.equal(levels.direction,'SHORT');
  assert.equal(levels.targetPrice,99.6);
  assert.equal(levels.maxLossTriggerPrice,100.3);
  assert.ok(levels.actualTargetProfitUsd>=1);
  assert.ok(levels.actualMaxLossUsd<=1);
});

test('linear price/PnL conversion is symmetric for LONG and SHORT',()=>{
  assert.equal(priceForLinearPnl({entryPrice:50000,quantity:0.2,direction:'LONG',pnlUsd:3000}),65000);
  assert.equal(pnlAtLinearPrice({entryPrice:50000,quantity:0.2,direction:'LONG',price:65000}),3000);
  assert.equal(priceForLinearPnl({entryPrice:3000,quantity:2,direction:'SHORT',pnlUsd:3000}),1500);
  assert.equal(pnlAtLinearPrice({entryPrice:3000,quantity:2,direction:'SHORT',price:1500}),3000);
});

test('automatic max loss can never exceed hard server limit',()=>{
  assert.throws(()=>buildRealProtectionLevels({
    position:{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.2',entryPrice:'50000'},
    targetProfitUsd:3000,maxLossUsd:401,priceFilter:filter,
  }),/MAX_LOSS_EXCEEDS_SERVER_LIMIT/);
});

test('server max-loss validator rejects a stop implying more than $400 loss',()=>{
  const position={symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.2',entryPrice:'50000'};
  const exact=validateMaxLossTrigger({position,triggerPrice:48000});
  assert.equal(exact.impliedLossUsd,400);
  assert.throws(
    ()=>validateMaxLossTrigger({position,triggerPrice:47999.9}),
    e=>e?.message==='MAX_LOSS_EXCEEDS_SERVER_LIMIT'&&e.impliedLossUsd>400
  );
});

test('server max-loss validator handles SHORT correctly',()=>{
  const position={symbol:'ETHUSDT',positionSide:'BOTH',positionAmt:'-2',entryPrice:'3000'};
  const exact=validateMaxLossTrigger({position,triggerPrice:3200});
  assert.equal(exact.impliedLossUsd,400);
  assert.throws(()=>validateMaxLossTrigger({position,triggerPrice:3200.1}),/MAX_LOSS_EXCEEDS_SERVER_LIMIT/);
});
