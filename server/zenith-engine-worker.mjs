import crypto from 'node:crypto';
import {
  createUserStreamState,
  markUserStreamConnected,
  markUserStreamDisconnected,
  markUserStreamNeedsReconciliation,
  markUserStreamReconciled,
  applyUserDataEvent,
  userStreamReady,
} from '../lib/user-stream-state.mjs';
import { runtimeInventoryFromUserStream } from '../lib/master-runtime-inventory.mjs';
import { seedUserStreamStateFromRuntimeSnapshot } from '../lib/user-stream-seed.mjs';
import {
  masterExecutionEligible,
  buildMasterCommandDispatch,
  orphanZenithCleanupOrders,
  protectionOnlyMismatchTarget,
  missingMaxLossRepairTarget,
} from '../lib/master-command-dispatch.mjs';
import {
  streamPositionQuantity,
  evaluateFullProtectiveClose,
  PROTECTIVE_CLOSE_ATTEMPTS,
} from '../lib/protective-close-state.mjs';
import { evaluateMasterAutoProgressiveProtection } from '../lib/master-auto-protection.mjs';
import { planAutomaticTargetExit } from '../lib/auto-target-exit.mjs';
import { buildMaxLossRepairPlan } from '../lib/maxloss-repair.mjs';
import { pendingEntryProtectionLossTargets, pendingEntryWriteAheadRecoveryTargets, triggeredMaxLossRemainderTargets } from '../lib/protective-command.mjs';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';
import {
  entryWatchDefinition,
  entryWatchIdentity,
  evaluateEntryWatchTick,
  pruneEntryWatchStates,
  entryWatchSlotRaceOutcome,
} from '../lib/entry-watch.mjs';

const BASE_URL=String(process.env.ZENITH_BASE_URL||'').replace(/\/$/,'');
const BINANCE_PUBLIC_BASE='https://fapi.binance.com';
const BOOTSTRAP_SECRET=String(process.env.ZENITH_ENGINE_BOOTSTRAP_SECRET||'');
const WORKER_ENABLED=process.env.ZENITH_ENGINE_WORKER_ENABLED==='1';
const HEARTBEAT_MS=8000;
const COMMAND_POLL_MS=750;
const RECONCILE_MS=15000;
const KEEPALIVE_MS=45*60*1000;
const STREAM_RESTART_MS=23*60*60*1000;
const MARK_FALLBACK_MS=6000;
const ENTRY_WATCH_RECOVERY_MS=48*60*60*1000;
const BOOTSTRAP_RETRY_MS=15000;

const instanceId='engine-instance-'+crypto.randomUUID();
let sessionCookie='';
let stopping=false;

const runtime={
  leaseActive:false,
  heartbeatFresh:false,
  realExecutionArmed:false,
  mode:'PAUSED',
  synchronized:false,
  controllerRevision:0,
  appliedRevision:0,
  config:null,
  error:'',
};

const stream={
  state:createUserStreamState(),
  ws:null,
  generation:0,
  starting:false,
  seeding:false,
  bufferedEvents:[],
  reconcileBusy:false,
  reconcileTimer:null,
  reconcileInterval:null,
  keepaliveTimer:null,
  restartTimer:null,
  reconnectTimer:null,
  lastError:'',
};

const execution={
  busy:false,
  timer:null,
  lastError:'',
  lastCommandId:'',
};

const maxLossRemainderRecovery={
  busy:false,
  lastError:'',
};

const autoProtection={
  highWater:new Map(),
  authorizationAt:0,
  highWaterLoaded:false,
  highWaterLoadPromise:null,
  highWaterSaveTimer:null,
  highWaterSaveBusy:false,
  priceFilters:new Map(),
  metadataFetchAt:0,
  busySymbols:new Set(),
  lastError:'',
  lastActionAt:0,
};

const autoTarget={
  busySymbols:new Set(),
  lastError:'',
  lastActionAt:0,
};

const entryWatch={
  states:new Map(),
  authorizationAt:0,
  loaded:false,
  loadPromise:null,
  saveTimer:null,
  saveBusy:false,
  busySymbols:new Set(),
  lastError:'',
  lastCrossingAt:0,
  lastActionAt:0,
};

const markStream={
  ws:null,
  generation:0,
  reconnectTimer:null,
  restartTimer:null,
  fallbackTimer:null,
  subscribed:new Set(),
  requestId:1,
  lastEventAt:0,
  lastAggIds:new Map(),
  lastAggTimes:new Map(),
  recovering:new Set(),
  pendingAggTrades:new Map(),
  lastError:'',
};

let heartbeatTimer=null;
let standbyTimer=null;

function required(name,value){
  if(!value)throw new Error(name+'_REQUIRED');
  return value;
}
function n(value,fallback=0){const x=Number(value);return Number.isFinite(x)?x:fallback}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function clone(value){return JSON.parse(JSON.stringify(value))}
function cleanReason(value,fallback='ENGINE_WORKER_ERROR'){
  const s=String(value||fallback).toUpperCase().replace(/[^A-Z0-9_:-]+/g,'_').slice(0,96);
  return s||fallback;
}
function stableStringify(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>v===undefined?'null':stableStringify(v)).join(',')+']';
  const parts=[];
  for(const key of Object.keys(value).sort()){
    const encoded=stableStringify(value[key]);
    if(encoded!==undefined)parts.push(JSON.stringify(key)+':'+encoded);
  }
  return '{'+parts.join(',')+'}';
}
function sha256Hex(value){
  return crypto.createHash('sha256').update(String(value),'utf8').digest('hex');
}
function realNumberMatches(a,b){
  const x=Number(a),y=Number(b);
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=Math.max(1e-9,Math.abs(y)*1e-10);
}
function zenithManagedRealId(value){
  const id=String(value||'');
  return /^zth-[A-Za-z0-9._:-]+$/.test(id)&&id.length<=36;
}
function autoPositionKey(position){
  const amount=n(position?.positionAmt??position?.quantity,0);
  const symbol=String(position?.symbol||'').toUpperCase();
  const direction=amount>=0?'LONG':'SHORT';
  const qty=Math.abs(amount);
  const entry=n(position?.entryPrice,0);
  const lifecycle=Math.max(0,Math.floor(n(
    position?.lifecycleAt??position?.positionLifecycleAt??position?.updateTime,0
  )));
  return `${symbol}:${direction}:${qty}:${entry}:${lifecycle}`;
}
function observedLinearPnl(position,mark){
  const amount=n(position?.positionAmt??position?.quantity,0);
  const qty=Math.abs(amount),entry=n(position?.entryPrice,0),px=n(mark,0);
  if(!(qty>0)||!(entry>0)||!(px>0))return NaN;
  return (amount>=0?1:-1)*(px-entry)*qty;
}
function observeAutoHighWater(position,mark){
  const observed=observedLinearPnl(position,mark);
  if(!Number.isFinite(observed))return NaN;
  const key=autoPositionKey(position);
  const previous=n(autoProtection.highWater.get(key),NaN);
  const next=Number.isFinite(previous)?Math.max(previous,observed):observed;
  if(!Number.isFinite(previous)||next>previous+1e-8){
    autoProtection.highWater.set(key,next);
    scheduleAutoHighWaterSave();
  }
  return next;
}
function log(kind,details={}){
  const safe={at:new Date().toISOString(),component:'zenith-engine-worker',kind,instanceId,...details};
  delete safe.bootstrapSecret;
  delete safe.cookie;
  delete safe.sessionCookie;
  console.log(JSON.stringify(safe));
}
function logError(kind,error,details={}){
  log(kind,{...details,error:String(error?.message||error||'UNKNOWN')});
}

function extractSessionCookie(response){
  const values=typeof response?.headers?.getSetCookie==='function'
    ? response.headers.getSetCookie()
    : [response?.headers?.get?.('set-cookie')||''];
  for(const value of values){
    const match=/(?:^|;\s*)__Host-zenith_device=([^;]+)/.exec(String(value||''));
    if(match)return '__Host-zenith_device='+match[1];
  }
  return '';
}

function baseHeaders({json=false,auth=true,bearer=''}={}){
  const base=required('ZENITH_BASE_URL',BASE_URL);
  const headers={
    Accept:'application/json',
    Origin:new URL(base).origin,
    'X-Zenith-Engine-Instance':instanceId,
  };
  if(json)headers['Content-Type']='application/json';
  if(bearer)headers.Authorization='Bearer '+bearer;
  if(auth&&sessionCookie)headers.Cookie=sessionCookie;
  return headers;
}

async function http(path,{method='GET',body,auth=true,bearer='',timeoutMs=15000}={}){
  const url=required('ZENITH_BASE_URL',BASE_URL)+path;
  const response=await fetch(url,{
    method,
    headers:baseHeaders({json:body!==undefined,auth,bearer}),
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(timeoutMs),
    cache:'no-store',
  });
  const cookie=extractSessionCookie(response);
  if(cookie)sessionCookie=cookie;
  const text=await response.text();
  let data={};
  try{data=text?JSON.parse(text):{}}catch{data={}}
  return {response,data};
}

async function syncApi(action,{method='GET',body,auth=true,bearer=''}={}){
  return http('/api/zenith-sync?action='+encodeURIComponent(action),{method,body,auth,bearer});
}
async function userStreamApi(action,method='GET'){
  return http('/api/binance-user-stream-session?action='+encodeURIComponent(action),{
    method,
    ...(method==='POST'?{body:{}}:{}),
  });
}
async function binanceApi(path,{method='GET',body}={}){
  return http(path,{method,body});
}

async function publicBinanceJson(path){
  const response=await fetch(BINANCE_PUBLIC_BASE+path,{
    cache:'no-store',
    signal:AbortSignal.timeout(8000),
  });
  const text=await response.text();
  let data={};
  try{data=text?JSON.parse(text):{}}catch{data={}}
  if(!response.ok){
    const error=new Error(data?.msg||('BINANCE_PUBLIC_HTTP_'+response.status));
    error.code='BINANCE_PUBLIC_HTTP_'+response.status;
    throw error;
  }
  return data;
}

function fatalAuthorityCode(code){
  return new Set([
    'ENGINE_INSTANCE_FENCED',
    'MASTER_SESSION_REVOKED',
    'MASTER_ROLE_CHANGED',
    'ENGINE_ADMIN_REENABLE_REQUIRED',
  ]).has(String(code||''));
}

async function bootstrapOnce(){
  if(BOOTSTRAP_SECRET.length<32)throw new Error('ZENITH_ENGINE_BOOTSTRAP_SECRET_TOO_WEAK');
  const {response,data}=await syncApi('engine-bootstrap',{
    method:'POST',
    auth:false,
    bearer:BOOTSTRAP_SECRET,
    body:{instanceId},
  });
  if(response.ok&&data?.ok===true&&data?.sessionReady===true){
    if(!sessionCookie)throw new Error('ENGINE_SESSION_COOKIE_MISSING');
    log('BOOTSTRAPPED',{
      initialRegistration:data.initialRegistration===true,
      restartAuthorized:data.restartAuthorized===true,
      realExecutionArmCarried:data.realExecutionArmCarried===true,
      restartFailClosed:data.restartFailClosed===true,
    });
    return true;
  }
  const code=String(data?.code||('HTTP_'+response.status));
  const error=new Error(code);
  error.code=code;
  error.status=response.status;
  throw error;
}

async function bootstrapUntilReady(){
  while(!stopping){
    try{
      await bootstrapOnce();
      return true;
    }catch(error){
      const code=String(error?.code||error?.message||'ENGINE_BOOTSTRAP_FAILED');
      if(![
        'ENGINE_CUTOVER_REQUIRED',
        'ENGINE_INITIAL_CUTOVER_NOT_SAFE',
        'ENGINE_INSTANCE_ACTIVE',
        'MASTER_LEASE_CONFLICT',
        'ENGINE_ADMIN_REENABLE_REQUIRED',
        'ENGINE_RESTART_MUTATION_IN_FLIGHT',
        'ENGINE_BOOTSTRAP_RATE_LIMIT',
      ].includes(code))throw error;
      log('BOOTSTRAP_BLOCKED',{code});
      const delay=code==='ENGINE_ADMIN_REENABLE_REQUIRED'?60000:BOOTSTRAP_RETRY_MS;
      await sleep(delay);
    }
  }
  return false;
}

async function heartbeat(){
  if(!sessionCookie)return false;
  const {response,data}=await syncApi('master-heartbeat',{method:'POST',body:{}});
  if(response.status===423&&String(data?.code||'')==='MASTER_ACTIVATION_REQUIRED'){
    runtime.leaseActive=false;
    runtime.heartbeatFresh=false;
    runtime.realExecutionArmed=false;
    runtime.mode='PAUSED';
    runtime.error='MASTER_ACTIVATION_REQUIRED';
    await closeLocalStream('MASTER_ACTIVATION_REQUIRED',false);
    return false;
  }
  if(!response.ok||data?.ok!==true){
    const code=String(data?.code||('HTTP_'+response.status));
    if(fatalAuthorityCode(code)){
      const error=new Error(code);error.code=code;throw error;
    }
    runtime.leaseActive=false;
    runtime.heartbeatFresh=false;
    runtime.realExecutionArmed=false;
    runtime.error=code;
    await closeLocalStream(code,false);
    return false;
  }

  runtime.leaseActive=true;
  runtime.heartbeatFresh=true;
  runtime.realExecutionArmed=data.realExecutionArmed===true;
  runtime.mode=String(data.masterMode||'PAUSED').toUpperCase();
  runtime.error='';
  return true;
}

async function applyControllerState(controllerState){
  if(!controllerState||typeof controllerState!=='object'||!controllerState.data||typeof controllerState.data!=='object'){
    throw new Error('CONTROLLER_STATE_INVALID');
  }
  const revision=Math.max(0,n(controllerState.revision));
  const stateHash=String(controllerState.stateHash||'');
  if(!Number.isInteger(revision)||revision<=0||!stateHash)throw new Error('CONTROLLER_STATE_INVALID');
  const computed=sha256Hex(stableStringify(controllerState.data));
  if(computed!==stateHash)throw new Error('CONTROLLER_STATE_HASH_MISMATCH');
  runtime.config=clone(controllerState.data);
  runtime.controllerRevision=revision;
  const appliedHash=sha256Hex(stableStringify(runtime.config));
  if(appliedHash!==stateHash)throw new Error('ENGINE_APPLIED_CONFIG_HASH_MISMATCH');
  return {revision,stateHash};
}

function validActiveProtectionStages(stages){
  if(!Array.isArray(stages)||stages.length<1||stages.length>200)return false;
  let previousArm=-Infinity,previousFloor=-Infinity;
  for(const row of stages){
    if(!row||typeof row!=='object'||Array.isArray(row))return false;
    if(Object.keys(row).some(key=>!['enabled','arm','floor'].includes(key)))return false;
    const enabled=row.enabled!==false,arm=n(row.arm,NaN),floor=n(row.floor,NaN);
    if(!Number.isFinite(arm)||!Number.isFinite(floor)||arm<0||floor<0||arm>1e9||floor>1e9)return false;
    if(enabled){
      if(!(floor<arm)||!(arm>previousArm)||floor+1e-8<previousFloor)return false;
      previousArm=arm;previousFloor=floor;
    }
  }
  return true;
}

function activeSafeTokenConfigRefreshAllowed(currentConfig,nextConfig){
  if(!currentConfig||typeof currentConfig!=='object'||!nextConfig||typeof nextConfig!=='object')return false;
  for(const key of ['settings','manualTokens','validated']){
    if(stableStringify(currentConfig[key]||{})!==stableStringify(nextConfig[key]||{}))return false;
  }

  const currentTokens=currentConfig.tokenSettings&&typeof currentConfig.tokenSettings==='object'
    ?currentConfig.tokenSettings:{};
  const nextTokens=nextConfig.tokenSettings&&typeof nextConfig.tokenSettings==='object'
    ?nextConfig.tokenSettings:{};
  const symbols=[...new Set([...Object.keys(currentTokens),...Object.keys(nextTokens)])].sort();
  const safeMutable=new Set([
    'maxLoss','marginType','targetProfit','manualTargetProfit','protectionStages',
    'exactSaleEnabled','exactSalePrice','exactSaleSource'
  ]);
  let changed=0;

  for(const symbol of symbols){
    const before=currentTokens[symbol]&&typeof currentTokens[symbol]==='object'?currentTokens[symbol]:null;
    const after=nextTokens[symbol]&&typeof nextTokens[symbol]==='object'?nextTokens[symbol]:null;
    if(!before||!after)return false;
    if(stableStringify(before)===stableStringify(after))continue;

    const beforeRest={...before};
    const afterRest={...after};
    for(const key of safeMutable){delete beforeRest[key];delete afterRest[key]}
    if(stableStringify(beforeRest)!==stableStringify(afterRest))return false;

    const maxLoss=n(after.maxLoss,NaN);
    const margin=n(after.margin,n(nextConfig?.settings?.margin,NaN));
    if(!(maxLoss>=2&&maxLoss<=REAL_RISK_LIMITS.maxLossUsd))return false;
    if(!(margin>0)||maxLoss>margin+1e-8)return false;
    if(String(after.marginType||'ISOLATED').toUpperCase()!=='ISOLATED')return false;

    const target=n(after.targetProfit,NaN),manual=n(after.manualTargetProfit,target);
    if(!(target>0)||!(manual>0)||Math.abs(target-manual)>1e-8)return false;
    const exactEnabled=after.exactSaleEnabled===true,exactPrice=n(after.exactSalePrice,0);
    if(exactEnabled&&!(exactPrice>0))return false;
    if(!(exactPrice>=0)||String(after.exactSaleSource||'settings')!=='settings')return false;
    if(!validActiveProtectionStages(after.protectionStages))return false;
    changed+=1;
  }

  return changed===1;
}

