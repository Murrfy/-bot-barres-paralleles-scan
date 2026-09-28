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
    let controllerIdentity={paired:false,role:'',lastOk:0,error:''};
    let controllerStateSyncTimer=null;
    let controllerSyncState={conflict:false,lastOk:0,error:''};

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
    async function syncControllerCloudStateNow(){return true}
  `,context);

  for(const name of [
    'normalizeRecordBlock','saveLocalOnly','load','fillFutures',
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

test('stale deployment guard is loaded before the inline Zenith application',()=>{
  const guard=fs.readFileSync('ui-version-guard.js','utf8');
  assert.match(html,/<script src="\/ui-version-guard\.js" defer><\/script>[\s\S]*<script>[\s\S]*"use strict";/);
  assert.match(guard,/method:'HEAD'/);
  assert.match(guard,/cache:'no-store'/);
  assert.match(guard,/response\.headers\.get\('etag'\)/);
  assert.match(guard,/window\.location\.reload\(\)/);
  assert.match(guard,/visibilitychange/);
});
