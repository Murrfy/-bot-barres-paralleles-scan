import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('index.html','utf8');

function extractFunction(name){
  const start=html.indexOf('function '+name+'(');
  const asyncStart=html.indexOf('async function '+name+'(');
  const at=asyncStart>=0&&(start<0||asyncStart<start)?asyncStart:start;
  assert.ok(at>=0,'missing function '+name);
  const open=html.indexOf('{',at);
  let depth=0,quote='',escape=false;
  for(let i=open;i<html.length;i++){
    const ch=html[i];
    if(quote){
      if(escape){escape=false;continue}
      if(ch==='\\'){escape=true;continue}
      if(ch===quote)quote='';
      continue;
    }
    if(ch==="'"||ch==='"'||ch==='\x60'){quote=ch;continue}
    if(ch==='{')depth++;
    else if(ch==='}'){
      depth--;
      if(depth===0)return html.slice(at,i+1);
    }
  }
  throw new Error('unterminated function '+name);
}

function makeHarness(){
  const storage=new Map();
  const elements=new Map();
  const el=id=>{
    if(!elements.has(id)){
      elements.set(id,{
        id,value:'',checked:false,hidden:false,disabled:false,textContent:'',
        dataset:{},classList:{toggle(){},add(){},remove(){}}
      });
    }
    return elements.get(id);
  };
  for(const id of [
    'futuresNoSelection','futuresSettingsWrap','futuresSymbol','fMargin','fLev',
    'fSummary','fLimits','status'
  ])el(id);

  const context={
    console,Map,Set,JSON,Math,Date,Number,Object,Array,String,Boolean,Promise,
    setTimeout,clearTimeout,
    localStorage:{
      getItem:key=>storage.has(String(key))?storage.get(String(key)):null,
      setItem:(key,value)=>storage.set(String(key),String(value)),
      removeItem:key=>storage.delete(String(key))
    },
    __elements:elements,
  };
  vm.createContext(context);

  vm.runInContext(`
    const STORAGE_KEY='zenith-runtime-margin-test';
    const ZENITH_CONTROLLER_REV_KEY='zenith-controller-revision-test';
    const DEFAULT_PROTECTIONS=[];
    const DEFAULTS={
      margin:1000,leverage:10,marginType:'ISOLATED',maxActive:3,
      targetProfit:40,maxLoss:40,protectionStages:[],theme:'dark',
      sound:true,vibrate:true,showProtections:true
    };
    const $=id=>{
      if(!__elements.has(id))__elements.set(id,{
        id,value:'',checked:false,hidden:false,disabled:false,textContent:'',
        dataset:{},classList:{toggle(){},add(){},remove(){}}
      });
      return __elements.get(id);
    };
    const n=(v,d=0)=>Number.isFinite(+v)?+v:d;
    const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
    const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

    let settings=clone(DEFAULTS);
    let tokenSettings={},manualTokens={},validated={},revalidateBlock={},missedSignals={};
    let openPositions=[],history=[],dismissed={},selectedSymbol='';
    let lastPrices=new Map([['BTCUSDT',100],['ETHUSDT',50]]);
    let lastAggIds=new Map(),lastAggTimes=new Map();
    let controllerIdentity={paired:true,role:'controller',lastOk:Date.now(),error:''};
    let controllerStateSyncTimer=null;
    let controllerStateHydrated=true;
    let controllerSyncState={conflict:false,lastOk:0,error:''};
    let __remoteTokenSettings={},__remoteRevision=1;

    function legacyDefaultProtectionProfile(){return false}
    function normalizeProtections(stages){return Array.isArray(stages)?stages:[]}
    function expireWaitingSignals(){}
    function limitsText(){return 'test limits'}
    function futuresDraft(symbol,margin,leverage){
      return {
        ok:true,error:'',qty:Number((margin*leverage/100).toFixed(8)),
        effectiveNotional:margin*leverage
      };
    }
    function anyActivePositionBySymbol(){return false}
    function openBySymbol(){return null}
    async function ensureExchange(){return true}
    async function currentMarketPrice(symbol){
      const value=n(lastPrices.get(symbol),100);
      lastPrices.set(symbol,value);
      return value;
    }
    function tokenExactBuy(){return 0}
    function tokenExactSale(){return 0}
    function validateLimitPrice(){return ''}
    function setStatus(message,error=false){$('status').textContent=String(message);$('status').error=!!error}
    function renderAll(){fillFutures()}
    async function refreshControllerIdentity(){return controllerIdentity.paired&&controllerIdentity.role==='controller'&&controllerStateHydrated}
    async function syncControllerCloudStateNow(){
      if(!(controllerIdentity.paired&&controllerIdentity.role==='controller'&&controllerStateHydrated))return false;
      __remoteTokenSettings=clone(tokenSettings);
      __remoteRevision++;
      return true;
    }
    async function fetch(){
      return {ok:true,status:200,json:async()=>({ok:true,state:{revision:__remoteRevision,data:{tokenSettings:clone(__remoteTokenSettings)}}})};
    }
  `,context);

  for(const name of [
    'normalizeRecordBlock','saveLocalOnly','load','fillFutures',
    'applyControllerCloudStateSnapshot',
    'persistAndVerifyTokenFuturesSettings','saveFutures'
  ]){
    vm.runInContext(extractFunction(name),context);
  }

  return {context,elements,storage};
}

