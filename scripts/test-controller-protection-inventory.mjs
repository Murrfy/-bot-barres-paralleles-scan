import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('function realProtectionInventory(position){');
const end=html.indexOf('function realUpdatePendingKey(position,kind){',start);
assert.ok(start>=0&&end>start);
const block=html.slice(start,end);

const n=(v,d=0)=>Number.isFinite(+v)?+v:d;
const realNumberMatches=(a,b)=>{
  const aa=n(a,NaN),bb=n(b,NaN);
  return Number.isFinite(aa)&&Number.isFinite(bb)&&Math.abs(aa-bb)<=Math.max(1e-9,Math.abs(bb)*1e-10);
};
const zenithManagedRealId=value=>{
  const id=String(value||'');
  return /^zth-[A-Za-z0-9._:-]+$/.test(id)&&id.length<=36;
};
function inventory(binanceAccount,position){
  const fn=new Function('n','realNumberMatches','zenithManagedRealId','binanceAccount',
    block+'\nreturn realProtectionInventory;'
  )(n,realNumberMatches,zenithManagedRealId,binanceAccount);
  return fn(position);
}
const long={symbol:'BTCUSDT',positionAmt:'1',entryPrice:'100'};
const short={symbol:'BTCUSDT',positionAmt:'-1',entryPrice:'100'};

function account({exit=null,progressive=null,maxLoss=null}={}){
  return {
    standardOrders:exit?[exit]:[],
    algoOrders:[progressive,maxLoss].filter(Boolean),
  };
}
const validExit={
  symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'LIMIT',timeInForce:'GTC',
  reduceOnly:true,origQty:'1',executedQty:'0',price:'120',clientOrderId:'zth-EXI-valid'
};
const validProgressive={
  symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP',timeInForce:'GTC',
  reduceOnly:true,origQty:'1',triggerPrice:'110',price:'110',priceMatch:'NONE',
  clientAlgoId:'zth-PRO-valid'
};
const validMaxLoss={
  symbol:'BTCUSDT',side:'SELL',positionSide:'BOTH',type:'STOP_MARKET',
  reduceOnly:false,closePosition:true,triggerPrice:'90',clientAlgoId:'zth-MAX-valid'
};

test('LONG inventory recognizes only exact valid Zenith exit/progressive/max-loss orders',()=>{
  const inv=inventory(account({exit:validExit,progressive:validProgressive,maxLoss:validMaxLoss}),long);
  assert.equal(inv.exitConflict,false);
  assert.equal(inv.progressiveConflict,false);
  assert.equal(inv.maxLossConflict,false);
  assert.equal(inv.managedExit.clientOrderId,'zth-EXI-valid');
  assert.equal(inv.managedProgressive.clientAlgoId,'zth-PRO-valid');
  assert.equal(inv.managedMaxLoss.clientAlgoId,'zth-MAX-valid');
});

test('MAX-LOSS on the wrong side of entry is shown as a conflict, never valid protection',()=>{
  const inv=inventory(account({maxLoss:{...validMaxLoss,triggerPrice:'110'}}),long);
  assert.equal(inv.maxLossConflict,true);
  assert.equal(inv.managedMaxLoss,null);
  assert.equal(inv.maxLoss.length,0);
});

test('adaptive or wrong-quantity progressive protection is blocked in UI inventory',()=>{
  let inv=inventory(account({progressive:{...validProgressive,priceMatch:'OPPONENT'}}),long);
  assert.equal(inv.progressiveConflict,true);
  assert.equal(inv.managedProgressive,null);

  inv=inventory(account({progressive:{...validProgressive,origQty:'0.5'}}),long);
  assert.equal(inv.progressiveConflict,true);
  assert.equal(inv.managedProgressive,null);
});

test('external protective order is never presented as Zenith-managed',()=>{
  const inv=inventory(account({progressive:{...validProgressive,clientAlgoId:'manual-stop'}}),long);
  assert.equal(inv.progressiveConflict,true);
  assert.equal(inv.managedProgressive,null);
});

test('SHORT uses mirrored profit and loss sides',()=>{
  const inv=inventory(account({
    exit:{...validExit,side:'BUY',price:'80'},
    progressive:{...validProgressive,side:'BUY',triggerPrice:'90',price:'90'},
    maxLoss:{...validMaxLoss,side:'BUY',triggerPrice:'110'},
  }),short);
  assert.equal(inv.exitConflict,false);
  assert.equal(inv.progressiveConflict,false);
  assert.equal(inv.maxLossConflict,false);
});


test('external valid MAX-LOSS remains a conflict and is never managed by Zenith',()=>{
  const inv=inventory(account({maxLoss:{...validMaxLoss,clientAlgoId:'manual-max-loss'}}),long);
  assert.equal(inv.maxLoss.length,1);
  assert.equal(inv.maxLossConflict,true);
  assert.equal(inv.managedMaxLoss,null);
});
