import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  protectionOnlyMismatchTarget,
  protectiveRepairTarget,
  exactProtectiveRepairAllowed,
} from '../lib/protective-command.mjs';
import { executionReadiness } from '../api/binance-protective-execute.js';

function stable(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>v===undefined?'null':stable(v)).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
}
function hash(value){return crypto.createHash('sha256').update(stable(value)).digest('hex')}

function runtime(){
  const data={
    executionMode:'REAL',
    userStream:{connected:true,ready:true,failClosed:false,needsReconciliation:false,failReasons:[]},
    binancePositions:[{symbol:'BTCUSDT',positionSide:'BOTH',positionAmt:'0.02',entryPrice:'50000'}],
    binanceOrders:[],
  };
  return {updatedAt:Date.now(),masterDeviceId:'master-1',data};
}
function report(rt,reasons=['MISSING_BINANCE_PROTECTION'],missing=['BTCUSDT:LONG']){
  return {
    version:2,observedAt:Date.now(),status:'MISMATCH',failClosed:true,reasons,
    actual:{positions:1,orders:0},
    differences:{missingProtections:missing},
    runtimeDataHash:hash(rt.data),
  };
}

test('repair classifier accepts exactly one missing-protection position',()=>{
  const rt=runtime(),r=report(rt);
  assert.equal(protectionOnlyMismatchTarget(r),'BTCUSDT:LONG');
  assert.equal(exactProtectiveRepairAllowed(r,'EXEC_CLOSE_POSITION',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,closeAll:true
  }),true);
  assert.equal(exactProtectiveRepairAllowed(r,'EXEC_UPDATE_PROTECTION',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,triggerPrice:48000,protectionKind:'MAX_LOSS'
  }),true);
});

test('repair classifier rejects progressive, target update, wrong position and mixed mismatches',()=>{
  const rt=runtime(),r=report(rt);
  assert.equal(protectiveRepairTarget('EXEC_UPDATE_PROTECTION',{
    symbol:'BTCUSDT',direction:'LONG',protectionKind:'PROGRESSIVE'
  }),'');
  assert.equal(exactProtectiveRepairAllowed(r,'EXEC_UPDATE_EXIT',{
    symbol:'BTCUSDT',direction:'LONG',quantity:0.02,targetPrice:51000
  }),false);
  assert.equal(exactProtectiveRepairAllowed(r,'EXEC_CLOSE_POSITION',{
    symbol:'ETHUSDT',direction:'LONG',closeAll:true
  }),false);
  assert.equal(protectionOnlyMismatchTarget(report(rt,['MISSING_BINANCE_PROTECTION','UNTRACKED_BINANCE_ORDER'])), '');
  assert.equal(protectionOnlyMismatchTarget(report(rt,['MISSING_BINANCE_PROTECTION'],['BTCUSDT:LONG','ETHUSDT:SHORT'])), '');
});

test('execution readiness allows exact protective repair but nothing broader',()=>{
  const rt=runtime(),r=report(rt);
  assert.equal(executionReadiness(rt,r,'master-1','BTCUSDT:LONG'),'');
  assert.equal(executionReadiness(rt,r,'master-1','ETHUSDT:LONG'),'BINANCE_RECONCILIATION_MISMATCH');
  assert.equal(executionReadiness(rt,r,'master-1',''),'BINANCE_RECONCILIATION_MISMATCH');

  const mixed=report(rt,['MISSING_BINANCE_PROTECTION','UNTRACKED_BINANCE_ORDER']);
  assert.equal(executionReadiness(rt,mixed,'master-1','BTCUSDT:LONG'),'BINANCE_RECONCILIATION_MISMATCH');
});

test('repair path still requires fresh stream and exact runtime hash',()=>{
  const rt=runtime(),r=report(rt);
  const disconnected=structuredClone(rt);
  disconnected.data.userStream.connected=false;
  assert.equal(executionReadiness(disconnected,r,'master-1','BTCUSDT:LONG'),'USER_STREAM_NOT_READY');

  const changed=structuredClone(rt);
  changed.data.binancePositions[0].positionAmt='0.03';
  assert.equal(executionReadiness(changed,r,'master-1','BTCUSDT:LONG'),'BINANCE_RECONCILIATION_RUNTIME_CHANGED');
});