async function syncControllerConfig(){
  if(!runtime.leaseActive)return false;
  const {response,data}=await syncApi('master-config-status');
  if(!response.ok||data?.ok!==true)throw new Error(data?.code||('HTTP_'+response.status));

  runtime.controllerRevision=Math.max(0,n(data.controllerRevision));
  runtime.appliedRevision=Math.max(0,n(data.appliedRevision));

  const controllerState=data.controllerState||null;
  if(!controllerState){
    runtime.synchronized=data.synchronized===true;
    if(!runtime.synchronized)runtime.error=String(data.reason||'MASTER_CONFIG_OUT_OF_SYNC');
    return runtime.synchronized;
  }

  const localMatches=Boolean(
    runtime.config&&
    runtime.controllerRevision>0&&
    sha256Hex(stableStringify(runtime.config))===String(data.controllerStateHash||controllerState.stateHash||'')
  );

  if(data.synchronized===true&&localMatches){
    runtime.synchronized=true;
    runtime.error='';
    return true;
  }

  if(data.synchronized===true&&!localMatches){
    const activity=data.activity||{};
    if(n(activity.activePositions)>0||n(activity.openOrders)>0){
      if(!activeSafeTokenConfigRefreshAllowed(runtime.config,controllerState.data)){
        runtime.synchronized=false;
        runtime.error='ENGINE_LOCAL_CONFIG_DRIFT_ACTIVE';
        return false;
      }
      const applied=await applyControllerState(controllerState);
      runtime.appliedRevision=applied.revision;
      runtime.controllerRevision=applied.revision;
      runtime.synchronized=true;
      runtime.error='';
      return true;
    }
  }

  if(data.applyAllowed!==true&&data.synchronized!==true){
    runtime.synchronized=false;
    runtime.error=String(data.reason||'MASTER_CONFIG_APPLY_DEFERRED');
    return false;
  }

  const applied=await applyControllerState(controllerState);
  const ack=await syncApi('master-config-ack',{method:'POST',body:applied});
  if(!ack.response.ok||ack.data?.ok!==true){
    throw new Error(ack.data?.code||('HTTP_'+ack.response.status));
  }
  runtime.appliedRevision=applied.revision;
  runtime.controllerRevision=applied.revision;
  runtime.synchronized=true;
  runtime.error='';
  return true;
}

async function loadAutoHighWater(force=false){
  if(autoProtection.highWaterLoaded&&!force)return true;
  if(autoProtection.highWaterLoadPromise&&!force)return autoProtection.highWaterLoadPromise;
  const task=(async()=>{
    const result=await syncApi('engine-protection-high-water');
    if(!result.response.ok||result.data?.ok!==true){
      const code=String(result.data?.code||('HTTP_'+result.response.status));
      autoProtection.lastError=code;
      return false;
    }
    autoProtection.authorizationAt=n(result.data.authorizationAt,0);
    autoProtection.highWater.clear();
    const entries=result.data.entries&&typeof result.data.entries==='object'?result.data.entries:{};
    for(const [key,value] of Object.entries(entries)){
      const amount=Number(value);
      if(Number.isFinite(amount))autoProtection.highWater.set(key,amount);
    }
    autoProtection.highWaterLoaded=autoProtection.authorizationAt>0;
    return autoProtection.highWaterLoaded;
  })();
  autoProtection.highWaterLoadPromise=task;
  try{return await task}
  finally{autoProtection.highWaterLoadPromise=null}
}

async function persistAutoHighWaterNow(){
  if(autoProtection.highWaterSaveBusy)return false;
  if(!autoProtection.highWaterLoaded||!(autoProtection.authorizationAt>0))return false;
  autoProtection.highWaterSaveBusy=true;
  try{
    const entries={};
    for(const [key,value] of autoProtection.highWater.entries()){
      if(Number.isFinite(Number(value)))entries[key]=Number(value);
    }
    const result=await syncApi('engine-protection-high-water',{
      method:'POST',
      body:{authorizationAt:autoProtection.authorizationAt,entries},
    });
    if(!result.response.ok||result.data?.ok!==true){
      const code=String(result.data?.code||('HTTP_'+result.response.status));
      autoProtection.lastError=code;
      if(code==='ENGINE_HIGH_WATER_AUTHORIZATION_CHANGED'||code==='ENGINE_RESTART_AUTHORIZATION_REQUIRED'){
        autoProtection.highWaterLoaded=false;
        autoProtection.authorizationAt=0;
        autoProtection.highWater.clear();
      }
      return false;
    }
    return true;
  }catch(error){
    autoProtection.lastError=String(error?.message||'ENGINE_HIGH_WATER_SAVE_FAILED');
    return false;
  }finally{
    autoProtection.highWaterSaveBusy=false;
  }
}

function scheduleAutoHighWaterSave(delay=5000){
  if(autoProtection.highWaterSaveTimer)clearTimeout(autoProtection.highWaterSaveTimer);
  autoProtection.highWaterSaveTimer=setTimeout(()=>{
    autoProtection.highWaterSaveTimer=null;
    persistAutoHighWaterNow().catch(error=>logError('AUTO_HIGH_WATER_SAVE_FAILED',error));
  },Math.max(250,delay));
}

function entryWatchDefinitions(){
  const validated=runtime.config?.validated&&typeof runtime.config.validated==='object'
    ?runtime.config.validated:{};
  const out=[];
  for(const [symbol,row] of Object.entries(validated)){
    const definition=entryWatchDefinition(symbol,row);
    if(definition)out.push(definition);
  }
  return out;
}

function entryWatchDefinitionMap(){
  return new Map(entryWatchDefinitions().map(definition=>[definition.symbol,definition]));
}

function entryWatchStateObject(){
  return Object.fromEntries([...entryWatch.states.entries()].map(([symbol,state])=>[symbol,clone(state)]));
}

function entryWatchSeedArmed(definition){
  const row=runtime.config?.validated?.[definition.symbol];
  return Boolean(
    row?.armedAbove===true&&
    Date.now()-definition.validatedAt>=0&&
    Date.now()-definition.validatedAt<=ENTRY_WATCH_RECOVERY_MS
  );
}

async function loadEntryWatchState(force=false){
  if(entryWatch.loaded&&!force)return true;
  if(entryWatch.loadPromise&&!force)return entryWatch.loadPromise;
  const task=(async()=>{
    const result=await syncApi('engine-entry-watch-state');
    if(!result.response.ok||result.data?.ok!==true){
      entryWatch.lastError=String(result.data?.code||('HTTP_'+result.response.status));
      return false;
    }
    entryWatch.authorizationAt=n(result.data.authorizationAt,0);
    entryWatch.states.clear();
    const states=result.data.states&&typeof result.data.states==='object'?result.data.states:{};
    for(const [symbol,state] of Object.entries(states)){
      const definition=entryWatchDefinition(symbol,state);
      if(!definition||String(state?.identity||'')!==entryWatchIdentity(definition))continue;
      entryWatch.states.set(definition.symbol,clone(state));
      const aggId=n(state?.lastAggId,-1),aggTime=n(state?.lastAggTime,0);
      if(aggId>=0){
        const previous=n(markStream.lastAggIds.get(definition.symbol),-1);
        if(aggId>previous)markStream.lastAggIds.set(definition.symbol,aggId);
      }
      if(aggTime>0){
        const previous=n(markStream.lastAggTimes.get(definition.symbol),0);
        if(aggTime>previous)markStream.lastAggTimes.set(definition.symbol,aggTime);
      }
    }
    entryWatch.loaded=entryWatch.authorizationAt>0;
    return entryWatch.loaded;
  })();
  entryWatch.loadPromise=task;
  try{return await task}
  finally{entryWatch.loadPromise=null}
}

async function persistEntryWatchStateNow(){
  if(entryWatch.saveBusy)return false;
  if(!entryWatch.loaded||!(entryWatch.authorizationAt>0))return false;
  entryWatch.saveBusy=true;
  try{
    const result=await syncApi('engine-entry-watch-state',{
      method:'POST',
      body:{authorizationAt:entryWatch.authorizationAt,states:entryWatchStateObject()},
    });
    if(!result.response.ok||result.data?.ok!==true){
      const code=String(result.data?.code||('HTTP_'+result.response.status));
      entryWatch.lastError=code;
      if(code==='ENGINE_ENTRY_WATCH_AUTHORIZATION_CHANGED'||code==='ENGINE_RESTART_AUTHORIZATION_REQUIRED'){
        entryWatch.loaded=false;
        entryWatch.authorizationAt=0;
        entryWatch.states.clear();
      }
      return false;
    }
    entryWatch.lastError='';
    return true;
  }catch(error){
    entryWatch.lastError=String(error?.message||'ENGINE_ENTRY_WATCH_SAVE_FAILED');
    return false;
  }finally{
    entryWatch.saveBusy=false;
  }
}

function scheduleEntryWatchSave(delay=1000){
  if(entryWatch.saveTimer)clearTimeout(entryWatch.saveTimer);
  entryWatch.saveTimer=setTimeout(()=>{
    entryWatch.saveTimer=null;
    persistEntryWatchStateNow().catch(error=>logError('ENTRY_WATCH_SAVE_FAILED',error));
  },Math.max(250,delay));
}

function reconcileEntryWatchConfig(){
  if(!entryWatch.loaded)return false;
  const definitions=entryWatchDefinitions();
  const before=stableStringify(entryWatchStateObject());
  const pruned=pruneEntryWatchStates(entryWatchStateObject(),definitions);
  entryWatch.states=new Map(Object.entries(pruned));
  const changed=before!==stableStringify(pruned);
  if(changed)scheduleEntryWatchSave(250);
  return changed;
}

function watchedEntrySymbols(){
  const out=new Set();
  if(!entryWatch.loaded)return out;
  const active=activeProtectionSymbols();
  for(const definition of entryWatchDefinitions()){
    const state=entryWatch.states.get(definition.symbol);
    if(!active.has(definition.symbol)&&!(n(state?.triggeredAt,0)>0)&&!(n(state?.blockedAt,0)>0))out.add(definition.symbol);
  }
  return out;
}

function trackedMarkSymbols(){
  return new Set([...activeProtectionSymbols(),...watchedEntrySymbols()]);
}

function watchedEntryConfig(symbol){
  const wanted=String(symbol||'').toUpperCase();
  const definition=entryWatchDefinitionMap().get(wanted);
  if(!definition)return null;
  const tokenSettings=runtime.config?.tokenSettings&&typeof runtime.config.tokenSettings==='object'
    ?runtime.config.tokenSettings:{};
  const globalSettings=runtime.config?.settings&&typeof runtime.config.settings==='object'
    ?runtime.config.settings:{};
  const token=tokenSettings[wanted]&&typeof tokenSettings[wanted]==='object'?tokenSettings[wanted]:{};
  const margin=n(token.margin,n(globalSettings.margin,0));
  const leverage=n(token.leverage,n(globalSettings.leverage,0));
  const maxLoss=n(token.maxLoss,n(globalSettings.maxLoss,0));
  const maxActive=Math.max(
    1,
    Math.min(
      REAL_RISK_LIMITS.maxActivePositions,
      Math.floor(n(globalSettings.maxActive,REAL_RISK_LIMITS.maxActivePositions))
    )
  );
  if(!(margin>0)||!(leverage>0)||!(maxLoss>0))return null;
  return {
    ...definition,
    margin,leverage,maxLoss,maxActive,
  };
}

function occupiedRealEntrySlots(){
  const projection=streamProjection();
  const occupied=new Set();
  for(const position of projection.binancePositions||[]){
    if(Math.abs(n(position?.positionAmt??position?.quantity,0))>0){
      const symbol=String(position?.symbol||'').toUpperCase();
      if(symbol)occupied.add(symbol);
    }
  }
  for(const order of projection.binanceOrders||[]){
    const symbol=String(order?.symbol||'').toUpperCase();
    if(!symbol)continue;
    const reduceOnly=order?.reduceOnly===true||order?.reduceOnly==='true';
    const closePosition=order?.closePosition===true||order?.closePosition==='true';
    if(!reduceOnly&&!closePosition)occupied.add(symbol);
  }
  return occupied;
}

function entryWatchMayDispatch(symbol){
  const config=watchedEntryConfig(symbol);
  if(!config||!entryWatch.loaded)return false;
  if(!runtime.synchronized||!runtime.heartbeatFresh||runtime.mode!=='RUNNING')return false;
  if(!masterExecutionEligible({
    role:'master',
    hidden:false,
    leaseActive:runtime.leaseActive,
    realExecutionArmed:runtime.realExecutionArmed,
    userStreamReady:userStreamReady(stream.state),
    mode:runtime.mode,
  }))return false;
  const occupied=occupiedRealEntrySlots();
  return !occupied.has(config.symbol)&&occupied.size<config.maxActive;
}

function autoEntryCommandId(config){
  const digest=sha256Hex(`${config.symbol}|${config.validatedAt}|${config.buy}`).slice(0,20);
  return `auto-entry-${config.symbol}-${digest}`;
}

async function callEntryExecute(body){
  return binanceApi('/api/binance-entry-execute',{method:'POST',body});
}

async function currentBestAsk(symbol){
  const wanted=String(symbol||'').toUpperCase();
  if(!/^[A-Z0-9]{3,30}$/.test(wanted))throw new Error('ENTRY_BEST_ASK_SYMBOL_INVALID');
  const quote=await publicBinanceJson('/fapi/v1/ticker/bookTicker?symbol='+encodeURIComponent(wanted));
  if(String(quote?.symbol||'').toUpperCase()!==wanted)throw new Error('ENTRY_BEST_ASK_SYMBOL_MISMATCH');
  const askPrice=n(quote?.askPrice,0);
  const askQty=n(quote?.askQty,0);
  if(!(askPrice>0)||!(askQty>0))throw new Error('ENTRY_BEST_ASK_UNAVAILABLE');
  return {askPrice,askQty};
}

async function executeWatchedEntry(config,{limitPrice=config.buy,delayedCurrentPrice=false}={}){
  const symbol=config.symbol;
  const effectiveLimitPrice=n(limitPrice,0);
  if(!(effectiveLimitPrice>0))return {ok:false,reason:'ENTRY_LIMIT_PRICE_INVALID'};
  if(entryWatch.busySymbols.has(symbol))return {ok:false,reason:'ENTRY_ALREADY_BUSY'};
  if(!entryWatchMayDispatch(symbol))return {ok:false,reason:'ENTRY_SLOT_OR_RUNTIME_NOT_READY',slotBlocked:true};

  entryWatch.busySymbols.add(symbol);
  const commandId=autoEntryCommandId(config);
  const common={
    type:'EXEC_OPEN_POSITION',
    commandId,
    symbol,
    side:'BUY',
    orderType:'LIMIT',
    margin:config.margin,
    leverage:config.leverage,
    maxLoss:config.maxLoss,
    limitPrice:effectiveLimitPrice,
  };
  let preparedCommitted=false;
  try{
    const prepared=await callEntryExecute({...common,phase:'PREPARE_PROTECTION'});
    if(!prepared.response.ok||prepared.data?.ok!==true){
      const reasons=Array.isArray(prepared.data?.reasons)?prepared.data.reasons:[];
      const reason='ENTRY_PREPARE_'+String(prepared.data?.code||prepared.data?.reason||('HTTP_'+prepared.response.status));
      entryWatch.lastError=reason;
      return {
        ok:false,reason,
        slotBlocked:reasons.includes('MAX_ACTIVE_POSITIONS_REACHED'),
        prepared:false,
      };
    }
    preparedCommitted=true;
    const protectionId=String(prepared.data?.protectionPlan?.algoPlan?.params?.clientAlgoId||'');
    if(!/^zth-MAX-[A-Za-z0-9._:-]+$/.test(protectionId)){
      entryWatch.lastError='ENTRY_PREPARE_PROTECTION_ID_MISSING';
      return {ok:false,reason:entryWatch.lastError,prepared:true};
    }

    const protection=await waitForStreamOrder({kind:'ALGO',clientId:protectionId,terminal:false},3500);
    if(!protection){
      entryWatch.lastError='ENTRY_PREPARE_NOT_STREAM_CONFIRMED';
      scheduleReconcile(250);
      return {ok:false,reason:entryWatch.lastError,prepared:true};
    }

    await publishRuntime();
    const submitted=await callEntryExecute({...common,phase:'SUBMIT_ENTRY'});
    if(!submitted.response.ok||submitted.data?.ok!==true){
      entryWatch.lastError='ENTRY_SUBMIT_'+String(
        submitted.data?.code||submitted.data?.reason||('HTTP_'+submitted.response.status)
      );
      scheduleReconcile(250);
      return {ok:false,reason:entryWatch.lastError,prepared:true};
    }

    const entryId=String(submitted.data?.plan?.params?.newClientOrderId||'');
    if(!entryId){
      entryWatch.lastError='ENTRY_ORDER_ID_MISSING';
      scheduleReconcile(250);
      return {ok:false,reason:entryWatch.lastError,prepared:true};
    }

    entryWatch.lastActionAt=Date.now();
    entryWatch.lastError='';
    log('AUTO_ENTRY_SUBMITTED',{
      symbol,commandId,limitPrice:effectiveLimitPrice,
      requestedBuyPrice:config.buy,delayedCurrentPrice:delayedCurrentPrice===true,
      delayedPriceSource:delayedCurrentPrice===true?'BEST_ASK':'CONFIGURED_LIMIT',
      margin:config.margin,leverage:config.leverage,maxLoss:config.maxLoss,
      entryClientOrderId:entryId,protectionClientAlgoId:protectionId,
    });
    scheduleReconcile(150);
    return {ok:true,commandId,entryClientOrderId:entryId,protectionClientAlgoId:protectionId};
  }catch(error){
    const reason='AUTO_ENTRY_'+cleanReason(error?.message||'FAILED','FAILED');
    entryWatch.lastError=reason;
    scheduleReconcile(500);
    return {ok:false,reason,prepared:preparedCommitted};
  }finally{
    entryWatch.busySymbols.delete(symbol);
  }
}