test('per-token Futures margin survives save, token switch and full reload',async()=>{
  const {context,elements}=makeHarness();

  vm.runInContext("selectedSymbol='BTCUSDT'",context);
  elements.get('fMargin').value='125';
  elements.get('fLev').value='7';

  await vm.runInContext('saveFutures()',context);

  assert.equal(vm.runInContext("tokenSettings.BTCUSDT.margin",context),125);
  assert.equal(vm.runInContext("tokenSettings.BTCUSDT.leverage",context),7);

  vm.runInContext("selectedSymbol='ETHUSDT'; fillFutures()",context);
  assert.equal(Number(elements.get('fMargin').value),1000);
  assert.equal(Number(elements.get('fLev').value),10);

  vm.runInContext("selectedSymbol='BTCUSDT'; fillFutures()",context);
  assert.equal(Number(elements.get('fMargin').value),125);
  assert.equal(Number(elements.get('fLev').value),7);

  vm.runInContext(`
    settings=clone(DEFAULTS);
    tokenSettings={};
    manualTokens={};
    validated={};
    revalidateBlock={};
    missedSignals={};
    openPositions=[];
    history=[];
    dismissed={};
    selectedSymbol='';
    load();
    fillFutures();
  `,context);

  assert.equal(vm.runInContext("selectedSymbol",context),'BTCUSDT');
  assert.equal(vm.runInContext("tokenSettings.BTCUSDT.margin",context),125);
  assert.equal(vm.runInContext("tokenSettings.BTCUSDT.leverage",context),7);
  assert.equal(Number(elements.get('fMargin').value),125);
  assert.equal(Number(elements.get('fLev').value),7);
});

test('Futures save refuses to claim success before controller state is ready',async()=>{
  const {context,elements,storage}=makeHarness();

  vm.runInContext(`
    selectedSymbol='BTCUSDT';
    tokenSettings.BTCUSDT={enabled:true,margin:250,leverage:5,marginType:'ISOLATED'};
    saveLocalOnly();
    controllerIdentity={paired:false,role:'',lastOk:0,error:''};
    controllerStateHydrated=false;
  `,context);
  elements.get('fMargin').value='125';
  elements.get('fLev').value='7';

  await vm.runInContext('saveFutures()',context);

  assert.equal(vm.runInContext('tokenSettings.BTCUSDT.margin',context),250);
  assert.equal(vm.runInContext('tokenSettings.BTCUSDT.leverage',context),5);
  assert.equal(Number(elements.get('fMargin').value),250);
  assert.equal(Number(elements.get('fLev').value),5);
  assert.equal(elements.get('status').error,true);
  assert.match(elements.get('status').textContent,/NON enregistré/);
  const persisted=JSON.parse(storage.get('zenith-runtime-margin-test'));
  assert.equal(persisted.tokenSettings.BTCUSDT.margin,250);
});

test('Futures save rolls back an unconfirmed central write instead of displaying it as saved',async()=>{
  const {context,elements}=makeHarness();

  vm.runInContext(`
    selectedSymbol='BTCUSDT';
    tokenSettings.BTCUSDT={enabled:true,margin:250,leverage:5,marginType:'ISOLATED'};
    saveLocalOnly();
    syncControllerCloudStateNow=async()=>{controllerSyncState.error='TEST_SYNC_FAILED';return false};
  `,context);
  elements.get('fMargin').value='125';
  elements.get('fLev').value='7';

  await vm.runInContext('saveFutures()',context);

  assert.equal(vm.runInContext('tokenSettings.BTCUSDT.margin',context),250);
  assert.equal(vm.runInContext('tokenSettings.BTCUSDT.leverage',context),5);
  assert.equal(Number(elements.get('fMargin').value),250);
  assert.equal(Number(elements.get('fLev').value),5);
  assert.equal(elements.get('status').error,true);
  assert.match(elements.get('status').textContent,/TEST_SYNC_FAILED/);
  assert.match(elements.get('status').textContent,/ancien réglage a été conservé/i);
});

