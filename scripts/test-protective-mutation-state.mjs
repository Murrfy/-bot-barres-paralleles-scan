import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectExactExitOrder,
  selectProtectionOrder,
  buildProtectionReplacementPlan,
  validateProtectionTrigger,
  evaluateExitUpdateConfirmation,
  evaluateProtectionUpdateConfirmation,
} from '../lib/protective-mutation-state.mjs';

function state({standardOrders={},algoOrders={},positions={}}={}){
  return {
    connected:true,failClosed:false,needsReconciliation:false,
    standardOrders,algoOrders,positions
  };
}
const pos={symbol:'BTCUSDT',positionSide:'BOTH',positionAmount:'0.02'};

test('selects one exact reduce-only LIMIT exit and rejects ambiguity',()=>{
  const exit={symbol:'BTCUSDT',clientOrderId:'exit-1',side:'SELL',positionSide:'BOTH',type:'LIMIT',status:'NEW',originalQuantity:'0.02',cumulativeFilledQuantity:'0',originalPrice:'51000',reduceOnly:true,timeInForce:'GTC'};
  assert.equal(selectExactExitOrder(state({standardOrders:{a:exit},positions:{p:pos}}),{symbol:'BTCUSDT',direction:'LONG'}).order.clientOrderId,'exit-1');
  const ambiguous=selectExactExitOrder(state({standardOrders:{a:exit,b:{...exit,clientOrderId:'exit-2'}},positions:{p:pos}}),{symbol:'BTCUSDT',direction:'LONG'});
  assert.equal(ambiguous.reason,'EXIT_ORDER_AMBIGUOUS');
});

test('protection replacement plan is STOP_MARKET close-all without quantity or reduceOnly',()=>{
  const p=buildProtectionReplacementPlan({commandId:'command-12345678',symbol:'BTCUSDT',direction:'LONG',triggerPrice:49000});
  assert.equal(p.params.algoType,'CONDITIONAL');
  assert.equal(p.params.side,'SELL');
  assert.equal(p.params.type,'STOP_MARKET');
  assert.equal(p.params.closePosition,'true');
  assert.equal(p.params.workingType,'MARK_PRICE');
  assert.equal('quantity' in p.params,false);
  assert.equal('reduceOnly' in p.params,false);
  assert.ok(p.clientAlgoId.length<=36);
});

test('protection trigger must be on the non-immediate side of MARK price',()=>{
  assert.equal(validateProtectionTrigger({direction:'LONG',triggerPrice:49000,markPrice:50000}).ok,true);
  assert.equal(validateProtectionTrigger({direction:'LONG',triggerPrice:50000,markPrice:50000}).reason,'LONG_STOP_WOULD_TRIGGER_IMMEDIATELY');
  assert.equal(validateProtectionTrigger({direction:'SHORT',triggerPrice:51000,markPrice:50000}).ok,true);
  assert.equal(validateProtectionTrigger({direction:'SHORT',triggerPrice:49999,markPrice:50000}).reason,'SHORT_STOP_WOULD_TRIGGER_IMMEDIATELY');
});

test('exit update confirmation requires exact unfilled live reduce-only order',()=>{
  const exit={symbol:'BTCUSDT',clientOrderId:'exit-1',side:'SELL',positionSide:'BOTH',type:'LIMIT',status:'NEW',originalQuantity:'0.02',cumulativeFilledQuantity:'0',originalPrice:'52000',reduceOnly:true,timeInForce:'GTC'};
  const good=evaluateExitUpdateConfirmation(state({standardOrders:{a:exit},positions:{p:pos}}),{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,targetPrice:52000,clientOrderId:'exit-1'
  });
  assert.equal(good.confirmed,true);
  const partial=evaluateExitUpdateConfirmation(state({standardOrders:{a:{...exit,cumulativeFilledQuantity:'0.001'}},positions:{p:pos}}),{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,targetPrice:52000,clientOrderId:'exit-1'
  });
  assert.equal(partial.confirmed,false);
  assert.equal(partial.reason,'EXIT_ORDER_PARTIALLY_FILLED');
});

test('protection update confirms only replacement active and previous gone',()=>{
  const replacement={symbol:'BTCUSDT',clientAlgoId:'prot-new',side:'SELL',positionSide:'BOTH',orderType:'STOP_MARKET',status:'NEW',triggerPrice:'49500',closePosition:true,reduceOnly:false};
  const old={...replacement,clientAlgoId:'prot-old',triggerPrice:'49000'};
  const good=evaluateProtectionUpdateConfirmation(state({algoOrders:{n:replacement},positions:{p:pos}}),{
    symbol:'BTCUSDT',direction:'LONG',triggerPrice:49500,replacementClientAlgoId:'prot-new',previousClientAlgoId:'prot-old'
  });
  assert.equal(good.confirmed,true);
  const overlap=evaluateProtectionUpdateConfirmation(state({algoOrders:{n:replacement,o:old},positions:{p:pos}}),{
    symbol:'BTCUSDT',direction:'LONG',triggerPrice:49500,replacementClientAlgoId:'prot-new',previousClientAlgoId:'prot-old'
  });
  assert.equal(overlap.confirmed,false);
  assert.equal(overlap.reason,'PREVIOUS_PROTECTION_STILL_ACTIVE');
});

test('protection update cannot ACK if position disappeared during replacement',()=>{
  const replacement={symbol:'BTCUSDT',clientAlgoId:'prot-new',side:'SELL',positionSide:'BOTH',orderType:'STOP_MARKET',status:'NEW',triggerPrice:'49500',closePosition:true,reduceOnly:false};
  const r=evaluateProtectionUpdateConfirmation(state({algoOrders:{n:replacement}}),{
    symbol:'BTCUSDT',direction:'LONG',triggerPrice:49500,replacementClientAlgoId:'prot-new'
  });
  assert.equal(r.confirmed,false);
  assert.equal(r.reason,'POSITION_NOT_FOUND');
});

test('selectProtectionOrder only accepts close-all STOP_MARKET protection',()=>{
  const good={symbol:'BTCUSDT',clientAlgoId:'prot-1',side:'SELL',positionSide:'BOTH',orderType:'STOP_MARKET',status:'NEW',triggerPrice:'49000',closePosition:true,reduceOnly:false};
  const bad={...good,clientAlgoId:'prot-2',closePosition:false};
  const r=selectProtectionOrder(state({algoOrders:{a:good,b:bad},positions:{p:pos}}),{symbol:'BTCUSDT',direction:'LONG'});
  assert.equal(r.order.clientAlgoId,'prot-1');
});