async function processEntryWatchPrice(symbol,price,{eventId=-1,eventTime=Date.now()}={}){
  const wanted=String(symbol||'').toUpperCase();
  const definition=entryWatchDefinitionMap().get(wanted);
  if(!definition)return false;
  const previous=entryWatch.states.get(wanted)||null;
  const result=evaluateEntryWatchTick({
    definition,
    state:previous,
    price,
    eventId,
    eventTime,
    allowTrigger:entryWatchMayDispatch(wanted),
    seedArmed:!previous&&entryWatchSeedArmed(definition),
  });
  if(result.action==='DUPLICATE')return false;

  if(result.action==='TRIGGER'&&result.signal?.delayedCurrentPrice===true){
    try{
      const quote=await currentBestAsk(wanted);
      result.signal.limitPrice=quote.askPrice;
      result.signal.observedBestAsk=quote.askPrice;
      result.signal.observedBestAskQty=quote.askQty;
    }catch(error){
      const retryState={
        ...result.state,
        triggeredAt:0,
        pendingUntil:Math.max(n(previous?.pendingUntil,0),n(eventTime,Date.now())+1),
        blockedAt:0,
      };
      entryWatch.states.set(wanted,retryState);
      entryWatch.lastError='ENTRY_BEST_ASK_'+cleanReason(error?.message||'UNAVAILABLE','UNAVAILABLE');
      scheduleEntryWatchSave(250);
      return true;
    }
  }

  entryWatch.states.set(wanted,result.state);
  if(result.action==='PENDING'){
    entryWatch.lastCrossingAt=n(result.state.suppressedCrossingAt,Date.now());
    entryWatch.lastError='ENTRY_WAITING_FOR_POSITION_SLOT';
    scheduleEntryWatchSave(250);
    return true;
  }
  if(result.action==='EXPIRED'){
    entryWatch.lastError='ENTRY_TRIGGER_EXPIRED';
    scheduleEntryWatchSave(250);
    log('ENTRY_WATCH_EXPIRED',{symbol:wanted,buy:definition.buy});
    return true;
  }
  if(result.action!=='TRIGGER'){
    scheduleEntryWatchSave();
    return true;
  }

  // Persist the one-shot trigger before any Binance write. If persistence is unavailable,
  // fail closed and do not place a real order.
  if(!(await persistEntryWatchStateNow())){
    entryWatch.lastError='ENTRY_TRIGGER_NOT_PERSISTED';
    return false;
  }

  const config=watchedEntryConfig(wanted);
  if(!config){
    entryWatch.lastError='ENTRY_CONFIG_INVALID';
    return false;
  }
  const executed=await executeWatchedEntry(config,{
    limitPrice:n(result.signal?.limitPrice,config.buy),
    delayedCurrentPrice:result.signal?.delayedCurrentPrice===true,
  });
  if(executed.ok){
    scheduleEntryWatchSave(250);
    return true;
  }

  // A slot can disappear between the crossing decision and Binance preflight. Preserve the
  // historical 50-second waiting rule only if no protection/order was committed yet.
  if(executed.slotBlocked===true&&executed.prepared!==true){
    const state=entryWatch.states.get(wanted);
    if(state){
      const retry=entryWatchSlotRaceOutcome({
        previousPendingUntil:n(previous?.pendingUntil,0),
        crossingAt:n(result.signal?.eventTime,n(eventTime,Date.now())),
        now:Date.now(),
      });
      state.triggeredAt=0;
      state.pendingUntil=retry.pendingUntil;
      state.blockedAt=retry.blockedAt;
      entryWatch.states.set(wanted,state);
      entryWatch.lastError=retry.expired?'ENTRY_TRIGGER_EXPIRED':'ENTRY_WAITING_FOR_POSITION_SLOT';
      await persistEntryWatchStateNow().catch(()=>false);
      if(retry.expired)log('ENTRY_WATCH_EXPIRED',{symbol:wanted,buy:definition.buy,reason:'SLOT_RACE'});
    }
  }
  log('AUTO_ENTRY_FAILED',{symbol:wanted,reason:executed.reason||'UNKNOWN'});
  return false;
}

async function pruneAutoHighWater(){
  if(!autoProtection.highWaterLoaded||userStreamReady(stream.state)!==true)return false;
  const active=new Set(
    (streamProjection().binancePositions||[])
      .filter(position=>Math.abs(n(position?.positionAmt??position?.quantity,0))>0)
      .map(autoPositionKey)
  );
  let changed=false;
  for(const key of [...autoProtection.highWater.keys()]){
    if(!active.has(key)){
      autoProtection.highWater.delete(key);
      changed=true;
    }
  }
  if(changed)await persistAutoHighWaterNow();
  return changed;
}

function uniqueManagedMaxLoss(position,orders,hardMaxLossUsd=REAL_RISK_LIMITS.maxLossUsd){
  const amount=n(position?.positionAmt??position?.quantity,0);
  const direction=amount>=0?'LONG':'SHORT';
  const quantity=Math.abs(amount);
  const symbol=String(position?.symbol||'').toUpperCase();
  const side=direction==='LONG'?'SELL':'BUY';
  const entry=n(position?.entryPrice,0);
  const cap=n(hardMaxLossUsd,0);
  if(!(quantity>0)||!(entry>0)||!(cap>0))return false;
  const rows=(Array.isArray(orders)?orders:[]).filter(order=>{
    if(String(order?.orderClass||'').toUpperCase()!=='ALGO')return false;
    if(String(order?.symbol||'').toUpperCase()!==symbol)return false;
    if(String(order?.side||'').toUpperCase()!==side)return false;
    if(String(order?.positionSide||'BOTH').toUpperCase()!=='BOTH')return false;
    if(String(order?.type||'').toUpperCase()!=='STOP')return false;
    if(String(order?.timeInForce||'').toUpperCase()!=='IOC')return false;
    if(!(order?.reduceOnly===true||order?.reduceOnly==='true'))return false;
    if(order?.closePosition===true||order?.closePosition==='true')return false;
    if(!realNumberMatches(order?.origQty??order?.quantity,quantity))return false;
    if(String(order?.priceMatch||'').toUpperCase()!=='OPPONENT')return false;
    if(!zenithManagedRealId(order?.clientAlgoId))return false;
    const trigger=n(order?.triggerPrice??order?.stopPrice,0);
    if(!(trigger>0))return false;
    const lossSide=direction==='LONG'?trigger<entry:trigger>entry;
    if(!lossSide)return false;
    const impliedLossUsd=direction==='LONG'
      ?(entry-trigger)*quantity
      :(trigger-entry)*quantity;
    return impliedLossUsd<=cap+1e-8;
  });
  return rows.length===1;
}

function rememberPriceFilters(snapshot){
  const rows=snapshot?.priceFilters;
  if(!rows||typeof rows!=='object'||Array.isArray(rows))return;
  for(const [symbol,filter] of Object.entries(rows)){
    if(n(filter?.tickSize,0)>0){
      autoProtection.priceFilters.set(String(symbol).toUpperCase(),clone(filter));
    }
  }
}

async function ensurePriceFilter(symbol){
  const key=String(symbol||'').toUpperCase();
  const cached=autoProtection.priceFilters.get(key);
  if(cached&&n(cached.tickSize,0)>0)return cached;
  if(Date.now()-autoProtection.metadataFetchAt<5000)return null;
  autoProtection.metadataFetchAt=Date.now();
  const result=await binanceApi('/api/binance-runtime-snapshot');
  if(!result.response.ok||result.data?.ok!==true||!result.data?.snapshot)return null;
  rememberPriceFilters(result.data.snapshot);
  return autoProtection.priceFilters.get(key)||null;
}

async function failClosedAutoProtection(reason){
  const code=String(reason||'AUTO_PROTECTION_FAIL_CLOSED');
  autoProtection.lastError=code;
  runtime.error=code;
  await invalidateStream(code).catch(()=>{});
}

async function failClosedAutoTarget(reason){
  const code='AUTO_TARGET_'+String(reason||'FAIL_CLOSED');
  autoTarget.lastError=code;
  runtime.error=code;
  await invalidateStream(code).catch(()=>{});
  return {ok:false,reason:code};
}

function configuredMaxLossForSymbol(symbol){
  const wanted=String(symbol||'').toUpperCase();
  const tokenSettings=runtime.config?.tokenSettings&&typeof runtime.config.tokenSettings==='object'
    ?runtime.config.tokenSettings:{};
  const globalSettings=runtime.config?.settings&&typeof runtime.config.settings==='object'
    ?runtime.config.settings:{};
  const token=tokenSettings[wanted]&&typeof tokenSettings[wanted]==='object'?tokenSettings[wanted]:{};
  const value=n(token.maxLoss,n(globalSettings.maxLoss,NaN));
  return value>0?Math.min(value,REAL_RISK_LIMITS.maxLossUsd):NaN;
}

