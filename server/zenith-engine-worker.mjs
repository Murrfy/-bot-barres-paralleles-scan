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
} from '../lib/master-command-dispatch.mjs';
import {
  streamPositionQuantity,
  evaluateFullProtectiveClose,
  PROTECTIVE_CLOSE_ATTEMPTS,
} from '../lib/protective-close-state.mjs';
import { evaluateMasterAutoProgressiveProtection } from '../lib/master-auto-protection.mjs';
import { buildMaxLossRepairPlan } from '../lib/maxloss-repair.mjs';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';

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
      runtime.synchronized=false;
      runtime.error='ENGINE_LOCAL_CONFIG_DRIFT_ACTIVE';
      return false;
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
    if(String(order?.type||'').toUpperCase()!=='STOP_MARKET')return false;
    if(!(order?.closePosition===true||order?.closePosition==='true'))return false;
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

async function assertAutoProtectionPanic(reason){
  autoProtection.lastError=String(reason||'AUTO_PROTECTION_FAIL_CLOSED');
  try{
    await syncApi('emergency-stop',{method:'POST',body:{}});
  }catch{}
  await invalidateStream(autoProtection.lastError).catch(()=>{});
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
      await assertAutoProtectionPanic(reason+'_AMBIGUOUS');
    }else{
      autoProtection.lastError=reason;
    }
    return false;
  }

  const clientId=String(placed.data?.plan?.params?.clientAlgoId||'');
  if(!clientId){
    await assertAutoProtectionPanic('AUTO_NEW_PROTECTION_ID_MISSING');
    return false;
  }
  const order=await waitForStreamOrder({kind:'ALGO',clientId,terminal:false},3500);
  if(!order){
    await assertAutoProtectionPanic('AUTO_NEW_PROTECTION_NOT_STREAM_CONFIRMED');
    return false;
  }
  if(String(order?.type||'').toUpperCase()!=='STOP'||
     String(order?.timeInForce||'').toUpperCase()!=='GTC'||
     !(order?.reduceOnly===true||order?.reduceOnly==='true')||
     !realNumberMatches(order?.triggerPrice,level.triggerPrice)||
     !realNumberMatches(order?.price,level.limitPrice)||
     (order?.priceMatch&&String(order.priceMatch).toUpperCase()!=='NONE')){
    await assertAutoProtectionPanic('AUTO_NEW_PROTECTION_IDENTITY_MISMATCH');
    return false;
  }

  await publishRuntime();
  if(await awaitReconciliation()!==true){
    await assertAutoProtectionPanic('AUTO_POST_PLACE_RECONCILIATION_FAILED');
    return false;
  }

  if(plan.previousClientAlgoId){
    const canceled=await callProtectiveUpdateExecute({
      ...body,phase:'CANCEL_OLD',newClientAlgoId:clientId
    });
    if(!canceled.response.ok||canceled.data?.ok!==true){
      await assertAutoProtectionPanic(
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
      await assertAutoProtectionPanic('AUTO_OLD_PROTECTION_CANCEL_NOT_CONFIRMED');
      return false;
    }
    if(await awaitReconciliation()!==true){
      await assertAutoProtectionPanic('AUTO_POST_CANCEL_RECONCILIATION_FAILED');
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
  return Math.max(
    0,
    n(markStream.lastAggTimes.get(wanted),
      n(position?.lifecycleAt??position?.positionLifecycleAt??position?.updateTime,Date.now()-2000))
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
  if(!activeProtectionSymbols().has(wanted))return false;
  const id=n(row?.a,-1);
  const eventTime=n(row?.T,n(row?.E,Date.now()));
  const previousId=markStream.lastAggIds.get(wanted);
  if(Number.isFinite(previousId)&&id>=0&&id<=previousId)return false;
  const price=n(row?.p,0);
  if(!(price>0))return false;
  markStream.lastEventAt=Date.now();
  await runAutoProtection(wanted,price);
  rememberAggCursor(wanted,id,eventTime);
  return true;
}

async function recoverMissedAggTrades(symbol){
  const wanted=String(symbol||'').toUpperCase();
  if(!activeProtectionSymbols().has(wanted)||markStream.recovering.has(wanted))return false;
  markStream.recovering.add(wanted);
  markStream.pendingAggTrades.set(wanted,[]);
  try{
    let start=Math.max(Date.now()-48*60*60*1000,trackingStartTime(wanted)-250);
    let fromId=null;
    let pages=0;
    while(activeProtectionSymbols().has(wanted)&&pages<25){
      const path=fromId==null
        ?`/fapi/v1/aggTrades?symbol=${encodeURIComponent(wanted)}&startTime=${Math.floor(start)}&limit=1000`
        :`/fapi/v1/aggTrades?symbol=${encodeURIComponent(wanted)}&fromId=${fromId}&limit=1000`;
      const rows=await publicBinanceJson(path);
      if(!Array.isArray(rows)||!rows.length)break;
      for(const row of rows){
        if(!activeProtectionSymbols().has(wanted))break;
        await processAggTradeRow(wanted,row);
      }
      pages++;
      if(rows.length<1000)break;
      fromId=n(rows[rows.length-1]?.a,-1)+1;
      if(!(fromId>0))break;
      await sleep(40);
    }
    if(pages>=25){
      await assertAutoProtectionPanic('MARK_RECOVERY_PARTIAL_'+wanted);
      return false;
    }
    return true;
  }catch(error){
    await assertAutoProtectionPanic(
      'MARK_RECOVERY_FAILED_'+cleanReason(error?.message||'BINANCE_PUBLIC_RECOVERY','BINANCE_PUBLIC_RECOVERY')
    );
    return false;
  }finally{
    const queued=markStream.pendingAggTrades.get(wanted)||[];
    markStream.recovering.delete(wanted);
    markStream.pendingAggTrades.delete(wanted);
    queued.sort((a,b)=>n(a?.a)-n(b?.a)||n(a?.T)-n(b?.T));
    for(const row of queued){
      if(activeProtectionSymbols().has(wanted))await processAggTradeRow(wanted,row);
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
  const desired=new Set([...activeProtectionSymbols()].map(markStreamName));
  const add=[...desired].filter(name=>!markStream.subscribed.has(name));
  const remove=[...markStream.subscribed].filter(name=>!desired.has(name));
  if(add.length&&sendMarkControl('SUBSCRIBE',add)){
    add.forEach(name=>markStream.subscribed.add(name));
    for(const symbol of activeProtectionSymbols()){
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
      await assertAutoProtectionPanic('MARK_RECOVERY_BUFFER_OVERFLOW_'+symbol);
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
  if(!activeProtectionSymbols().size)return false;
  try{
    const result=await binanceApi('/api/binance-read');
    if(result.response.status===429)return false;
    if(!result.response.ok||result.data?.ok!==true){
      const code=String(result.data?.code||('HTTP_'+result.response.status));
      if(fatalAuthorityCode(code)){
        const error=new Error(code);error.code=code;throw error;
      }
      markStream.lastError='MARK_FALLBACK_'+code;
      return false;
    }
    const tasks=[];
    for(const position of Array.isArray(result.data?.positions)?result.data.positions:[]){
      const symbol=String(position?.symbol||'').toUpperCase();
      const mark=n(position?.markPrice,0);
      if(activeProtectionSymbols().has(symbol)&&mark>0)tasks.push(runAutoProtection(symbol,mark));
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
  return runtimeInventoryFromUserStream(stream.state,runtime.realExecutionArmed?'REAL':'SIMULATION');
}

function runtimeSnapshot(){
  const projection=streamProjection();
  const executionMode=runtime.realExecutionArmed?'REAL':'SIMULATION';
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

async function callProtectiveExecute(body){
  return binanceApi('/api/binance-protective-execute',{method:'POST',body});
}
async function callProtectiveUpdateExecute(body){
  return binanceApi('/api/binance-protective-update-execute',{method:'POST',body});
}

function repairPriceFilters(){
  return Object.fromEntries([...autoProtection.priceFilters.entries()].map(([symbol,filter])=>[symbol,clone(filter)]));
}

async function assertRepairPanic(reason){
  const code=String(reason||'AUTO_MAX_LOSS_REPAIR_FAIL_CLOSED');
  try{
    const panic=await syncApi('emergency-stop',{method:'POST',body:{}});
    if(!panic.response.ok||panic.data?.ok!==true){
      throw new Error(panic.data?.code||('HTTP_'+panic.response.status));
    }
  }catch(error){
    logError('AUTO_MAX_LOSS_PANIC_FAILED',error,{reason:code});
  }
}

async function repairMissingMaxLoss(report){
  const exactTarget=protectionOnlyMismatchTarget(report);
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
  await assertRepairPanic('AUTO_MAX_LOSS_REPAIR_'+String(plan.reason||'REQUIRED'));

  if(plan.action!=='REPAIR'){
    const reason='AUTO_MAX_LOSS_REPAIR_'+String(plan.reason||'BLOCKED');
    await invalidateStream(reason);
    runtime.error=reason;
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
    await invalidateStream(reason);
    runtime.error=reason;
    return {handled:true,repaired:false,reason};
  }

  const clientId=String(
    placed.data?.plan?.params?.clientAlgoId||
    placed.data?.plan?.params?.newClientOrderId||
    ''
  );
  if(!clientId){
    const reason='AUTO_MAX_LOSS_REPAIR_CLIENT_ID_MISSING';
    await invalidateStream(reason);
    runtime.error=reason;
    return {handled:true,repaired:false,reason};
  }

  const order=await waitForStreamOrder({kind:'ALGO',clientId,terminal:false},3500);
  const expectedSide=plan.direction==='LONG'?'SELL':'BUY';
  const valid=Boolean(
    order&&
    String(order?.symbol||'').toUpperCase()===plan.symbol&&
    String(order?.side||'').toUpperCase()===expectedSide&&
    String(order?.positionSide||'BOTH').toUpperCase()==='BOTH'&&
    String(order?.type||'').toUpperCase()==='STOP_MARKET'&&
    (order?.closePosition===true||order?.closePosition==='true')&&
    !(order?.reduceOnly===true||order?.reduceOnly==='true')&&
    realNumberMatches(order?.triggerPrice??order?.stopPrice,plan.triggerPrice)&&
    /^zth-MAX-[A-Za-z0-9._:-]+$/.test(String(order?.clientAlgoId||clientId))
  );
  if(!valid){
    const reason='AUTO_MAX_LOSS_REPAIR_NOT_STREAM_CONFIRMED';
    await invalidateStream(reason);
    runtime.error=reason;
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

    const repairTarget=protectionOnlyMismatchTarget(data.report);
    if(repairTarget){
      if(secondPass){
        const reason='AUTO_MAX_LOSS_REPAIR_RECONCILIATION_FAILED';
        await assertRepairPanic(reason);
        await invalidateStream(reason);
        runtime.error=reason;
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

  let newClientId='';
  if(maxLoss||progressive){
    newClientId=await placeNew({deferReconcile:maxLoss});
    if(!newClientId)return false;
    if(!(await cancelOld(newClientId)))return false;
  }else{
    if(!(await cancelOld()))return false;
    newClientId=await placeNew();
    if(!newClientId)return false;
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
  const policies=String(payload.exitMode||'PROTECTIVE_IOC').toUpperCase()==='MARKET_LAST_RESORT'
    ?[PROTECTIVE_CLOSE_ATTEMPTS[3]]
    :PROTECTIVE_CLOSE_ATTEMPTS;

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
    },policy.exitMode==='MARKET_LAST_RESORT'?4000:2500);

    if(outcome.confirmed&&outcome.streamReady){
      return safeAckFullClose(raw,initialQuantity,lastClientOrderId,false);
    }
    if(policy.exitMode==='MARKET_LAST_RESORT'){
      await failCommand(raw,'MARKET_CLOSE_NOT_CONFIRMED');
      execution.lastError='MARKET_CLOSE_NOT_CONFIRMED';
      return false;
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
  if(execution.busy||stopping)return false;
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
  clearStreamTimers();
  await persistAutoHighWaterNow().catch(()=>{});
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