test('stale deployment guard is loaded before the inline Zenith application',()=>{
  const guard=fs.readFileSync('ui-version-guard.js','utf8');
  assert.match(html,/<script src="\/ui-version-guard\.js" defer><\/script>[\s\S]*<script>[\s\S]*"use strict";/);
  assert.match(guard,/method:'HEAD'/);
  assert.match(guard,/cache:'no-store'/);
  assert.match(guard,/response\.headers\.get\('etag'\)/);
  assert.match(guard,/window\.location\.reload\(\)/);
  assert.match(guard,/visibilitychange/);
});


test('central controller state restores a per-token Futures margin before the UI uses the BOT default',()=>{
  const {context,elements,storage}=makeHarness();

  vm.runInContext("selectedSymbol='BTCUSDT'; tokenSettings={}; fillFutures()",context);
  assert.equal(Number(elements.get('fMargin').value),1000);

  const state={
    revision:7,
    data:{
      settings:{
        margin:1000,leverage:10,marginType:'ISOLATED',maxActive:3,
        targetProfit:40,maxLoss:40,protectionStages:[]
      },
      tokenSettings:{
        BTCUSDT:{
          enabled:true,margin:125,leverage:7,marginType:'ISOLATED',
          targetProfit:40,manualTargetProfit:40,maxLoss:40,protectionStages:[]
        }
      },
      manualTokens:{},
      validated:{}
    }
  };
  context.__centralState=state;
  assert.equal(vm.runInContext('applyControllerCloudStateSnapshot(__centralState)',context),true);
  vm.runInContext('fillFutures()',context);

  assert.equal(Number(elements.get('fMargin').value),125);
  assert.equal(Number(elements.get('fLev').value),7);
  assert.equal(vm.runInContext('tokenSettings.BTCUSDT.margin',context),125);
  assert.equal(vm.runInContext('tokenSettings.BTCUSDT.leverage',context),7);
  assert.equal(storage.get('zenith-controller-revision-test'),'7');

  const persisted=JSON.parse(storage.get('zenith-runtime-margin-test'));
  assert.equal(persisted.tokenSettings.BTCUSDT.margin,125);
  assert.equal(persisted.tokenSettings.BTCUSDT.leverage,7);
});

test('controller startup hydrates central state before any local state sync can overwrite it',()=>{
  const refresh=extractFunction('refreshControllerIdentity');
  const hydrate=extractFunction('hydrateControllerCloudStateFromServer');
  const hydrateAt=refresh.indexOf('await hydrateControllerCloudStateFromServer()');
  const syncAt=refresh.indexOf('scheduleControllerCloudStateSync()');
  assert.ok(hydrateAt>=0&&syncAt>hydrateAt);
  assert.match(hydrate,/expectedHash!==actualHash/);
  assert.match(hydrate,/applyControllerCloudStateSnapshot\(state\)/);
  assert.match(hydrate,/controllerStateHydrated=true/);
});

test('Enregistrer le jeton rolls back Futures settings when central persistence is not confirmed',async()=>{
  const source=extractFunction('saveToken');
  assert.match(source,/const old=tokenSettings\[s\]\|\|\{\}/);
  assert.match(source,/const futuresPersisted=await persistAndVerifyTokenFuturesSettings\(s,margin,leverage\)/);
  assert.match(source,/if\(!futuresPersisted\.ok\)\{/);
  assert.match(source,/tokenSettings\[s\]=old/);
  assert.match(source,/else delete tokenSettings\[s\]/);
  assert.match(source,/delete validated\[s\]/);
  assert.match(source,/saveLocalOnly\(\);fillToken\(\);renderAll\(\)/);
  assert.match(source,/L’ancien réglage a été conservé/);
  const rollbackAt=source.indexOf('if(!futuresPersisted.ok){');
  const realtimeAt=source.indexOf('syncRealtime();renderAll();',rollbackAt);
  assert.ok(realtimeAt>rollbackAt,'realtime sync must only happen after confirmed Futures persistence');
});