async function ensureAutomaticTargetForPosition(position){
  const symbol=String(position?.symbol||'').toUpperCase();
  if(!symbol||autoTarget.busySymbols.has(symbol))return {ok:true,changed:false,reason:'BUSY_OR_INVALID'};
  if(!runtime.synchronized||!runtime.heartbeatFresh)return {ok:true,changed:false,reason:'RUNTIME_NOT_READY'};
  if(!masterExecutionEligible({
    role:'master',hidden:false,leaseActive:runtime.leaseActive,
    realExecutionArmed:runtime.realExecutionArmed,
    userStreamReady:userStreamReady(stream.state),mode:runtime.mode,
  }))return {ok:true,changed:false,reason:'EXECUTION_NOT_ELIGIBLE'};

  const projection=streamProjection();
  const orders=Array.isArray(projection.binanceOrders)?projection.binanceOrders:[];
  const configuredMaxLoss=configuredMaxLossForSymbol(symbol);
  if(!(configuredMaxLoss>0))return failClosedAutoTarget('MAX_LOSS_CONFIG_UNAVAILABLE');
  const maxLossConfirmed=uniqueManagedMaxLoss(position,orders,configuredMaxLoss);
  const priceFilter=await ensurePriceFilter(symbol);
  if(!priceFilter)return failClosedAutoTarget('PRICE_FILTER_UNAVAILABLE');

  const tokenSettings=runtime.config?.tokenSettings&&typeof runtime.config.tokenSettings==='object'
    ?runtime.config.tokenSettings:{};
  const globalSettings=runtime.config?.settings&&typeof runtime.config.settings==='object'
    ?runtime.config.settings:{};
  const plan=planAutomaticTargetExit({
    position,currentOrders:orders,tokenSettings,settings:globalSettings,
    priceFilter,maxLossConfirmed,
  });

  if(plan.action==='NONE'){
    autoTarget.lastError='';
    return {ok:true,changed:false,reason:plan.reason};
  }
  if(!['PLACE','REPLACE'].includes(plan.action))return failClosedAutoTarget(plan.reason||'PLAN_BLOCKED');

  autoTarget.busySymbols.add(symbol);
  try{
    let activePlan=plan;

    if(activePlan.action==='REPLACE'){
      const live=activePlan.live;
      const previousClientOrderId=String(activePlan.previousClientOrderId||'');
      if(!/^zth-EXI-[A-Za-z0-9._:-]+$/.test(previousClientOrderId)){
        return failClosedAutoTarget('PREVIOUS_CLIENT_ORDER_ID_INVALID');
      }
      const commandId=`auto-target-refresh-${live.symbol}-${live.direction}-${live.lifecycleAt||0}`;
      const canceled=await callProtectiveUpdateExecute({
        type:'EXEC_UPDATE_EXIT',phase:'CANCEL_OLD',commandId,
        symbol:live.symbol,direction:live.direction,quantity:live.quantity,
        targetPrice:activePlan.targetPrice,previousClientOrderId,
      });
      if(!canceled.response.ok||canceled.data?.ok!==true){
        const reason='CANCEL_'+String(canceled.data?.code||canceled.data?.reason||('HTTP_'+canceled.response.status));
        if(canceled.data?.writeAttempted===true||canceled.data?.ambiguous===true||canceled.data?.result?.ambiguous===true){
          return failClosedAutoTarget(reason+'_AMBIGUOUS');
        }
        return failClosedAutoTarget(reason);
      }
      const terminal=await waitForStreamOrder({kind:'STANDARD',clientId:previousClientOrderId,terminal:true},3000);
      const terminalStatus=String(
        terminal?.status||
        canceled.data?.result?.order?.status||
        ''
      ).toUpperCase();
      if(!['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(terminalStatus)){
        return failClosedAutoTarget('PREVIOUS_TARGET_CANCEL_NOT_CONFIRMED');
      }

      // Re-read the Binance position after the old target is gone. Another slice of the
      // pending BUY LIMIT may have filled while cancellation was in flight.
      await publishRuntime();
      const latestProjection=streamProjection();
      const latestOrders=Array.isArray(latestProjection.binanceOrders)?latestProjection.binanceOrders:[];
      const latestPosition=(latestProjection.binancePositions||[]).find(row=>{
        if(String(row?.symbol||'').toUpperCase()!==live.symbol)return false;
        const amount=n(row?.positionAmt??row?.quantity,0);
        return (amount>0?'LONG':'SHORT')===live.direction&&Math.abs(amount)>0;
      });
      if(!latestPosition)return {ok:true,changed:true,reason:'POSITION_CLOSED_DURING_TARGET_REFRESH'};
      const refreshedMaxLoss=uniqueManagedMaxLoss(latestPosition,latestOrders,configuredMaxLoss);
      activePlan=planAutomaticTargetExit({
        position:latestPosition,currentOrders:latestOrders,tokenSettings,settings:globalSettings,
        priceFilter,maxLossConfirmed:refreshedMaxLoss,
      });
      if(activePlan.action==='NONE'){
        autoTarget.lastError='';
        return {ok:true,changed:true,reason:'TARGET_REFRESH_ALREADY_SATISFIED'};
      }
      if(activePlan.action!=='PLACE'){
        return failClosedAutoTarget(activePlan.reason||'TARGET_REFRESH_REPLAN_BLOCKED');
      }
    }

    const live=activePlan.live;
    const targetIdentity=sha256Hex(`${live.quantity}|${activePlan.targetPrice}`).slice(0,12);
    const commandId=`auto-target-${live.symbol}-${live.direction}-${live.lifecycleAt||0}-${targetIdentity}`;
    const body={
      type:'EXEC_UPDATE_EXIT',phase:'PLACE_NEW',commandId,
      symbol:live.symbol,direction:live.direction,quantity:live.quantity,
      targetPrice:activePlan.targetPrice,
    };
    const placed=await callProtectiveUpdateExecute(body);
    if(!placed.response.ok||placed.data?.ok!==true){
      const reason='PLACE_'+String(placed.data?.code||placed.data?.reason||('HTTP_'+placed.response.status));
      if(placed.data?.writeAttempted===true||placed.data?.ambiguous===true||placed.data?.result?.ambiguous===true){
        return failClosedAutoTarget(reason+'_AMBIGUOUS');
      }
      return failClosedAutoTarget(reason);
    }

    const clientId=String(placed.data?.plan?.params?.newClientOrderId||'');
    if(!/^zth-EXI-[A-Za-z0-9._:-]+$/.test(clientId)){
      return failClosedAutoTarget('CLIENT_ORDER_ID_INVALID');
    }
    const order=await waitForStreamOrder({kind:'STANDARD',clientId,terminal:false},3500);
    const expectedSide=live.direction==='LONG'?'SELL':'BUY';
    const remaining=n(order?.origQty,0)-n(order?.executedQty,0);
    const valid=Boolean(
      order&&
      String(order?.symbol||'').toUpperCase()===live.symbol&&
      String(order?.side||'').toUpperCase()===expectedSide&&
      String(order?.positionSide||'BOTH').toUpperCase()==='BOTH'&&
      String(order?.type||'').toUpperCase()==='LIMIT'&&
      String(order?.timeInForce||'').toUpperCase()==='GTC'&&
      (order?.reduceOnly===true||order?.reduceOnly==='true')&&
      realNumberMatches(order?.price,activePlan.targetPrice)&&
      realNumberMatches(remaining,live.quantity)
    );
    if(!valid)return failClosedAutoTarget('ORDER_NOT_STREAM_CONFIRMED');

    await publishRuntime();
    autoTarget.lastError='';
    autoTarget.lastActionAt=Date.now();
    log('AUTO_TARGET_LIMIT_PLACED',{
      symbol:live.symbol,direction:live.direction,quantity:live.quantity,
      targetPrice:activePlan.targetPrice,targetSource:activePlan.targetSource,clientOrderId:clientId,
    });
    return {ok:true,changed:true,reason:'AUTO_TARGET_LIMIT_PLACED'};
  }finally{
    autoTarget.busySymbols.delete(symbol);
  }
}

async function ensureAutomaticTargets(){
  const positions=(streamProjection().binancePositions||[])
    .filter(position=>Math.abs(n(position?.positionAmt??position?.quantity,0))>0);
  for(const position of positions){
    const result=await ensureAutomaticTargetForPosition(position);
    if(result?.ok!==true||result?.changed===true)return result;
  }
  return {ok:true,changed:false,reason:'ALL_TARGETS_READY'};
}

async function executeAutoProgressive(plan){
  const live=plan.live,level=plan.level;
  const body={
    type:'EXEC_UPDATE_PROTECTION',
    commandId:`auto-protect-${live.symbol}-${live.direction}-${Math.round(plan.stage.armProfitUsd*10)}-${Math.round(plan.stage.protectedProfitUsd*10)}-${live.lifecycleAt||live.updateTime||0}`,
    symbol:live.symbol,
    direction:live.direction,
    quantity:live.quantity,
    triggerPrice:level.triggerPrice,
    limitPrice:level.limitPrice,
    protectionKind:'PROGRESSIVE',
    ...(plan.previousClientAlgoId?{previousClientAlgoId:plan.previousClientAlgoId}:{})
  };

  if(!(await persistAutoHighWaterNow())){
    autoProtection.lastError='AUTO_HIGH_WATER_NOT_PERSISTED';
    return false;
  }

  const placed=await callProtectiveUpdateExecute({...body,phase:'PLACE_NEW'});
  if(!placed.response.ok||placed.data?.ok!==true){
    const reason='AUTO_PLACE_'+String(placed.data?.code||placed.data?.reason||('HTTP_'+placed.response.status));
    if(placed.data?.writeAttempted===true||placed.data?.ambiguous===true||placed.data?.result?.ambiguous===true){
      await failClosedAutoProtection(reason+'_AMBIGUOUS');
    }else{
      autoProtection.lastError=reason;
    }
    return false;
  }

  const clientId=String(placed.data?.plan?.params?.clientAlgoId||'');
  if(!clientId){
    await failClosedAutoProtection('AUTO_NEW_PROTECTION_ID_MISSING');
    return false;
  }
  const order=await waitForStreamOrder({kind:'ALGO',clientId,terminal:false},3500);
  if(!order){
    await failClosedAutoProtection('AUTO_NEW_PROTECTION_NOT_STREAM_CONFIRMED');
    return false;
  }
  if(String(order?.type||'').toUpperCase()!=='STOP'||
     String(order?.timeInForce||'').toUpperCase()!=='GTC'||
     !(order?.reduceOnly===true||order?.reduceOnly==='true')||
     !realNumberMatches(order?.triggerPrice,level.triggerPrice)||
     !realNumberMatches(order?.price,level.limitPrice)||
     (order?.priceMatch&&String(order.priceMatch).toUpperCase()!=='NONE')){
    await failClosedAutoProtection('AUTO_NEW_PROTECTION_IDENTITY_MISMATCH');
    return false;
  }

  await publishRuntime();
  if(await awaitReconciliation()!==true){
    await failClosedAutoProtection('AUTO_POST_PLACE_RECONCILIATION_FAILED');
    return false;
  }

  if(plan.previousClientAlgoId){
    const canceled=await callProtectiveUpdateExecute({
      ...body,phase:'CANCEL_OLD',newClientAlgoId:clientId
    });
    if(!canceled.response.ok||canceled.data?.ok!==true){
      await failClosedAutoProtection(
        'AUTO_CANCEL_'+String(canceled.data?.code||canceled.data?.reason||('HTTP_'+canceled.response.status))
      );
      return false;
    }
    const terminal=await waitForStreamOrder({
      kind:'ALGO',clientId:plan.previousClientAlgoId,terminal:true
    },3000);
    const terminalStatus=String(
      terminal?.status||canceled.data?.result?.algoOrder?.algoStatus||''
    ).toUpperCase();
    if(!['CANCELED','EXPIRED','REJECTED'].includes(terminalStatus)){
      await failClosedAutoProtection('AUTO_OLD_PROTECTION_CANCEL_NOT_CONFIRMED');
      return false;
    }
    if(await awaitReconciliation()!==true){
      await failClosedAutoProtection('AUTO_POST_CANCEL_RECONCILIATION_FAILED');
      return false;
    }
  }

  autoProtection.lastError='';
  autoProtection.lastActionAt=Date.now();
  return true;
}

async function runAutoProtection(symbol,mark){
  const wanted=String(symbol||'').toUpperCase();
  const projection=streamProjection();
  const position=(projection.binancePositions||[])
    .find(row=>String(row?.symbol||'').toUpperCase()===wanted&&Math.abs(n(row?.positionAmt??row?.quantity,0))>0);
  if(!position)return false;

  if(!autoProtection.highWaterLoaded){
    const loaded=await loadAutoHighWater();
    if(!loaded)return false;
  }
  const highWater=observeAutoHighWater(position,mark);
  if(autoProtection.busySymbols.has(wanted))return false;

  if(!runtime.synchronized||!runtime.heartbeatFresh)return false;
  if(!masterExecutionEligible({
    role:'master',
    hidden:false,
    leaseActive:runtime.leaseActive,
    realExecutionArmed:runtime.realExecutionArmed,
    userStreamReady:userStreamReady(stream.state),
    mode:runtime.mode,
  }))return false;

  const tokenSettings=runtime.config?.tokenSettings&&typeof runtime.config.tokenSettings==='object'
    ?runtime.config.tokenSettings:{};
  const globalSettings=runtime.config?.settings&&typeof runtime.config.settings==='object'
    ?runtime.config.settings:{};
  const tokenCfg=tokenSettings[wanted]&&typeof tokenSettings[wanted]==='object'?tokenSettings[wanted]:{};
  const protectionStages=Array.isArray(tokenCfg.protectionStages)
    ?tokenCfg.protectionStages
    :Array.isArray(globalSettings.protectionStages)
      ?globalSettings.protectionStages
      :null;
  if(!protectionStages)return false;

  const orders=Array.isArray(projection.binanceOrders)?projection.binanceOrders:[];
  if(!uniqueManagedMaxLoss(position,orders)){
    autoProtection.lastError='AUTO_MAX_LOSS_NOT_UNIQUE';
    return false;
  }
  const priceFilter=await ensurePriceFilter(wanted);
  if(!priceFilter){
    autoProtection.lastError='AUTO_PRICE_FILTER_UNAVAILABLE';
    return false;
  }

  let plan;
  try{
    plan=evaluateMasterAutoProgressiveProtection({
      position,
      markPrice:mark,
      protectionStages,
      currentOrders:orders,
      priceFilter,
      previousHighWaterProfitUsd:highWater,
    });
  }catch(error){
    autoProtection.lastError=String(error?.message||'AUTO_PROTECTION_PLAN_FAILED');
    return false;
  }

  if(plan.action==='BLOCK'){
    autoProtection.lastError=String(plan.reason||'AUTO_PROTECTION_BLOCKED');
    return false;
  }
  if(plan.action!=='REPLACE'){
    autoProtection.lastError='';
    return false;
  }

  autoProtection.busySymbols.add(wanted);
  try{return await executeAutoProgressive(plan)}
  finally{autoProtection.busySymbols.delete(wanted)}
}

function activeProtectionSymbols(){
  return new Set(
    (streamProjection().binancePositions||[])
      .filter(position=>Math.abs(n(position?.positionAmt??position?.quantity,0))>0)
      .map(position=>String(position?.symbol||'').toUpperCase())
      .filter(Boolean)
  );
}

function markStreamName(symbol){
  return String(symbol||'').toLowerCase()+'@aggTrade';
}

function activePositionForSymbol(symbol){
  const wanted=String(symbol||'').toUpperCase();
  return (streamProjection().binancePositions||[])
    .find(position=>String(position?.symbol||'').toUpperCase()===wanted&&
      Math.abs(n(position?.positionAmt??position?.quantity,0))>0)||null;
}

function trackingStartTime(symbol){
  const wanted=String(symbol||'').toUpperCase();
  const position=activePositionForSymbol(wanted);
  const definition=entryWatchDefinitionMap().get(wanted);
  const state=entryWatch.states.get(wanted);
  return Math.max(
    0,
    n(markStream.lastAggTimes.get(wanted),0),
    n(position?.lifecycleAt??position?.positionLifecycleAt??position?.updateTime,0),
    n(state?.lastAggTime,0),
    n(definition?.validatedAt,Date.now()-2000)
  );
}

function rememberAggCursor(symbol,id,time){
  const wanted=String(symbol||'').toUpperCase();
  if(Number.isFinite(Number(id)))markStream.lastAggIds.set(wanted,Number(id));
  if(Number.isFinite(Number(time)))markStream.lastAggTimes.set(wanted,Number(time));
}

async function processAggTradeRow(symbol,row){
  if(!row)return false;
  const wanted=String(symbol||row?.s||'').toUpperCase();
  const tracked=trackedMarkSymbols();
  if(!tracked.has(wanted))return false;
  const id=n(row?.a,-1);
  const eventTime=n(row?.T,n(row?.E,Date.now()));
  const previousId=markStream.lastAggIds.get(wanted);
  if(Number.isFinite(previousId)&&id>=0&&id<=previousId)return false;
  const price=n(row?.p,0);
  if(!(price>0))return false;
  markStream.lastEventAt=Date.now();
  if(activeProtectionSymbols().has(wanted))await runAutoProtection(wanted,price);
  if(watchedEntrySymbols().has(wanted)){
    await processEntryWatchPrice(wanted,price,{eventId:id,eventTime});
  }
  rememberAggCursor(wanted,id,eventTime);
  return true;
}

async function recoverMissedAggTrades(symbol){
  const wanted=String(symbol||'').toUpperCase();
  if(!trackedMarkSymbols().has(wanted)||markStream.recovering.has(wanted))return false;
  markStream.recovering.add(wanted);
  markStream.pendingAggTrades.set(wanted,[]);
  try{
    let start=Math.max(Date.now()-ENTRY_WATCH_RECOVERY_MS,trackingStartTime(wanted)-250);
    let fromId=null;
    let pages=0;
    while(trackedMarkSymbols().has(wanted)&&pages<25){
      const path=fromId==null
        ?`/fapi/v1/aggTrades?symbol=${encodeURIComponent(wanted)}&startTime=${Math.floor(start)}&limit=1000`
        :`/fapi/v1/aggTrades?symbol=${encodeURIComponent(wanted)}&fromId=${fromId}&limit=1000`;
      const rows=await publicBinanceJson(path);
      if(!Array.isArray(rows)||!rows.length)break;
      for(const row of rows){
        if(!trackedMarkSymbols().has(wanted))break;
        await processAggTradeRow(wanted,row);
      }
      pages++;
      if(rows.length<1000)break;
      fromId=n(rows[rows.length-1]?.a,-1)+1;
      if(!(fromId>0))break;
      await sleep(40);
    }
    if(pages>=25){
      if(activeProtectionSymbols().has(wanted)){
        await failClosedAutoProtection('MARK_RECOVERY_PARTIAL_'+wanted);
      }else{
        entryWatch.lastError='ENTRY_WATCH_RECOVERY_PARTIAL_'+wanted;
        const state=entryWatch.states.get(wanted);
        if(state){
          state.armedAbove=false;
          entryWatch.states.set(wanted,state);
          scheduleEntryWatchSave(250);
        }
      }
      return false;
    }
    return true;
  }catch(error){
    if(activeProtectionSymbols().has(wanted)){
      await failClosedAutoProtection(
        'MARK_RECOVERY_FAILED_'+cleanReason(error?.message||'BINANCE_PUBLIC_RECOVERY','BINANCE_PUBLIC_RECOVERY')
      );
    }else{
      entryWatch.lastError='ENTRY_WATCH_RECOVERY_FAILED_'+cleanReason(error?.message||'BINANCE_PUBLIC_RECOVERY','BINANCE_PUBLIC_RECOVERY');
      const state=entryWatch.states.get(wanted);
      if(state){
        state.armedAbove=false;
        entryWatch.states.set(wanted,state);
        scheduleEntryWatchSave(250);
      }
    }
    return false;
  }finally{
    const queued=markStream.pendingAggTrades.get(wanted)||[];
    markStream.recovering.delete(wanted);
    markStream.pendingAggTrades.delete(wanted);
    queued.sort((a,b)=>n(a?.a)-n(b?.a)||n(a?.T)-n(b?.T));
    for(const row of queued){
      if(trackedMarkSymbols().has(wanted))await processAggTradeRow(wanted,row);
    }
  }
}

function sendMarkControl(method,params){
  if(!markStream.ws||markStream.ws.readyState!==WebSocket.OPEN||!Array.isArray(params)||!params.length)return false;
  try{
    markStream.ws.send(JSON.stringify({method,params,id:markStream.requestId++}));
    return true;
  }catch{
    return false;
  }
}

function syncMarkSubscriptions(){
  if(!markStream.ws||markStream.ws.readyState!==WebSocket.OPEN)return false;
  const symbols=trackedMarkSymbols();
  const desired=new Set([...symbols].map(markStreamName));
  const add=[...desired].filter(name=>!markStream.subscribed.has(name));
  const remove=[...markStream.subscribed].filter(name=>!desired.has(name));
  if(add.length&&sendMarkControl('SUBSCRIBE',add)){
    add.forEach(name=>markStream.subscribed.add(name));
    for(const symbol of symbols){
      if(add.includes(markStreamName(symbol))){
        void recoverMissedAggTrades(symbol).catch(error=>logError('MARK_RECOVERY_FAILED',error,{symbol}));
      }
    }
  }
  if(remove.length&&sendMarkControl('UNSUBSCRIBE',remove))remove.forEach(name=>markStream.subscribed.delete(name));
  return true;
}

function scheduleMarkReconnect(delay=3000){
  if(stopping||!runtime.leaseActive)return;
  if(markStream.reconnectTimer)clearTimeout(markStream.reconnectTimer);
  markStream.reconnectTimer=setTimeout(()=>{
    markStream.reconnectTimer=null;
    ensureMarkPriceStream().catch(error=>logError('MARK_STREAM_RECONNECT_FAILED',error));
  },Math.max(500,delay));
}

function closeMarkPriceStream(reason='MARK_STREAM_DISCONNECTED',reconnect=true){
  const ws=markStream.ws;
  markStream.ws=null;
  markStream.subscribed.clear();
  markStream.lastError=String(reason||'MARK_STREAM_DISCONNECTED');
  if(markStream.restartTimer){clearTimeout(markStream.restartTimer);markStream.restartTimer=null}
  if(ws&&ws.readyState<2){
    try{ws.close(1000,'zenith-mark-reconnect')}catch{}
  }
  if(reconnect)scheduleMarkReconnect();
}

async function processMarkPayload(payload){
  const row=payload?.data&&typeof payload.data==='object'?payload.data:payload;
  if(!row||String(row?.e||'')!=='aggTrade')return false;
  const symbol=String(row?.s||'').toUpperCase();
  if(markStream.recovering.has(symbol)){
    const queued=markStream.pendingAggTrades.get(symbol)||[];
    if(queued.length>=1000){
      if(activeProtectionSymbols().has(symbol)){
        await failClosedAutoProtection('MARK_RECOVERY_BUFFER_OVERFLOW_'+symbol);
      }else{
        entryWatch.lastError='ENTRY_WATCH_RECOVERY_BUFFER_OVERFLOW_'+symbol;
        const state=entryWatch.states.get(symbol);
        if(state){
          state.armedAbove=false;
          entryWatch.states.set(symbol,state);
          scheduleEntryWatchSave(250);
        }
      }
      return false;
    }
    queued.push(row);
    markStream.pendingAggTrades.set(symbol,queued);
    return true;
  }
  return processAggTradeRow(symbol,row);
}

async function fallbackMarkPrices(){
  if(stopping||!runtime.leaseActive)return false;
  if(markStream.ws&&markStream.ws.readyState===WebSocket.OPEN)return false;
  if(!trackedMarkSymbols().size)return false;
  try{
    const tasks=[];
    if(activeProtectionSymbols().size){
      const result=await binanceApi('/api/binance-read');
      if(result.response.status!==429&&result.response.ok&&result.data?.ok===true){
        for(const position of Array.isArray(result.data?.positions)?result.data.positions:[]){
          const symbol=String(position?.symbol||'').toUpperCase();
          const mark=n(position?.markPrice,0);
          if(activeProtectionSymbols().has(symbol)&&mark>0)tasks.push(runAutoProtection(symbol,mark));
        }
      }else if(result.response.status!==429){
        const code=String(result.data?.code||('HTTP_'+result.response.status));
        if(fatalAuthorityCode(code)){
          const error=new Error(code);error.code=code;throw error;
        }
        markStream.lastError='MARK_FALLBACK_'+code;
      }
    }
    const watched=watchedEntrySymbols();
    if(watched.size){
      const prices=await publicBinanceJson('/fapi/v1/ticker/price');
      for(const row of Array.isArray(prices)?prices:[]){
        const symbol=String(row?.symbol||'').toUpperCase();
        const px=n(row?.price,0);
        if(watched.has(symbol)&&px>0){
          tasks.push(processEntryWatchPrice(symbol,px,{eventId:-1,eventTime:Date.now()}));
        }
      }
    }
    if(tasks.length)await Promise.allSettled(tasks);
    return true;
  }catch(error){
    const code=String(error?.code||error?.message||'MARK_FALLBACK_FAILED');
    markStream.lastError=code;
    if(fatalAuthorityCode(code))throw error;
    return false;
  }
}

async function ensureMarkPriceStream(){
  if(stopping||!runtime.leaseActive)return false;
  if(markStream.ws&&(markStream.ws.readyState===WebSocket.OPEN||markStream.ws.readyState===WebSocket.CONNECTING)){
    syncMarkSubscriptions();
    return true;
  }
  const generation=++markStream.generation;
  const socket=new WebSocket('wss://fstream.binance.com/market/ws');
  markStream.ws=socket;

  socket.addEventListener('open',()=>{
    if(markStream.ws!==socket||generation!==markStream.generation)return;
    markStream.lastError='';
    markStream.subscribed.clear();
    syncMarkSubscriptions();
    if(markStream.restartTimer)clearTimeout(markStream.restartTimer);
    markStream.restartTimer=setTimeout(
      ()=>closeMarkPriceStream('SCHEDULED_23H_MARK_RECONNECT',true),
      STREAM_RESTART_MS
    );
  });
  socket.addEventListener('message',async event=>{
    if(markStream.ws!==socket||generation!==markStream.generation)return;
    try{
      let raw=event.data;
      if(raw instanceof ArrayBuffer)raw=Buffer.from(raw).toString('utf8');
      else if(ArrayBuffer.isView(raw))raw=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength).toString('utf8');
      else raw=String(raw);
      await processMarkPayload(JSON.parse(raw));
    }catch(error){
      markStream.lastError=String(error?.message||'MARK_STREAM_EVENT_INVALID');
    }
  });
  socket.addEventListener('error',()=>{markStream.lastError='MARK_STREAM_SOCKET_ERROR'});
  socket.addEventListener('close',()=>{
    if(markStream.ws!==socket)return;
    markStream.ws=null;
    markStream.subscribed.clear();
    void fallbackMarkPrices();
    scheduleMarkReconnect();
  });
  return true;
}

function streamProjection(){
  return runtimeInventoryFromUserStream(stream.state,'REAL');
}

function runtimeSnapshot(){
  const projection=streamProjection();
  const executionMode='REAL';
  return {
    executionMode,
    mode:executionMode,
    openPositions:[],
    activePositions:n(projection.activePositions),
    openOrders:[],
    openOrderCount:n(projection.openOrderCount),
    binancePositions:Array.isArray(projection.binancePositions)?projection.binancePositions:[],
    binanceOrders:Array.isArray(projection.binanceOrders)?projection.binanceOrders:[],
    userStream:projection.userStream,
  };
}

async function publishRuntime(){
  if(!runtime.leaseActive)return false;
  const {response,data}=await syncApi('state',{
    method:'POST',
    body:{
      controllerRevision:runtime.controllerRevision,
      appliedRevision:runtime.appliedRevision,
      data:runtimeSnapshot(),
    },
  });
  if(!response.ok||data?.ok!==true)throw new Error(data?.code||('HTTP_'+response.status));
  syncMarkSubscriptions();
  return true;
}

async function invalidateStream(reason='RECONCILIATION_REQUIRED'){
  stream.state=markUserStreamNeedsReconciliation(stream.state,reason);
  stream.lastError=String(reason||'RECONCILIATION_REQUIRED');
  await publishRuntime().catch(()=>{});
}

function clearStreamTimers(){
  for(const key of ['keepaliveTimer','restartTimer','reconcileTimer','reconcileInterval']){
    if(stream[key]){
      clearTimeout(stream[key]);
      clearInterval(stream[key]);
      stream[key]=null;
    }
  }
}

function scheduleReconnect(delay=3000){
  if(stopping||!runtime.leaseActive)return;
  if(stream.reconnectTimer)clearTimeout(stream.reconnectTimer);
  stream.reconnectTimer=setTimeout(()=>{
    stream.reconnectTimer=null;
    ensureUserStream().catch(error=>logError('STREAM_RECONNECT_FAILED',error));
  },Math.max(500,delay));
}

async function closeLocalStream(reason='STREAM_DISCONNECTED',reconnect=true){
  const ws=stream.ws;
  stream.ws=null;
  stream.seeding=false;
  stream.bufferedEvents=[];
  clearStreamTimers();
  stream.state=markUserStreamDisconnected(stream.state,{at:Date.now(),reason});
  await publishRuntime().catch(()=>{});
  if(ws&&ws.readyState<2){
    try{ws.close(1000,'zenith-reconnect')}catch{}
  }
  if(reconnect)scheduleReconnect();
}

function streamStandardOrderByClientId(clientOrderId){
  const wanted=String(clientOrderId||'');
  return Object.values(stream.state?.standardOrders||{})
    .find(order=>String(order?.clientOrderId||'')===wanted)||null;
}
function streamAlgoOrderByClientId(clientAlgoId){
  const wanted=String(clientAlgoId||'');
  return Object.values(stream.state?.algoOrders||{})
    .find(order=>String(order?.clientAlgoId||'')===wanted)||null;
}
function terminalStandardStatus(status){
  return ['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(String(status||'').toUpperCase());
}
function terminalAlgoStatus(status){
  return ['CANCELED','TRIGGERED','FINISHED','REJECTED','EXPIRED'].includes(String(status||'').toUpperCase());
}

async function waitForStreamOrder({kind,clientId,terminal=false},timeoutMs=3000){
  const deadline=Date.now()+Math.max(300,n(timeoutMs,3000));
  let order=null;
  while(Date.now()<deadline){
    order=kind==='ALGO'?streamAlgoOrderByClientId(clientId):streamStandardOrderByClientId(clientId);
    if(order){
      const isTerminal=kind==='ALGO'?terminalAlgoStatus(order.status):terminalStandardStatus(order.status);
      if((terminal&&isTerminal)||(!terminal&&!isTerminal))return order;
    }
    await sleep(100);
  }
  return order;
}

function streamLongPosition(symbol){
  const wanted=String(symbol||'').toUpperCase();
  return (streamProjection().binancePositions||[]).find(position=>
    String(position?.symbol||'').toUpperCase()===wanted&&
    String(position?.positionSide||'BOTH').toUpperCase()==='BOTH'&&
    n(position?.positionAmt??position?.quantity,0)>0
  )||null;
}
async function waitForLongPosition(symbol,timeoutMs=5000){
  const deadline=Date.now()+Math.max(500,n(timeoutMs,5000));
  let position=null;
  while(Date.now()<deadline){
    position=streamLongPosition(symbol);
    if(position&&n(position?.entryPrice,0)>0)return position;
    await sleep(100);
  }
  return position;
}

async function callProtectiveExecute(body){
  return binanceApi('/api/binance-protective-execute',{method:'POST',body});
}
async function callProtectiveUpdateExecute(body){
  return binanceApi('/api/binance-protective-update-execute',{method:'POST',body});
}

function repairPriceFilters(){
  return Object.fromEntries([...autoProtection.priceFilters.entries()].map(([symbol,filter])=>[symbol,clone(filter)]));
}

async function markMaxLossRepairFailure(reason){
  const code=String(reason||'AUTO_MAX_LOSS_REPAIR_FAIL_CLOSED');
  runtime.error=code;
  stream.lastError=code;
  await invalidateStream(code).catch(()=>{});
  scheduleReconcile(1500);
  return code;
}
async function waitForWriteAheadEntryEvidence(target,timeoutMs=5000){
  const deadline=Date.now()+Math.max(500,n(timeoutMs,5000));
  let lastOrder=null;
  while(Date.now()<deadline){
    lastOrder=streamStandardOrderByClientId(target.entryClientOrderId);
    if(lastOrder){
      const status=String(lastOrder?.status||'').toUpperCase();
      if(['NEW','PARTIALLY_FILLED','FILLED'].includes(status))return {kind:'ORDER',order:lastOrder};
      if(['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status)){
        return {kind:'TERMINAL_UNSAFE',order:lastOrder};
      }
    }
    const position=streamLongPosition(target.symbol);
    if(position){
      const liveQty=Math.abs(n(position?.positionAmt??position?.quantity,0));
      if(realNumberMatches(liveQty,target.quantity))return {kind:'POSITION',position};
      return {kind:'POSITION_MISMATCH',position};
    }
    await sleep(100);
  }
  return lastOrder?{kind:'UNKNOWN_ORDER',order:lastOrder}:null;
}

async function recoverPendingEntryWriteAhead(report){
  const targets=pendingEntryWriteAheadRecoveryTargets(report);
  if(!targets.length)return {handled:false,recovered:false,count:0,reason:'NO_WRITEAHEAD_ENTRY_RECOVERY'};
  if(!runtime.synchronized||!runtime.heartbeatFresh||runtime.mode!=='RUNNING'||runtime.realExecutionArmed!==true){
    return {handled:true,recovered:false,count:0,reason:'ENTRY_WRITEAHEAD_RUNTIME_NOT_READY'};
  }

  let count=0;
  for(const target of targets){
    const config=watchedEntryConfig(target.symbol);
    if(!config||target.side!=='BUY'||target.direction!=='LONG'){
      return {handled:true,recovered:false,count,reason:'ENTRY_WRITEAHEAD_CONFIG_UNAVAILABLE'};
    }
    if(autoEntryCommandId(config)!==target.commandId||
       !realNumberMatches(config.maxLoss,target.maxLossUsd)){
      return {handled:true,recovered:false,count,reason:'ENTRY_WRITEAHEAD_CONFIG_MISMATCH'};
    }

    const submitted=await callEntryExecute({
      type:'EXEC_OPEN_POSITION',
      phase:'SUBMIT_ENTRY',
      commandId:target.commandId,
      symbol:target.symbol,
      side:target.side,
      orderType:'LIMIT',
      margin:config.margin,
      leverage:config.leverage,
      maxLoss:target.maxLossUsd,
      limitPrice:target.limitPrice,
    });
    if(!submitted.response.ok||submitted.data?.ok!==true){
      const reason='ENTRY_WRITEAHEAD_SUBMIT_'+String(
        submitted.data?.code||submitted.data?.reason||('HTTP_'+submitted.response.status)
      );
      entryWatch.lastError=reason;
      runtime.error=reason;
      scheduleReconcile(750);
      return {handled:true,recovered:false,count,reason};
    }

    const returnedId=String(submitted.data?.plan?.params?.newClientOrderId||'');
    if(returnedId!==target.entryClientOrderId){
      const reason='ENTRY_WRITEAHEAD_CLIENT_ID_MISMATCH';
      await invalidateStream(reason);
      return {handled:true,recovered:false,count,reason};
    }
    const returnedOrder=submitted.data?.result?.order||{};
    const returnedStatus=String(returnedOrder?.status||'').toUpperCase();
    if(['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(returnedStatus)){
      const reason='ENTRY_WRITEAHEAD_EXISTING_ORDER_TERMINAL_'+returnedStatus;
      await invalidateStream(reason);
      return {handled:true,recovered:false,count,reason};
    }

    const evidence=await waitForWriteAheadEntryEvidence(target,5000);
    if(!evidence||['TERMINAL_UNSAFE','POSITION_MISMATCH','UNKNOWN_ORDER'].includes(evidence.kind)){
      const reason='ENTRY_WRITEAHEAD_EVIDENCE_'+String(evidence?.kind||'MISSING');
      await invalidateStream(reason);
      return {handled:true,recovered:false,count,reason};
    }

    count++;
    log('ENTRY_WRITEAHEAD_RECOVERED',{
      symbol:target.symbol,
      commandId:target.commandId,
      entryClientOrderId:target.entryClientOrderId,
      protectionClientAlgoId:target.protectionClientAlgoId,
      limitPrice:target.limitPrice,
      quantity:target.quantity,
      evidence:evidence.kind,
      disposition:String(submitted.data?.result?.disposition||''),
    });
  }

  await publishRuntime();
  entryWatch.lastError='';
  runtime.error='';
  return {handled:true,recovered:true,count,reason:'ENTRY_WRITEAHEAD_RECOVERED'};
}

async function cancelPendingEntriesMissingPreparedProtection(report){
  const targets=pendingEntryProtectionLossTargets(report);
  if(!targets.length)return {handled:false,canceled:0,filledRace:false,reason:'NO_PENDING_ENTRY_PROTECTION_LOSS'};

  let canceled=0;
  let filledRace=false;
  for(const target of targets){
    const body={
      type:'EXEC_CANCEL_ENTRY',
      commandId:target.commandId,
      symbol:target.symbol,
      clientOrderId:target.entryClientOrderId,
    };
    const result=await callProtectiveExecute(body);
    if(!result.response.ok||result.data?.ok!==true){
      const reason='ENTRY_PROTECTION_LOSS_CANCEL_'+String(
        result.data?.code||result.data?.reason||result.data?.error||('HTTP_'+result.response.status)
      );
      entryWatch.lastError=reason;
      runtime.error=reason;
      scheduleReconcile(500);
      return {handled:true,canceled,filledRace,reason};
    }

    const disposition=String(result.data?.result?.disposition||'').toUpperCase();
    const status=String(result.data?.result?.order?.status||'').toUpperCase();
    if(disposition==='ALREADY_FILLED'||status==='FILLED'){
      // Race: the LIMIT filled before cancellation won. Never close the position here.
      // The next reconciliation hands the live position to the normal MAX-LOSS repair path.
      filledRace=true;
      log('ENTRY_PROTECTION_LOSS_FILL_RACE',{
        symbol:target.symbol,
        commandId:target.commandId,
        clientOrderId:target.entryClientOrderId,
      });
      continue;
    }

    let terminalStatus=status;
    if(!['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(terminalStatus)){
      const terminal=await waitForStreamOrder({
        kind:'STANDARD',clientId:target.entryClientOrderId,terminal:true,
      },3000);
      terminalStatus=String(terminal?.status||terminalStatus||'').toUpperCase();
    }
    if(!['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(terminalStatus)){
      const reason='ENTRY_PROTECTION_LOSS_CANCEL_NOT_CONFIRMED';
      entryWatch.lastError=reason;
      runtime.error=reason;
      scheduleReconcile(500);
      return {handled:true,canceled,filledRace,reason};
    }
    canceled++;
    const watchState=entryWatch.states.get(target.symbol);
    if(watchState){
      watchState.triggeredAt=0;
      watchState.pendingUntil=0;
      watchState.blockedAt=Date.now();
      entryWatch.states.set(target.symbol,watchState);
    }
    log('ENTRY_CANCELED_AFTER_MAXLOSS_LOSS',{
      symbol:target.symbol,
      commandId:target.commandId,
      clientOrderId:target.entryClientOrderId,
      terminalStatus,
    });
  }

  if(canceled>0)await persistEntryWatchStateNow().catch(()=>false);
  await publishRuntime().catch(()=>{});
  entryWatch.lastError='';
  return {
    handled:true,
    canceled,
    filledRace,
    reason:filledRace?'ENTRY_FILL_RACE_RECONCILE':'ENTRY_CANCELLED_AFTER_MAXLOSS_LOSS',
  };
}

async function repairMissingMaxLoss(report){
  const exactTarget=missingMaxLossRepairTarget(report);
  if(!exactTarget)return {handled:false,repaired:false,reason:'NO_EXACT_REPAIR_TARGET'};

  const symbol=String(exactTarget.split(':')[0]||'').toUpperCase();
  const reasons=Array.isArray(report?.reasons)?report.reasons.map(x=>String(x||'')):[];
  if(reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION')){
    await ensurePriceFilter(symbol).catch(()=>null);
  }

  const projection=streamProjection();
  const plan=buildMaxLossRepairPlan({
    report,
    positions:Array.isArray(projection.binancePositions)?projection.binancePositions:[],
    tokenSettings:runtime.config?.tokenSettings||{},
    settings:runtime.config?.settings||{},
    priceFilters:repairPriceFilters(),
  });

  if(plan.action==='NONE')return {handled:false,repaired:false,reason:plan.reason};

  if(plan.action!=='REPAIR'){
    const reason=await markMaxLossRepairFailure(
      'AUTO_MAX_LOSS_REPAIR_'+String(plan.reason||'BLOCKED')
    );
    return {handled:true,repaired:false,reason};
  }

  const body={
    type:'EXEC_UPDATE_PROTECTION',
    commandId:`auto-maxloss-repair-${plan.symbol}-${plan.direction}-${plan.lifecycleAt||0}`,
    symbol:plan.symbol,
    direction:plan.direction,
    quantity:plan.quantity,
    triggerPrice:plan.triggerPrice,
    protectionKind:'MAX_LOSS',
    phase:'PLACE_NEW',
  };

  const placed=await callProtectiveUpdateExecute(body);
  if(!placed.response.ok||placed.data?.ok!==true){
    const reason='AUTO_MAX_LOSS_REPAIR_PLACE_'+String(
      placed.data?.code||placed.data?.reason||placed.data?.error||('HTTP_'+placed.response.status)
    );
    await markMaxLossRepairFailure(reason);
    return {handled:true,repaired:false,reason};
  }

  const clientId=String(
    placed.data?.plan?.params?.clientAlgoId||
    placed.data?.plan?.params?.newClientOrderId||
    ''
  );
  if(!clientId){
    const reason='AUTO_MAX_LOSS_REPAIR_CLIENT_ID_MISSING';
    await markMaxLossRepairFailure(reason);
    return {handled:true,repaired:false,reason};
  }

  const order=await waitForStreamOrder({kind:'ALGO',clientId,terminal:false},3500);
  const expectedSide=plan.direction==='LONG'?'SELL':'BUY';
  const valid=Boolean(
    order&&
    String(order?.symbol||'').toUpperCase()===plan.symbol&&
    String(order?.side||'').toUpperCase()===expectedSide&&
    String(order?.positionSide||'BOTH').toUpperCase()==='BOTH'&&
    String(order?.type||'').toUpperCase()==='STOP'&&
    String(order?.timeInForce||'').toUpperCase()==='IOC'&&
    (order?.reduceOnly===true||order?.reduceOnly==='true')&&
    !(order?.closePosition===true||order?.closePosition==='true')&&
    realNumberMatches(order?.origQty??order?.quantity,plan.quantity)&&
    String(order?.priceMatch||'').toUpperCase()==='OPPONENT'&&
    realNumberMatches(order?.triggerPrice??order?.stopPrice,plan.triggerPrice)&&
    /^zth-MAX-[A-Za-z0-9._:-]+$/.test(String(order?.clientAlgoId||clientId))
  );
  if(!valid){
    const reason='AUTO_MAX_LOSS_REPAIR_NOT_STREAM_CONFIRMED';
    await markMaxLossRepairFailure(reason);
    return {handled:true,repaired:false,reason};
  }

  await publishRuntime();
  log('AUTO_MAX_LOSS_REPAIRED',{
    symbol:plan.symbol,
    direction:plan.direction,
    maxLossUsd:plan.maxLossUsd,
    triggerPrice:plan.triggerPrice,
  });
  runtime.error='';
  stream.lastError='';
  return {handled:true,repaired:true,reason:'AUTO_MAX_LOSS_REPAIRED'};
}

function authorizedMaxLossOverlapReport(report){
  if(!report||report.version!==2||report.status!=='MISMATCH'||report.failClosed!==true)return null;
  const reasons=Array.isArray(report.reasons)?report.reasons.map(x=>String(x||'')):[];
  if(reasons.length!==1||reasons[0]!=='AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION')return null;
  const diff=report.differences&&typeof report.differences==='object'?report.differences:{};
  const edits=Array.isArray(diff.authorizedPendingMaxLossEdits)?diff.authorizedPendingMaxLossEdits.filter(Boolean):[];
  if(edits.length!==1)return null;
  const edit=edits[0];
  const target=`${String(edit.symbol||'').toUpperCase()}:${String(edit.direction||'').toUpperCase()}`;
  const ambiguous=Array.isArray(diff.ambiguousMaxLossProtections)
    ?diff.ambiguousMaxLossProtections.map(x=>String(x||'').toUpperCase()).filter(Boolean):[];
  if(ambiguous.length!==1||ambiguous[0]!==target)return null;
  if((Array.isArray(diff.missingMaxLossProtections)&&diff.missingMaxLossProtections.length)||
     (Array.isArray(diff.unsafeMaxLossProtections)&&diff.unsafeMaxLossProtections.length)||
     (Array.isArray(diff.configuredMaxLossUnavailable)&&diff.configuredMaxLossUnavailable.length))return null;
  if(!String(edit.commandId||'')||!String(edit.previousClientAlgoId||'')||!String(edit.newClientAlgoId||''))return null;
  return edit;
}


async function recoverTriggeredMaxLossRemainder(report){
  const targets=triggeredMaxLossRemainderTargets(report);
  if(!targets.length)return {handled:false,dispatched:false,reason:'NO_TRIGGERED_MAX_LOSS_REMAINDER'};
  if(maxLossRemainderRecovery.busy)return {handled:true,dispatched:false,reason:'MAX_LOSS_REMAINDER_RECOVERY_BUSY'};
  const target=targets[0];
  maxLossRemainderRecovery.busy=true;
  try{
    const result=await callProtectiveExecute({
      type:'EXEC_CLOSE_POSITION',
      commandId:target.recoveryCommandId,
      symbol:target.symbol,
      direction:target.direction,
      quantity:target.remainingQuantity,
      closeAll:true,
      exitMode:'PROTECTIVE_IOC',
      attempt:target.nextAttempt,
      priceMatch:target.priceMatch,
      recoveryReason:'TRIGGERED_MAX_LOSS_REMAINDER',
    });
    if(!result.response.ok||result.data?.ok!==true){
      const reason=String(result.data?.code||result.data?.reason||result.data?.error||('HTTP_'+result.response.status));
      const ambiguous=result.data?.ambiguous===true||result.data?.result?.ambiguous===true;
      const wrote=result.data?.writeAttempted===true;
      maxLossRemainderRecovery.lastError='MAX_LOSS_REMAINDER_'+reason;
      runtime.error=maxLossRemainderRecovery.lastError;
      stream.lastError=maxLossRemainderRecovery.lastError;
      await publishRuntime().catch(()=>{});
      scheduleReconcile(ambiguous||wrote?100:500);
      return {
        handled:true,dispatched:false,reason:maxLossRemainderRecovery.lastError,
        ambiguous,wrote,
      };
    }
    const clientOrderId=String(result.data?.plan?.params?.newClientOrderId||'');
    if(!clientOrderId){
      maxLossRemainderRecovery.lastError='MAX_LOSS_REMAINDER_CLIENT_ORDER_ID_MISSING';
      runtime.error=maxLossRemainderRecovery.lastError;
      stream.lastError=maxLossRemainderRecovery.lastError;
      await publishRuntime().catch(()=>{});
      scheduleReconcile(100);
      return {handled:true,dispatched:false,reason:maxLossRemainderRecovery.lastError};
    }
    log('MAX_LOSS_REMAINDER_IOC_DISPATCHED',{
      symbol:target.symbol,
      direction:target.direction,
      remainingQuantity:target.remainingQuantity,
      attempt:target.nextAttempt,
      priceMatch:target.priceMatch,
      clientAlgoId:target.clientAlgoId,
      actualOrderId:target.actualOrderId,
      clientOrderId,
    });
    maxLossRemainderRecovery.lastError='';
    return {handled:true,dispatched:true,reason:'MAX_LOSS_REMAINDER_IOC_DISPATCHED',clientOrderId};
  }finally{
    maxLossRemainderRecovery.busy=false;
  }
}

async function reconcile(secondPass=false){
  if(stream.reconcileBusy||!runtime.leaseActive)return false;
  const ws=stream.ws;
  if(!ws||ws.readyState!==WebSocket.OPEN)return false;
  stream.reconcileBusy=true;
  try{
    const {response,data}=await binanceApi('/api/binance-reconcile',{method:'POST',body:{}});
    if(!response.ok||data?.ok!==true||!data?.report){
      const reason=String(data?.code||('HTTP_'+response.status));
      await invalidateStream('BINANCE_RECONCILIATION_'+reason);
      return false;
    }

    const pendingProtectionLoss=pendingEntryProtectionLossTargets(data.report);
    if(pendingProtectionLoss.length){
      if(secondPass){
        await invalidateStream('ENTRY_PROTECTION_LOSS_CANCEL_RECONCILIATION_FAILED');
        return false;
      }
      const recovered=await cancelPendingEntriesMissingPreparedProtection(data.report);
      if(!recovered.handled)return false;
      stream.reconcileBusy=false;
      await sleep(100);
      return reconcile(true);
    }

    const writeAheadRecovery=pendingEntryWriteAheadRecoveryTargets(data.report);
    if(writeAheadRecovery.length){
      if(secondPass){
        await invalidateStream('ENTRY_WRITEAHEAD_RECOVERY_RECONCILIATION_FAILED');
        return false;
      }
      const recovered=await recoverPendingEntryWriteAhead(data.report);
      if(!recovered.handled||!recovered.recovered)return false;
      stream.reconcileBusy=false;
      await sleep(150);
      return reconcile(true);
    }

    const maxLossOverlap=authorizedMaxLossOverlapReport(data.report);
    if(maxLossOverlap){
      if(stream.state?.needsReconciliation===true){
        stream.state=markUserStreamReconciled(stream.state,{
          observedAt:Number(data.report.observedAt||Date.now()),
          runtimeHash:String(data.report.runtimeDataHash||data.report.runtimeHash||''),
        });
        stream.lastError='MAX_LOSS_REPLACEMENT_IN_PROGRESS';
        runtime.error='MAX_LOSS_REPLACEMENT_IN_PROGRESS';
        await publishRuntime();
        stream.reconcileBusy=false;
        await sleep(50);
        return reconcile(true);
      }
      stream.lastError='MAX_LOSS_REPLACEMENT_IN_PROGRESS';
      runtime.error='MAX_LOSS_REPLACEMENT_IN_PROGRESS';
      return userStreamReady(stream.state);
    }

    const triggeredRemainders=triggeredMaxLossRemainderTargets(data.report);
    if(triggeredRemainders.length){
      const recovered=await recoverTriggeredMaxLossRemainder(data.report);
      if(!recovered.handled||!recovered.dispatched){
        const reason=String(recovered.reason||'MAX_LOSS_REMAINDER_RECOVERY_FAILED');
        runtime.error=reason;
        stream.lastError=reason;
        await publishRuntime().catch(()=>{});
        return false;
      }
      stream.reconcileBusy=false;
      await sleep(300);
      return reconcile(false);
    }

    const reportReasons=Array.isArray(data.report?.reasons)?data.report.reasons.map(x=>String(x||'')):[];
    if(reportReasons.includes('TRIGGERED_MAX_LOSS_RECOVERY_PENDING')){
      runtime.error='TRIGGERED_MAX_LOSS_RECOVERY_PENDING';
      stream.lastError='TRIGGERED_MAX_LOSS_RECOVERY_PENDING';
      await publishRuntime().catch(()=>{});
      stream.reconcileBusy=false;
      scheduleReconcile(250);
      return false;
    }
    if(reportReasons.some(reason=>[
      'AMBIGUOUS_TRIGGERED_MAX_LOSS_REMAINDER',
      'INCONSISTENT_TRIGGERED_MAX_LOSS_RESULT',
      'TRIGGERED_MAX_LOSS_RECOVERY_EXHAUSTED',
    ].includes(reason))){
      const reason=reportReasons.find(value=>[
        'AMBIGUOUS_TRIGGERED_MAX_LOSS_REMAINDER',
        'INCONSISTENT_TRIGGERED_MAX_LOSS_RESULT',
        'TRIGGERED_MAX_LOSS_RECOVERY_EXHAUSTED',
      ].includes(value))||'MAX_LOSS_REMAINDER_FAIL_CLOSED';
      runtime.error=reason;
      stream.lastError=reason;
      await publishRuntime().catch(()=>{});
      return false;
    }

    const orphanTargets=orphanZenithCleanupOrders(data.report);
    if(orphanTargets.length){
      if(secondPass){
        await invalidateStream('ORPHAN_CLEANUP_RECONCILIATION_FAILED');
        return false;
      }
      for(const target of orphanTargets){
        const body={
          type:'EXEC_CLEAN_ORPHAN_PROTECTION',
          phase:'CANCEL_ORPHAN',
          symbol:target.symbol,
          orderClass:target.orderClass,
          ...(target.orderClass==='ALGO'
            ?{clientAlgoId:target.clientAlgoId}
            :{clientOrderId:target.clientOrderId}),
        };
        const cleaned=await callProtectiveUpdateExecute(body);
        if(!cleaned.response.ok||cleaned.data?.ok!==true){
          const reason='ORPHAN_CLEANUP_'+String(cleaned.data?.code||('HTTP_'+cleaned.response.status));
          await invalidateStream(reason);
          return false;
        }
        const clientId=target.orderClass==='ALGO'?target.clientAlgoId:target.clientOrderId;
        const order=await waitForStreamOrder({
          kind:target.orderClass==='ALGO'?'ALGO':'STANDARD',
          clientId,
          terminal:true,
        },3000);
        const status=String(order?.status||'').toUpperCase();
        const safe=target.orderClass==='ALGO'
          ?['CANCELED','EXPIRED','REJECTED'].includes(status)
          :['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status);
        if(!safe){
          await invalidateStream('ORPHAN_CLEANUP_STREAM_NOT_CONFIRMED');
          return false;
        }
      }
      await publishRuntime();
      stream.reconcileBusy=false;
      return reconcile(true);
    }

    const repairTarget=missingMaxLossRepairTarget(data.report);
    if(repairTarget){
      if(secondPass){
        await markMaxLossRepairFailure('AUTO_MAX_LOSS_REPAIR_RECONCILIATION_FAILED');
        return false;
      }
      const repair=await repairMissingMaxLoss(data.report);
      if(repair.handled){
        if(!repair.repaired)return false;
        stream.reconcileBusy=false;
        return reconcile(true);
      }
    }

    const acceptable=data.report.failClosed===false||Boolean(repairTarget);
    if(!acceptable){
      const reason=String(data.report?.reasons?.[0]||'BINANCE_RECONCILIATION_MISMATCH');
      await invalidateStream('BINANCE_RECONCILIATION_'+reason);
      return false;
    }

    if(stream.state?.needsReconciliation===true){
      stream.state=markUserStreamReconciled(stream.state,{
        observedAt:Number(data.report.observedAt||Date.now()),
        runtimeHash:String(data.report.runtimeDataHash||data.report.runtimeHash||''),
      });
      stream.lastError=repairTarget?'PROTECTION_REPAIR_REQUIRED':'';
      await publishRuntime();
      if(!secondPass){
        stream.reconcileBusy=false;
        return reconcile(true);
      }
    }
    const targetResult=await ensureAutomaticTargets();
    if(targetResult?.ok!==true)return false;
    if(targetResult?.changed===true){
      stream.reconcileBusy=false;
      await sleep(100);
      return reconcile(true);
    }

    runtime.error=repairTarget?'PROTECTION_REPAIR_REQUIRED':'';
    await pruneAutoHighWater().catch(()=>{});
    return userStreamReady(stream.state);
  }catch(error){
    stream.lastError=String(error?.message||'BINANCE_RECONCILIATION_FAILED');
    await invalidateStream(stream.lastError);
    return false;
  }finally{
    stream.reconcileBusy=false;
  }
}

async function awaitReconciliation(timeoutMs=5000){
  const deadline=Date.now()+Math.max(500,n(timeoutMs,5000));
  while(stream.reconcileBusy&&Date.now()<deadline)await sleep(50);
  if(stream.reconcileBusy){
    stream.lastError='RECONCILIATION_BUSY_TIMEOUT';
    return false;
  }
  return reconcile();
}

function scheduleReconcile(delay=250){
  if(stream.reconcileTimer)clearTimeout(stream.reconcileTimer);
  stream.reconcileTimer=setTimeout(()=>{
    stream.reconcileTimer=null;
    reconcile().catch(error=>logError('RECONCILIATION_FAILED',error));
  },Math.max(50,delay));
}

async function processStreamPayload(payload){
  const result=applyUserDataEvent(stream.state,payload);
  stream.state=result.state;
  if([
    'LISTEN_KEY_EXPIRED',
    'STREAM_EVENT_OUT_OF_ORDER',
    'ORDER_EVENT_IDENTITY_INVALID',
    'ALGO_EVENT_IDENTITY_INVALID',
  ].includes(String(result.reason||''))){
    throw new Error(result.reason);
  }
  if(result.applied===true&&['ORDER','ACCOUNT','ALGO'].includes(String(result.kind||''))){
    stream.state=markUserStreamNeedsReconciliation(stream.state,'STREAM_INVENTORY_CHANGED');
    await publishRuntime().catch(()=>{});
    scheduleReconcile(200);
  }
  return result;
}

async function seedStream(connectionId,connectedAt){
  const {response,data}=await binanceApi('/api/binance-runtime-snapshot');
  if(!response.ok||data?.ok!==true||!data?.snapshot){
    throw new Error(data?.code||('HTTP_'+response.status));
  }
  const snapshot=data.snapshot;
  rememberPriceFilters(snapshot);
  stream.state=seedUserStreamStateFromRuntimeSnapshot(snapshot,{connectionId,connectedAt});
  const cutoff=n(snapshot.serverTime,0);
  const buffered=stream.bufferedEvents.splice(0)
    .sort((a,b)=>n(a?.E,n(a?.T,0))-n(b?.E,n(b?.T,0)));
  for(const payload of buffered){
    const eventTime=n(payload?.E,n(payload?.T,0));
    if(cutoff>0&&eventTime>0&&eventTime<cutoff)continue;
    await processStreamPayload(payload);
  }
  stream.seeding=false;
  await publishRuntime();
}

async function streamKeepalive(){
  if(!runtime.leaseActive)return;
  try{
    const {response,data}=await userStreamApi('keepalive','POST');
    if(!response.ok||data?.ok!==true)throw new Error(data?.code||('HTTP_'+response.status));
    if(data.listenKeyChanged===true)await closeLocalStream('LISTEN_KEY_ROTATED',true);
  }catch(error){
    stream.lastError=String(error?.message||'USER_STREAM_KEEPALIVE_FAILED');
    await closeLocalStream(stream.lastError,true);
  }
}

async function ensureUserStream(){
  if(stopping||!runtime.leaseActive)return false;
  if(stream.starting)return false;
  if(stream.ws&&(stream.ws.readyState===WebSocket.OPEN||stream.ws.readyState===WebSocket.CONNECTING))return true;
  if(typeof WebSocket!=='function')throw new Error('NODE_WEBSOCKET_UNAVAILABLE');

  stream.starting=true;
  try{
    const {response,data}=await userStreamApi('start','POST');
    if(!response.ok||data?.ok!==true||!data?.listenKey){
      throw new Error(data?.code||('HTTP_'+response.status));
    }
    const listenKey=String(data.listenKey);
    const generation=++stream.generation;
    const socket=new WebSocket('wss://fstream.binance.com/private/ws?listenKey='+encodeURIComponent(listenKey)+'&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/ALGO_UPDATE/listenKeyExpired');
    stream.ws=socket;

    socket.addEventListener('open',async()=>{
      if(stream.ws!==socket||generation!==stream.generation)return;
      const connectedAt=Date.now();
      const connectionId='engine-ws-'+generation+'-'+connectedAt;
      stream.state=markUserStreamConnected(stream.state,{connectionId,at:connectedAt});
      stream.seeding=true;
      stream.bufferedEvents=[];
      stream.lastError='';
      clearStreamTimers();
      stream.keepaliveTimer=setInterval(()=>streamKeepalive().catch(error=>logError('STREAM_KEEPALIVE_FAILED',error)),KEEPALIVE_MS);
      stream.restartTimer=setTimeout(()=>closeLocalStream('SCHEDULED_23H_RECONNECT',true),STREAM_RESTART_MS);
      stream.reconcileInterval=setInterval(()=>reconcile().catch(error=>logError('RECONCILIATION_FAILED',error)),RECONCILE_MS);
      await publishRuntime().catch(()=>{});
      try{
        await seedStream(connectionId,connectedAt);
        scheduleReconcile(100);
      }catch(error){
        stream.seeding=false;
        stream.lastError=String(error?.message||'RUNTIME_SEED_FAILED');
        await closeLocalStream(stream.lastError,true);
      }
    });

    socket.addEventListener('message',async event=>{
      if(stream.ws!==socket||generation!==stream.generation)return;
      let payload=null;
      try{
        let raw=event.data;
        if(raw instanceof ArrayBuffer)raw=Buffer.from(raw).toString('utf8');
        else if(ArrayBuffer.isView(raw))raw=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength).toString('utf8');
        else raw=String(raw);
        payload=JSON.parse(raw);
      }catch{
        await invalidateStream('STREAM_EVENT_INVALID_JSON');
        return;
      }
      if(stream.seeding){
        if(stream.bufferedEvents.length>=1000){
          stream.lastError='STREAM_SEED_BUFFER_OVERFLOW';
          await closeLocalStream(stream.lastError,true);
          return;
        }
        stream.bufferedEvents.push(payload);
        return;
      }
      try{
        await processStreamPayload(payload);
      }catch(error){
        stream.lastError=String(error?.message||'STREAM_EVENT_INVALID');
        await publishRuntime().catch(()=>{});
        await closeLocalStream(stream.lastError,true);
      }
    });

    socket.addEventListener('error',()=>{
      stream.lastError='STREAM_SOCKET_ERROR';
    });

    socket.addEventListener('close',async()=>{
      if(stream.ws!==socket)return;
      stream.ws=null;
      await closeLocalStream(stream.lastError||'STREAM_DISCONNECTED',true);
    });
    return true;
  }catch(error){
    stream.lastError=String(error?.message||'USER_STREAM_START_FAILED');
    await invalidateStream(stream.lastError);
    scheduleReconnect(3000);
    return false;
  }finally{
    stream.starting=false;
  }
}

async function commandDisposition(action,raw,extra={}){
  return syncApi(action,{method:'POST',body:{raw,...extra}});
}
async function requeueCommand(raw,reason,delayMs=1500){
  const result=await commandDisposition('command-requeue',raw,{
    deferMs:Math.max(250,Math.min(30000,n(delayMs,1500))),
    deferReason:String(reason||'MASTER_EXECUTION_RETRY').slice(0,120),
  });
  if(!result.response.ok||result.data?.ok!==true)throw new Error(result.data?.code||('HTTP_'+result.response.status));
  return result.data;
}
async function failCommand(raw,reason){
  const result=await commandDisposition('command-fail',raw,{reason:cleanReason(reason,'EXECUTION_FAILED')});
  if(!result.response.ok||result.data?.ok!==true)throw new Error(result.data?.code||('HTTP_'+result.response.status));
  return result.data;
}
async function ackCommand(raw,executionProof){
  const result=await commandDisposition('command-ack',raw,{executionProof});
  if(!result.response.ok||result.data?.ok!==true)throw new Error(result.data?.code||('HTTP_'+result.response.status));
  return result.data;
}

async function safeAckAfterReconcile(raw,executionProof,failureReason='EXECUTION_ACK_FAILED'){
  try{
    const reconciled=await awaitReconciliation();
    if(reconciled!==true||userStreamReady(stream.state)!==true)throw new Error('RECONCILIATION_NOT_READY');
    await ackCommand(raw,executionProof);
    return true;
  }catch(error){
    const reason=failureReason+'_'+String(error?.message||'RECONCILE');
    await failCommand(raw,reason);
    execution.lastError=reason;
    return false;
  }
}

async function safeAckActiveMaxLossAfterReconcile(raw,executionProof,body){
  try{
    const reconciled=await awaitReconciliation();
    if(reconciled!==true||userStreamReady(stream.state)!==true)throw new Error('RECONCILIATION_NOT_READY');
  }catch(error){
    const reason='EXEC_MAX_LOSS_UPDATE_ACK_RETRY_'+String(error?.message||'RECONCILE');
    await failCommand(raw,reason);
    execution.lastError=reason;
    return false;
  }

  let ack;
  try{
    ack=await ackCommand(raw,executionProof);
  }catch(error){
    const reason='EXEC_MAX_LOSS_UPDATE_ACK_RETRY_'+String(error?.message||'ACK');
    await failCommand(raw,reason);
    execution.lastError=reason;
    return false;
  }

  if(ack?.activeMaxLossCommitted!==true){
    runtime.synchronized=false;
    runtime.error='ACTIVE_MAX_LOSS_ACK_CONFIG_NOT_COMMITTED';
    await publishRuntime().catch(()=>{});
    return false;
  }

  const symbol=String(ack.symbol||body?.symbol||'').toUpperCase();
  const maxLossUsd=n(ack.maxLossUsd,NaN);
  const revision=Math.max(0,n(ack.controllerRevision,0));
  const expectedHash=String(ack.controllerStateHash||'');
  if(!runtime.config||!symbol||!(maxLossUsd>=2&&maxLossUsd<=REAL_RISK_LIMITS.maxLossUsd)||
     !(revision>0)||!expectedHash){
    runtime.synchronized=false;
    runtime.error='ACTIVE_MAX_LOSS_ACK_CONFIG_INVALID';
    await publishRuntime().catch(()=>{});
    return false;
  }

  const tokenSettings=runtime.config.tokenSettings&&typeof runtime.config.tokenSettings==='object'
    ?runtime.config.tokenSettings:{};
  const current=tokenSettings[symbol]&&typeof tokenSettings[symbol]==='object'?tokenSettings[symbol]:{};
  runtime.config={
    ...runtime.config,
    tokenSettings:{
      ...tokenSettings,
      [symbol]:{...current,maxLoss:maxLossUsd,marginType:'ISOLATED'},
    },
  };
  const localHash=sha256Hex(stableStringify(runtime.config));
  runtime.controllerRevision=revision;
  runtime.appliedRevision=revision;
  runtime.synchronized=localHash===expectedHash;
  runtime.error=runtime.synchronized?'':'ACTIVE_MAX_LOSS_ACK_HASH_MISMATCH';
  await publishRuntime().catch(()=>{});
  return runtime.synchronized;
}

async function applyPendingProtectionTableBeforeConfigCommit(raw,body){
  const symbol=String(body?.symbol||'').toUpperCase();
  const direction=String(body?.direction||'').toUpperCase();
  const quantity=Math.abs(n(body?.quantity,0));
  const stages=body?.activeConfig?.protectionStages;
  if(!symbol||!['LONG','SHORT'].includes(direction)||!(quantity>0)||!validActiveProtectionStages(stages)){
    await failCommand(raw,'ACTIVE_PROTECTION_CONFIG_INVALID');
    execution.lastError='ACTIVE_PROTECTION_CONFIG_INVALID';
    return false;
  }
  if(!autoProtection.highWaterLoaded){
    const loaded=await loadAutoHighWater();
    if(!loaded){
      await requeueCommand(raw,'ACTIVE_PROTECTION_HIGH_WATER_UNAVAILABLE',1500);
      return false;
    }
  }

  const projection=streamProjection();
  const position=(projection.binancePositions||[]).find(row=>{
    const amount=n(row?.positionAmt??row?.quantity,0);
    const rowDirection=amount>=0?'LONG':'SHORT';
    return String(row?.symbol||'').toUpperCase()===symbol&&
      rowDirection===direction&&Math.abs(Math.abs(amount)-quantity)<=1e-12;
  })||null;
  if(!position){
    await failCommand(raw,'ACTIVE_PROTECTION_POSITION_CHANGED');
    execution.lastError='ACTIVE_PROTECTION_POSITION_CHANGED';
    return false;
  }

  const account=await binanceApi('/api/binance-read');
  if(!account.response.ok||account.data?.ok!==true){
    const reason='ACTIVE_PROTECTION_MARK_'+String(account.data?.code||('HTTP_'+account.response.status));
    if(account.response.status===429){
      await requeueCommand(raw,reason,1500);
    }else{
      await failCommand(raw,reason);
      execution.lastError=reason;
    }
    return false;
  }
  const restPosition=(Array.isArray(account.data?.positions)?account.data.positions:[]).find(row=>{
    const amount=n(row?.positionAmt??row?.quantity,0);
    const rowDirection=amount>=0?'LONG':'SHORT';
    return String(row?.symbol||'').toUpperCase()===symbol&&rowDirection===direction&&Math.abs(amount)>0;
  })||null;
  const mark=n(restPosition?.markPrice,0);
  const restQty=Math.abs(n(restPosition?.positionAmt??restPosition?.quantity,0));
  if(!(mark>0)||!restPosition||Math.abs(restQty-quantity)>1e-12){
    await failCommand(raw,'ACTIVE_PROTECTION_MARK_POSITION_MISMATCH');
    execution.lastError='ACTIVE_PROTECTION_MARK_POSITION_MISMATCH';
    return false;
  }

  const highWater=observeAutoHighWater(position,mark);
  if(!Number.isFinite(highWater)||!(await persistAutoHighWaterNow())){
    await requeueCommand(raw,'ACTIVE_PROTECTION_HIGH_WATER_NOT_PERSISTED',1500);
    return false;
  }

  const priceFilter=await ensurePriceFilter(symbol);
  if(!priceFilter){
    await requeueCommand(raw,'ACTIVE_PROTECTION_PRICE_FILTER_UNAVAILABLE',1500);
    return false;
  }

  let plan;
  try{
    plan=evaluateMasterAutoProgressiveProtection({
      position,
      markPrice:mark,
      protectionStages:stages,
      currentOrders:Array.isArray(projection.binanceOrders)?projection.binanceOrders:[],
      priceFilter,
      previousHighWaterProfitUsd:highWater,
    });
  }catch(error){
    const reason='ACTIVE_PROTECTION_PLAN_'+cleanReason(error?.message||'FAILED','FAILED');
    await failCommand(raw,reason);
    execution.lastError=reason;
    return false;
  }

  if(plan.action==='BLOCK'){
    const reason='ACTIVE_PROTECTION_BLOCKED_'+cleanReason(plan.reason||'BLOCKED','BLOCKED');
    await failCommand(raw,reason);
    execution.lastError=reason;
    return false;
  }
  if(plan.action==='REPLACE'){
    const changed=await executeAutoProgressive(plan);
    if(changed!==true){
      const reason='ACTIVE_PROTECTION_REPLACEMENT_NOT_CONFIRMED';
      await failCommand(raw,reason);
      execution.lastError=reason;
      return false;
    }
  }
  return true;
}

async function safeAckActiveConfigAfterReconcile(raw,executionProof,body,failurePrefix='EXEC_ACTIVE_CONFIG_ACK_RETRY'){
  try{
    const reconciled=await awaitReconciliation();
    if(reconciled!==true||userStreamReady(stream.state)!==true)throw new Error('RECONCILIATION_NOT_READY');
  }catch(error){
    const reason=failurePrefix+'_'+String(error?.message||'RECONCILE');
    await failCommand(raw,reason);
    execution.lastError=reason;
    return false;
  }

  let ack;
  try{
    ack=await ackCommand(raw,executionProof);
  }catch(error){
    const reason=failurePrefix+'_'+String(error?.message||'ACK');
    await failCommand(raw,reason);
    execution.lastError=reason;
    return false;
  }

  const activeConfig=ack?.activeConfig;
  const symbol=String(ack?.symbol||body?.symbol||'').toUpperCase();
  const revision=Math.max(0,n(ack?.controllerRevision,0));
  const expectedHash=String(ack?.controllerStateHash||'');
  if(ack?.activeConfigCommitted!==true||!runtime.config||!symbol||!(revision>0)||!expectedHash||
     !activeConfig||typeof activeConfig!=='object'||Array.isArray(activeConfig)){
    runtime.synchronized=false;
    runtime.error='ACTIVE_CONFIG_ACK_INVALID';
    await publishRuntime().catch(()=>{});
    return false;
  }

  const target=n(activeConfig.targetProfit,NaN);
  const manual=n(activeConfig.manualTargetProfit,NaN);
  const exactEnabled=activeConfig.exactSaleEnabled===true;
  const exactPrice=n(activeConfig.exactSalePrice,0);
  if(!(target>0)||!(manual>0)||Math.abs(target-manual)>1e-8||
     (exactEnabled&&!(exactPrice>0))||!(exactPrice>=0)||
     String(activeConfig.exactSaleSource||'')!=='settings'||
     !validActiveProtectionStages(activeConfig.protectionStages)){
    runtime.synchronized=false;
    runtime.error='ACTIVE_CONFIG_ACK_PAYLOAD_INVALID';
    await publishRuntime().catch(()=>{});
    return false;
  }

  const tokenSettings=runtime.config.tokenSettings&&typeof runtime.config.tokenSettings==='object'
    ?runtime.config.tokenSettings:{};
  const current=tokenSettings[symbol]&&typeof tokenSettings[symbol]==='object'?tokenSettings[symbol]:{};
  runtime.config={
    ...runtime.config,
    tokenSettings:{
      ...tokenSettings,
      [symbol]:{...current,...activeConfig,marginType:'ISOLATED'},
    },
  };
  const localHash=sha256Hex(stableStringify(runtime.config));
  runtime.controllerRevision=revision;
  runtime.appliedRevision=revision;
  runtime.synchronized=localHash===expectedHash;
  runtime.error=runtime.synchronized?'':'ACTIVE_CONFIG_ACK_HASH_MISMATCH';
  await publishRuntime().catch(()=>{});
  return runtime.synchronized;
}

async function runActiveConfigCommand(command,raw,dispatch){
  if(!(await applyPendingProtectionTableBeforeConfigCommit(raw,dispatch.body)))return false;
  return safeAckActiveConfigAfterReconcile(
    raw,{activeConfigReady:true},dispatch.body,'EXEC_ACTIVE_PROTECTIONS_CONFIG_ACK_RETRY'
  );
}

async function handleMutationFailure(raw,response,data,prefix){
  const reason=String(data?.code||data?.reason||data?.error||('HTTP_'+response.status));
  const ambiguous=data?.ambiguous===true||data?.result?.ambiguous===true;
  if(ambiguous||data?.writeAttempted===true){
    await failCommand(raw,prefix+'_AMBIGUOUS_'+reason);
    execution.lastError=prefix+'_AMBIGUOUS_'+reason;
    return false;
  }
  if(['EXECUTION_NOT_READY','EXECUTION_NOT_ARMED','BINANCE_WRITE_LOCKED'].includes(reason)){
    await requeueCommand(raw,prefix+'_'+reason,1500);
    return false;
  }
  await failCommand(raw,prefix+'_'+reason);
  execution.lastError=prefix+'_'+reason;
  return false;
}

async function runCancelEntry(command,raw,dispatch){
  const result=await callProtectiveExecute(dispatch.body);
  if(!result.response.ok||result.data?.ok!==true){
    return handleMutationFailure(raw,result.response,result.data,'CANCEL_ENTRY');
  }
  const status=String(result.data?.result?.order?.status||'').toUpperCase();
  if(status==='FILLED'||result.data?.result?.disposition==='ALREADY_FILLED'){
    await failCommand(raw,'ENTRY_ALREADY_FILLED');
    scheduleReconcile(100);
    return false;
  }
  const clientOrderId=String(dispatch.body?.clientOrderId||'');
  const terminal=terminalStandardStatus(status)
    ?result.data.result.order
    :await waitForStreamOrder({kind:'STANDARD',clientId:clientOrderId,terminal:true},3000);
  const terminalStatus=String(terminal?.status||status||'').toUpperCase();
  if(!['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(terminalStatus)){
    await failCommand(raw,'ENTRY_CANCEL_NOT_CONFIRMED');
    execution.lastError='ENTRY_CANCEL_NOT_CONFIRMED';
    return false;
  }
  return safeAckAfterReconcile(raw,{terminalStatus},'EXEC_CANCEL_ACK_RETRY');
}

async function runMarketEntry(command,raw,dispatch){
  const body={...dispatch.body};
  const symbol=String(body.symbol||'').toUpperCase();

  // An instant buy must still be RUNNING at the last possible moment.
  if(runtime.mode!=='RUNNING'){
    await failCommand(raw,'MARKET_ENTRY_MASTER_NOT_RUNNING');
    execution.lastError='MARKET_ENTRY_MASTER_NOT_RUNNING';
    return false;
  }

  const result=await callEntryExecute(body);
  if(!result.response.ok||result.data?.ok!==true){
    const reason=String(result.data?.code||result.data?.reason||result.data?.error||('HTTP_'+result.response.status));
    const ambiguous=result.data?.ambiguous===true||result.data?.result?.ambiguous===true;
    const wrote=result.data?.writeAttempted===true;
    if(ambiguous||wrote){
      await failCommand(raw,'MARKET_ENTRY_AMBIGUOUS_'+reason);
      execution.lastError='MARKET_ENTRY_AMBIGUOUS_'+reason;
      // A fill may exist even when the HTTP result is ambiguous. Never send another
      // blind MARKET order; reconciliation will discover the position and repair MAX-LOSS.
      scheduleReconcile(100);
      return false;
    }
    if([409,423,429,503].includes(Number(result.response.status))){
      await requeueCommand(raw,'MARKET_ENTRY_'+reason,500);
      return false;
    }
    await failCommand(raw,'MARKET_ENTRY_'+reason);
    execution.lastError='MARKET_ENTRY_'+reason;
    return false;
  }

  const clientOrderId=String(result.data?.plan?.params?.newClientOrderId||'');
  if(!/^zth-ENT-[A-Za-z0-9._:-]+$/.test(clientOrderId)){
    await failCommand(raw,'MARKET_ENTRY_CLIENT_ID_MISSING');
    execution.lastError='MARKET_ENTRY_CLIENT_ID_MISSING';
    scheduleReconcile(100);
    return false;
  }

  let order=await waitForStreamOrder({kind:'STANDARD',clientId:clientOrderId,terminal:true},5000);
  if(!order&&String(result.data?.result?.order?.status||'').toUpperCase()==='FILLED'){
    // The REST RESULT can beat the private stream by a few milliseconds.
    await sleep(150);
    order=await waitForStreamOrder({kind:'STANDARD',clientId:clientOrderId,terminal:true},2500);
  }
  const status=String(order?.status||result.data?.result?.order?.status||'').toUpperCase();
  if(status&&status!=='FILLED'){
    await failCommand(raw,'MARKET_ENTRY_NOT_FILLED_'+status);
    execution.lastError='MARKET_ENTRY_NOT_FILLED_'+status;
    scheduleReconcile(100);
    return false;
  }

  const expectedQty=n(result.data?.plan?.params?.quantity,0);
  const position=await waitForLongPosition(symbol,5000);
  const liveQty=n(position?.positionAmt??position?.quantity,0);
  if(!position||!(liveQty>0)||!(n(position?.entryPrice,0)>0)){
    // Retrying this command is idempotent because the same deterministic clientOrderId
    // is queried before any POST. No second blind MARKET order can be created.
    await requeueCommand(raw,'MARKET_POSITION_NOT_STREAM_CONFIRMED',500);
    scheduleReconcile(100);
    return false;
  }
  if(expectedQty>0&&Math.abs(liveQty-expectedQty)>Math.max(1e-9,expectedQty*1e-8)){
    await failCommand(raw,'MARKET_POSITION_QUANTITY_MISMATCH');
    execution.lastError='MARKET_POSITION_QUANTITY_MISMATCH';
    scheduleReconcile(100);
    return false;
  }

  await publishRuntime();

  // The exact MAX-LOSS is computed from this real Binance entryPrice/quantity.
  // reconcile() repairs it, verifies it on the private stream, then places/verifies
  // the automatic target LIMIT. Never ACK the MARKET command before that completes.
  const reconciled=await awaitReconciliation(15000);
  if(reconciled!==true){
    await requeueCommand(raw,'MARKET_POST_FILL_PROTECTION_PENDING',750);
    return false;
  }

  const confirmedPosition=streamLongPosition(symbol);
  const projection=streamProjection();
  const configuredMaxLoss=configuredMaxLossForSymbol(symbol);
  const maxLossConfirmed=Boolean(
    confirmedPosition&&configuredMaxLoss>0&&
    uniqueManagedMaxLoss(confirmedPosition,projection.binanceOrders||[],configuredMaxLoss)
  );
  if(!maxLossConfirmed){
    await requeueCommand(raw,'MARKET_MAX_LOSS_NOT_CONFIRMED',750);
    scheduleReconcile(100);
    return false;
  }

  await ackCommand(raw,{
    symbol,
    clientOrderId,
    status:'FILLED',
    entryPrice:n(confirmedPosition?.entryPrice,0),
    quantity:Math.abs(n(confirmedPosition?.positionAmt??confirmedPosition?.quantity,0)),
    maxLossConfirmed:true,
    reconciled:true,
  });
  log('INSTANT_MARKET_ENTRY_CONFIRMED',{
    symbol,
    clientOrderId,
    entryPrice:n(confirmedPosition?.entryPrice,0),
    quantity:Math.abs(n(confirmedPosition?.positionAmt??confirmedPosition?.quantity,0)),
    maxLossConfirmed:true,
  });
  return true;
}

async function runProtectiveUpdate(command,raw,dispatch){
  const body={...dispatch.body};
  const type=String(dispatch.type||'').toUpperCase();
  const progressive=type==='EXEC_UPDATE_PROTECTION'&&String(body.protectionKind||'').toUpperCase()==='PROGRESSIVE';
  const maxLoss=type==='EXEC_UPDATE_PROTECTION'&&String(body.protectionKind||'').toUpperCase()==='MAX_LOSS';
  const previousId=type==='EXEC_UPDATE_EXIT'
    ?String(body.previousClientOrderId||'')
    :String(body.previousClientAlgoId||'');

  async function cancelOld(newClientAlgoId=''){
    if(!previousId)return true;
    const result=await callProtectiveUpdateExecute({...body,phase:'CANCEL_OLD',newClientAlgoId});
    if(!result.response.ok||result.data?.ok!==true){
      return handleMutationFailure(raw,result.response,result.data,'PROTECTIVE_CANCEL_OLD');
    }
    const kind=type==='EXEC_UPDATE_EXIT'?'STANDARD':'ALGO';
    const order=await waitForStreamOrder({kind,clientId:previousId,terminal:true},3000);
    const status=String(
      order?.status||
      result.data?.result?.order?.status||
      result.data?.result?.algoOrder?.algoStatus||
      ''
    ).toUpperCase();
    const safeTerminal=kind==='STANDARD'
      ?['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status)
      :['CANCELED','EXPIRED','REJECTED'].includes(status);
    if(!safeTerminal){
      await failCommand(raw,'PREVIOUS_PROTECTIVE_ORDER_CANCEL_NOT_CONFIRMED');
      execution.lastError='PREVIOUS_PROTECTIVE_ORDER_CANCEL_NOT_CONFIRMED';
      return false;
    }
    const reconciled=await awaitReconciliation();
    if(reconciled!==true||userStreamReady(stream.state)!==true){
      await failCommand(raw,'POST_CANCEL_RECONCILIATION_FAILED');
      return false;
    }
    return true;
  }

  async function placeNew({deferReconcile=false}={}){
    const result=await callProtectiveUpdateExecute({...body,phase:'PLACE_NEW'});
    if(!result.response.ok||result.data?.ok!==true){
      await handleMutationFailure(raw,result.response,result.data,'PROTECTIVE_PLACE_NEW');
      return '';
    }
    const clientId=String(
      result.data?.plan?.params?.newClientOrderId||
      result.data?.plan?.params?.clientAlgoId||
      ''
    );
    if(!clientId){
      await failCommand(raw,'PROTECTIVE_NEW_CLIENT_ID_MISSING');
      return '';
    }
    const kind=type==='EXEC_UPDATE_EXIT'?'STANDARD':'ALGO';
    const order=await waitForStreamOrder({kind,clientId,terminal:false},3500);
    if(!order){
      await failCommand(raw,'PROTECTIVE_NEW_ORDER_NOT_STREAM_CONFIRMED');
      execution.lastError='PROTECTIVE_NEW_ORDER_NOT_STREAM_CONFIRMED';
      return '';
    }
    await publishRuntime();
    if(deferReconcile)return clientId;
    const reconciled=await awaitReconciliation();
    if(reconciled!==true||userStreamReady(stream.state)!==true){
      await failCommand(raw,'POST_PLACE_RECONCILIATION_FAILED');
      return '';
    }
    return clientId;
  }

  if(type==='EXEC_UPDATE_EXIT'&&body.activeConfig){
    if(!(await applyPendingProtectionTableBeforeConfigCommit(raw,body)))return false;
  }

  let newClientId='';
  if(maxLoss||progressive){
    newClientId=await placeNew({deferReconcile:maxLoss});
    if(!newClientId)return false;
    if(maxLoss){
      const overlapReady=await awaitReconciliation();
      if(overlapReady!==true||userStreamReady(stream.state)!==true){
        await failCommand(raw,'MAX_LOSS_SAFE_OVERLAP_RECONCILIATION_FAILED');
        execution.lastError='MAX_LOSS_SAFE_OVERLAP_RECONCILIATION_FAILED';
        return false;
      }
    }
    if(!(await cancelOld(newClientId)))return false;
  }else{
    if(!(await cancelOld()))return false;
    newClientId=await placeNew();
    if(!newClientId)return false;
  }
  if(maxLoss&&Number.isFinite(n(body.maxLossUsd,NaN))){
    return safeAckActiveMaxLossAfterReconcile(raw,{newClientId},body);
  }
  if(type==='EXEC_UPDATE_EXIT'&&body.activeConfig){
    return safeAckActiveConfigAfterReconcile(
      raw,{newClientId},body,'EXEC_ACTIVE_TARGET_CONFIG_ACK_RETRY'
    );
  }
  return safeAckAfterReconcile(raw,{newClientId},'EXEC_PROTECTIVE_UPDATE_ACK_RETRY');
}

async function waitForFullCloseState({symbol,direction,beforeQuantity,clientOrderId},timeoutMs=2500){
  const deadline=Date.now()+Math.max(250,n(timeoutMs,2500));
  let result=evaluateFullProtectiveClose({
    state:stream.state,symbol,direction,beforeQuantity,clientOrderId,
  });
  while(Date.now()<deadline){
    result=evaluateFullProtectiveClose({
      state:stream.state,symbol,direction,beforeQuantity,clientOrderId,
    });
    if(result.streamReady&&(result.confirmed||result.terminalSeen))return result;
    await sleep(100);
  }
  try{await awaitReconciliation()}catch{}
  return evaluateFullProtectiveClose({
    state:stream.state,symbol,direction,beforeQuantity,clientOrderId,
  });
}

async function safeAckFullClose(raw,beforeQuantity,clientOrderId='',alreadySatisfied=false){
  try{
    const reconciled=await awaitReconciliation();
    if(reconciled!==true||userStreamReady(stream.state)!==true)throw new Error('RECONCILIATION_NOT_READY');
    await ackCommand(raw,{beforeQuantity,clientOrderId,alreadySatisfied});
    return true;
  }catch(error){
    await requeueCommand(raw,'EXEC_CLOSE_ACK_RETRY_'+String(error?.message||'RECONCILE'),1500);
    return false;
  }
}

async function runFullClose(command,raw){
  const payload=command?.payload||{};
  const symbol=String(payload.symbol||'').toUpperCase();
  const direction=String(payload.direction||'').toUpperCase();
  let currentQuantity=streamPositionQuantity(stream.state,symbol,direction);

  if(!(currentQuantity>0)){
    try{await awaitReconciliation()}catch{}
    currentQuantity=streamPositionQuantity(stream.state,symbol,direction);
    if(currentQuantity<=1e-12&&userStreamReady(stream.state)===true){
      return safeAckFullClose(raw,Math.max(n(payload.quantity),1e-12),'',true);
    }
    await requeueCommand(raw,'LIVE_POSITION_NOT_READY',1500);
    return false;
  }

  const initialQuantity=currentQuantity;
  const requestedExitMode=String(payload.exitMode||'PROTECTIVE_IOC').toUpperCase();
  if(requestedExitMode!=='PROTECTIVE_IOC'){
    await failCommand(raw,'EXIT_MODE_LIMIT_REQUIRED');
    execution.lastError='EXIT_MODE_LIMIT_REQUIRED';
    return false;
  }
  const policies=PROTECTIVE_CLOSE_ATTEMPTS;

  let lastClientOrderId='';
  for(const policy of policies){
    currentQuantity=streamPositionQuantity(stream.state,symbol,direction);
    if(currentQuantity<=1e-12){
      return safeAckFullClose(raw,initialQuantity,lastClientOrderId,lastClientOrderId==='');
    }

    const result=await callProtectiveExecute({
      type:'EXEC_CLOSE_POSITION',
      commandId:String(command.id||''),
      symbol,
      direction,
      quantity:currentQuantity,
      closeAll:true,
      exitMode:policy.exitMode,
      attempt:policy.attempt,
      priceMatch:policy.priceMatch,
    });

    if(!result.response.ok||result.data?.ok!==true){
      const reason=String(result.data?.code||result.data?.reason||result.data?.error||('HTTP_'+result.response.status));
      const wrote=result.data?.writeAttempted===true;
      const ambiguous=result.data?.ambiguous===true||result.data?.result?.ambiguous===true;
      if(wrote||ambiguous){
        await failCommand(raw,'AMBIGUOUS_'+reason);
        execution.lastError='AMBIGUOUS_'+reason;
        return false;
      }
      if([
        'EXECUTION_NOT_READY',
        'EXECUTION_NOT_ARMED',
        'POSITION_NOT_FOUND',
        'CLOSE_QUANTITY_EXCEEDS_POSITION',
        'FULL_CLOSE_QUANTITY_REQUIRED',
      ].includes(reason)){
        try{await awaitReconciliation()}catch{}
        await requeueCommand(raw,'PROTECTIVE_EXEC_'+reason,1500);
        return false;
      }
      await failCommand(raw,'PROTECTIVE_EXEC_'+reason);
      execution.lastError=reason;
      return false;
    }

    lastClientOrderId=String(result.data?.plan?.params?.newClientOrderId||'');
    if(!lastClientOrderId){
      await failCommand(raw,'PROTECTIVE_CLIENT_ORDER_ID_MISSING');
      return false;
    }

    const outcome=await waitForFullCloseState({
      symbol,direction,beforeQuantity:currentQuantity,clientOrderId:lastClientOrderId,
    },2500);

    if(outcome.confirmed&&outcome.streamReady){
      return safeAckFullClose(raw,initialQuantity,lastClientOrderId,false);
    }
    if(!outcome.safeToRetry){
      const reason=outcome.inconsistentFilled
        ?'FILLED_POSITION_MISMATCH'
        :outcome.terminalSeen
          ?'PROTECTIVE_RETRY_NOT_SAFE'
          :'PROTECTIVE_ORDER_UNCONFIRMED';
      await failCommand(raw,reason);
      execution.lastError=reason;
      return false;
    }
  }

  await failCommand(raw,'PROTECTIVE_CLOSE_ATTEMPTS_EXHAUSTED');
  return false;
}

async function commandCycle(){
  if(execution.busy||maxLossRemainderRecovery.busy||stopping)return false;
  if(!masterExecutionEligible({
    role:'master',
    hidden:false,
    leaseActive:runtime.leaseActive,
    realExecutionArmed:runtime.realExecutionArmed,
    userStreamReady:userStreamReady(stream.state),
    mode:runtime.mode,
  }))return false;

  execution.busy=true;
  let raw='';
  try{
    const next=await syncApi('command-next',{method:'POST',body:{}});
    if(next.response.status===423)return false;
    if(!next.response.ok||next.data?.ok!==true){
      throw new Error(next.data?.code||('HTTP_'+next.response.status));
    }
    if(!next.data.command||!next.data.raw)return false;

    const command=next.data.command;
    raw=String(next.data.raw);
    execution.lastCommandId=String(command.id||'');

    let dispatch;
    try{dispatch=buildMasterCommandDispatch(command)}
    catch(error){
      await failCommand(raw,'MASTER_DISPATCH_INVALID_'+String(error?.message||'COMMAND'));
      return false;
    }
    if(dispatch.supported!==true){
      await failCommand(raw,dispatch.reason||'MASTER_COMMAND_NOT_IMPLEMENTED');
      return false;
    }

    let ok=false;
    if(dispatch.type==='EXEC_CLOSE_POSITION')ok=await runFullClose(command,raw);
    else if(dispatch.type==='EXEC_CANCEL_ENTRY')ok=await runCancelEntry(command,raw,dispatch);
    else if(dispatch.type==='EXEC_OPEN_MARKET_POSITION')ok=await runMarketEntry(command,raw,dispatch);
    else if(dispatch.type==='EXEC_UPDATE_ACTIVE_CONFIG')ok=await runActiveConfigCommand(command,raw,dispatch);
    else if(dispatch.type==='EXEC_UPDATE_EXIT'||dispatch.type==='EXEC_UPDATE_PROTECTION'){
      ok=await runProtectiveUpdate(command,raw,dispatch);
    }else{
      await failCommand(raw,'MASTER_COMMAND_NOT_IMPLEMENTED');
      return false;
    }

    if(ok){
      execution.lastError='';
      scheduleReconcile(100);
    }
    return ok;
  }catch(error){
    const reason=String(error?.message||'MASTER_EXECUTION_ERROR');
    execution.lastError=reason;
    if(raw){
      try{await requeueCommand(raw,'MASTER_WORKER_RECOVERY_'+reason,1500)}catch{}
    }
    return false;
  }finally{
    execution.busy=false;
  }
}

async function runtimeCycle(){
  if(stopping)return false;
  try{
    const alive=await heartbeat();
    if(!alive)return false;
    await syncControllerConfig();
    await publishRuntime().catch(error=>logError('RUNTIME_PUBLISH_FAILED',error));
    await ensureUserStream();
    await loadAutoHighWater().catch(error=>logError('AUTO_HIGH_WATER_LOAD_FAILED',error));
    await loadEntryWatchState().catch(error=>logError('ENTRY_WATCH_LOAD_FAILED',error));
    reconcileEntryWatchConfig();
    await ensureMarkPriceStream();
    syncMarkSubscriptions();
    return true;
  }catch(error){
    const code=String(error?.code||error?.message||'RUNTIME_CYCLE_FAILED');
    runtime.error=code;
    if(fatalAuthorityCode(code)){
      logError('AUTHORITY_LOST',error,{code});
      await shutdown(2);
      return false;
    }
    logError('RUNTIME_CYCLE_FAILED',error,{code});
    return false;
  }
}

async function closeRemoteUserStream(){
  if(!sessionCookie||!runtime.leaseActive)return;
  try{await userStreamApi('close','POST')}catch{}
}

async function shutdown(code=0){
  if(stopping)return;
  stopping=true;
  if(heartbeatTimer)clearInterval(heartbeatTimer);
  if(standbyTimer)clearInterval(standbyTimer);
  if(execution.timer)clearInterval(execution.timer);
  if(stream.reconnectTimer)clearTimeout(stream.reconnectTimer);
  if(markStream.reconnectTimer)clearTimeout(markStream.reconnectTimer);
  if(markStream.restartTimer)clearTimeout(markStream.restartTimer);
  if(markStream.fallbackTimer)clearInterval(markStream.fallbackTimer);
  if(autoProtection.highWaterSaveTimer)clearTimeout(autoProtection.highWaterSaveTimer);
  if(entryWatch.saveTimer)clearTimeout(entryWatch.saveTimer);
  clearStreamTimers();
  await persistAutoHighWaterNow().catch(()=>{});
  await persistEntryWatchStateNow().catch(()=>{});
  closeMarkPriceStream('ENGINE_SHUTDOWN',false);
  await closeRemoteUserStream();
  const ws=stream.ws;
  stream.ws=null;
  if(ws&&ws.readyState<2){
    try{ws.close(1000,'zenith-shutdown')}catch{}
  }
  process.exitCode=code;
}

async function main(){
  if(!WORKER_ENABLED){
    log('DISABLED_STANDBY',{reason:'ZENITH_ENGINE_WORKER_ENABLED_NOT_SET'});
    standbyTimer=setInterval(()=>{},60*60*1000);
    return;
  }
  required('ZENITH_BASE_URL',BASE_URL);
  if(BOOTSTRAP_SECRET.length<32)throw new Error('ZENITH_ENGINE_BOOTSTRAP_SECRET_TOO_WEAK');
  if(typeof WebSocket!=='function')throw new Error('NODE_WEBSOCKET_UNAVAILABLE');

  await bootstrapUntilReady();
  if(stopping)return;

  await runtimeCycle();
  heartbeatTimer=setInterval(()=>runtimeCycle(),HEARTBEAT_MS);
  execution.timer=setInterval(()=>commandCycle(),COMMAND_POLL_MS);
  markStream.fallbackTimer=setInterval(
    ()=>fallbackMarkPrices().catch(error=>logError('MARK_FALLBACK_FAILED',error)),
    MARK_FALLBACK_MS
  );

  log('RUNNING',{
    baseOrigin:new URL(BASE_URL).origin,
    commandPollMs:COMMAND_POLL_MS,
    heartbeatMs:HEARTBEAT_MS,
    autoProtectionMoved:true,
  });
}

process.on('SIGTERM',()=>{void shutdown(0)});
process.on('SIGINT',()=>{void shutdown(0)});
process.on('uncaughtException',error=>{
  logError('UNCAUGHT_EXCEPTION',error);
  void shutdown(1);
});
process.on('unhandledRejection',error=>{
  logError('UNHANDLED_REJECTION',error);
  void shutdown(1);
});

main().catch(async error=>{
  logError('STARTUP_FAILED',error);
  await shutdown(1);
});
