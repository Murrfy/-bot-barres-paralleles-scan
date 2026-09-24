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
import { seedUserStreamStateFromRuntimeSnapshot } from '../lib/user-stream-seed.mjs';
import { runtimeInventoryFromUserStream } from '../lib/master-runtime-inventory.mjs';
import {
  orphanZenithCleanupOrders,
  protectionOnlyMismatchTarget,
} from '../lib/master-command-dispatch.mjs';

const HEARTBEAT_INTERVAL_MS=8000;
const ACTIVATION_BOOTSTRAP_REFRESH_MS=25000;
const RECONCILE_INTERVAL_MS=15000;
const RECONCILE_DEBOUNCE_MS=200;
const STREAM_KEEPALIVE_MS=45*60*1000;
const STREAM_RESTART_MS=23*60*60*1000;
const STREAM_SEED_BUFFER_MAX=1000;
const REQUEST_TIMEOUT_MS=15000;
const RUNTIME_ONLY=true;

const BASE_URL=normalizeBaseUrl(process.env.ZENITH_BASE_URL||'');
const BOOTSTRAP_SECRET=String(process.env.ZENITH_ENGINE_BOOTSTRAP_SECRET||'');
const INSTANCE_ID='engine-instance-'+crypto.randomBytes(18).toString('hex');

let sessionCookie='';
let lastBootstrapAt=0;
let nextBootstrapAt=0;
let authorityReady=false;
let stopped=false;
let maintenanceBusy=false;
let configBusy=false;
let reconcileBusy=false;
let heartbeatTimer=null;
let reconcileTimer=null;
let reconcileDebounceTimer=null;
let streamKeepaliveTimer=null;
let streamRestartTimer=null;
let streamReconnectTimer=null;
let socket=null;
let streamGeneration=0;
let streamSeeding=false;
let bufferedEvents=[];
let messageChain=Promise.resolve();
let streamState=createUserStreamState();
let controllerRevision=0;
let appliedRevision=0;
let controllerConfig=null;
let controllerConfigHash='';
let masterMode='PAUSED';
let realExecutionArmed=false;
let lastStatusCode='';
let lastStatusLogAt=0;

function n(value,fallback=0){
  const x=Number(value);
  return Number.isFinite(x)?x:fallback;
}

function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(ms)||0)));
}

function normalizeBaseUrl(value){
  const raw=String(value||'').trim().replace(/\/+$/,'');
  if(!raw)return '';
  const u=new URL(raw);
  if(u.protocol!=='https:')throw new Error('ZENITH_BASE_URL_HTTPS_REQUIRED');
  return u.origin;
}

function requireEnv(){
  if(!BASE_URL)throw new Error('ZENITH_BASE_URL_REQUIRED');
  if(BOOTSTRAP_SECRET.length<32)throw new Error('ZENITH_ENGINE_BOOTSTRAP_SECRET_TOO_WEAK');
  if(typeof fetch!=='function')throw new Error('NODE_FETCH_REQUIRED');
  if(typeof WebSocket!=='function')throw new Error('NODE_WEBSOCKET_REQUIRED');
}

function stableStringify(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value)){
    return '['+value.map(item=>item===undefined?'null':stableStringify(item)).join(',')+']';
  }
  const parts=[];
  for(const key of Object.keys(value).sort()){
    const encoded=stableStringify(value[key]);
    if(encoded!==undefined)parts.push(JSON.stringify(key)+':'+encoded);
  }
  return '{'+parts.join(',')+'}';
}

function sha256(value){
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function setStatus(code,details={}){
  const normalized=String(code||'').slice(0,120);
  const now=Date.now();
  if(normalized===lastStatusCode&&now-lastStatusLogAt<30000)return;
  lastStatusCode=normalized;
  lastStatusLogAt=now;
  console.log(JSON.stringify({
    at:new Date(now).toISOString(),
    component:'zenith-engine-runtime',
    instanceId:INSTANCE_ID,
    status:normalized,
    ...details,
  }));
}

function errorCode(error){
  return String(error?.code||error?.message||'ENGINE_RUNTIME_ERROR').slice(0,160);
}

function extractSessionCookie(headers){
  const candidates=typeof headers?.getSetCookie==='function'
    ?headers.getSetCookie()
    :[headers?.get?.('set-cookie')||''];
  for(const raw of candidates){
    const match=/(?:^|;\s*)(__Host-zenith_device=[^;]+)/.exec(String(raw||''));
    if(match)return match[1];
  }
  return '';
}

async function request(path,{method='GET',body,bootstrap=false,timeoutMs=REQUEST_TIMEOUT_MS}={}){
  if(!BASE_URL)throw Object.assign(new Error('ZENITH_BASE_URL_REQUIRED'),{code:'ZENITH_BASE_URL_REQUIRED'});
  const headers={
    Accept:'application/json',
    Origin:BASE_URL,
  };
  if(body!==undefined)headers['Content-Type']='application/json';
  if(bootstrap){
    headers.Authorization='Bearer '+BOOTSTRAP_SECRET;
  }else{
    if(sessionCookie)headers.Cookie=sessionCookie;
    headers['X-Zenith-Engine-Instance']=INSTANCE_ID;
  }

  let response;
  try{
    response=await fetch(BASE_URL+path,{
      method,
      cache:'no-store',
      headers,
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(timeoutMs),
    });
  }catch(error){
    const e=new Error('ZENITH_API_UNREACHABLE');
    e.code='ZENITH_API_UNREACHABLE';
    e.cause=error;
    throw e;
  }

  const cookie=extractSessionCookie(response.headers);
  if(cookie)sessionCookie=cookie;
  const data=await response.json().catch(()=>({}));
  return {response,data};
}

async function syncApi(action,options={}){
  return request('/api/zenith-sync?action='+encodeURIComponent(action),options);
}

async function binanceApi(path,options={}){
  return request(path,options);
}

function bootstrapRetryDelay(code,data={}){
  if(code==='ENGINE_ADMIN_REENABLE_REQUIRED')return 60000;
  if(code==='ENGINE_CUTOVER_REQUIRED')return 20000;
  if(code==='ENGINE_INSTANCE_ACTIVE')return 20000;
  if(code==='MASTER_LEASE_CONFLICT')return 15000;
  if(code==='ENGINE_INITIAL_CUTOVER_NOT_SAFE')return 20000;
  if(code==='ENGINE_RESTART_MUTATION_IN_FLIGHT')return 10000;
  if(code==='ENGINE_BOOTSTRAP_RATE_LIMIT')return Math.max(30000,n(data?.retryAfterSeconds,30)*1000);
  if(code==='NON_PRODUCTION_CONTROL_MUTATION')return 60000;
  return 10000;
}

async function bootstrap(){
  if(Date.now()<nextBootstrapAt)return false;
  const {response,data}=await syncApi('engine-bootstrap',{
    method:'POST',
    body:{instanceId:INSTANCE_ID},
    bootstrap:true,
  });
  if(!response.ok||data?.ok!==true||data?.sessionReady!==true){
    const code=String(data?.code||('ENGINE_BOOTSTRAP_HTTP_'+response.status));
    sessionCookie='';
    nextBootstrapAt=Date.now()+bootstrapRetryDelay(code,data);
    setStatus(code,{
      httpStatus:response.status,
      blocker:String(data?.blocker||''),
      registeredMaster:String(data?.registeredMaster||''),
    });
    return false;
  }

  if(String(data.engineInstanceId||'')!==INSTANCE_ID){
    sessionCookie='';
    nextBootstrapAt=Date.now()+30000;
    setStatus('ENGINE_BOOTSTRAP_INSTANCE_MISMATCH');
    return false;
  }

  lastBootstrapAt=Date.now();
  nextBootstrapAt=lastBootstrapAt+ACTIVATION_BOOTSTRAP_REFRESH_MS;
  setStatus(data.initialRegistration===true?'ENGINE_BOOTSTRAPPED_FIRST':'ENGINE_BOOTSTRAPPED_RESTART',{
    restartAuthorized:data.restartAuthorized===true,
    realExecutionArmCarried:data.realExecutionArmCarried===true,
    restartFailClosed:data.restartFailClosed===true,
  });
  return true;
}

async function heartbeat(){
  if(!sessionCookie)return {ok:false,code:'ENGINE_SESSION_MISSING'};
  const {response,data}=await syncApi('master-heartbeat',{method:'POST',body:{}});
  if(!response.ok||data?.ok!==true){
    return {
      ok:false,
      code:String(data?.code||('MASTER_HEARTBEAT_HTTP_'+response.status)),
      status:response.status,
      data,
    };
  }
  masterMode=String(data.masterMode||'PAUSED').toUpperCase();
  realExecutionArmed=data.realExecutionArmed===true;
  return {ok:true,data};
}

async function assertRuntimeOnlyPanic(){
  if(!RUNTIME_ONLY||realExecutionArmed!==true)return false;
  const {response,data}=await syncApi('emergency-stop',{method:'POST',body:{}});
  if(!response.ok||data?.ok!==true){
    throw Object.assign(new Error(data?.code||'RUNTIME_ONLY_PANIC_FAILED'),{
      code:String(data?.code||'RUNTIME_ONLY_PANIC_FAILED'),
    });
  }
  masterMode=String(data.masterMode||'PAUSE_PENDING').toUpperCase();
  // PANIC blocks new entries but does not erase the real-execution arm record.
  // Keep publishing REAL inventory so open Binance positions can never be
  // mistaken for simulation state while this runtime-only worker is active.
  setStatus('RUNTIME_ONLY_FORCED_PANIC',{masterMode});
  return true;
}

async function verifyControllerState(state){
  if(!state||typeof state!=='object'||!state.data||typeof state.data!=='object'){
    throw Object.assign(new Error('CONTROLLER_STATE_INVALID'),{code:'CONTROLLER_STATE_INVALID'});
  }
  const revision=Number(state.revision||0);
  const stateHash=String(state.stateHash||'');
  if(!Number.isInteger(revision)||revision<=0||!stateHash){
    throw Object.assign(new Error('CONTROLLER_STATE_INVALID'),{code:'CONTROLLER_STATE_INVALID'});
  }
  const computed=sha256(stableStringify(state.data));
  if(computed!==stateHash){
    throw Object.assign(new Error('CONTROLLER_STATE_HASH_MISMATCH'),{code:'CONTROLLER_STATE_HASH_MISMATCH'});
  }
  return {revision,stateHash,data:structuredClone(state.data)};
}

async function synchronizeConfig(){
  if(configBusy||!authorityReady)return false;
  configBusy=true;
  try{
    const {response,data}=await syncApi('master-config-status');
    if(!response.ok||data?.ok!==true){
      throw Object.assign(new Error(data?.code||'MASTER_CONFIG_STATUS_FAILED'),{
        code:String(data?.code||'MASTER_CONFIG_STATUS_FAILED'),
      });
    }

    controllerRevision=Math.max(0,n(data.controllerRevision));
    appliedRevision=Math.max(0,n(data.appliedRevision));
    const state=data.controllerState||null;
    if(!state){
      controllerConfig=null;
      controllerConfigHash='';
      return false;
    }
    const verified=await verifyControllerState(state);
    controllerConfig=verified.data;
    controllerConfigHash=verified.stateHash;

    if(data.synchronized===true&&verified.revision===controllerRevision){
      return true;
    }
    if(data.applyAllowed!==true){
      return false;
    }

    const ack=await syncApi('master-config-ack',{
      method:'POST',
      body:{revision:verified.revision,stateHash:verified.stateHash},
    });
    if(!ack.response.ok||ack.data?.ok!==true){
      throw Object.assign(new Error(ack.data?.code||'MASTER_CONFIG_ACK_FAILED'),{
        code:String(ack.data?.code||'MASTER_CONFIG_ACK_FAILED'),
      });
    }
    controllerRevision=verified.revision;
    appliedRevision=verified.revision;
    setStatus('ENGINE_CONFIG_APPLIED',{revision:verified.revision});
    return true;
  }finally{
    configBusy=false;
  }
}

function streamProjection(){
  return runtimeInventoryFromUserStream(
    streamState,
    realExecutionArmed===true?'REAL':'SIMULATION'
  );
}

async function postRuntimeState(){
  if(!authorityReady)return false;
  const projection=streamProjection();
  const data={
    ...projection,
    executionMode:realExecutionArmed===true?'REAL':'SIMULATION',
    mode:realExecutionArmed===true?'REAL':'SIMULATION',
    controllerConfigHash,
    runtimeOwner:'SERVER_ENGINE',
    runtimeOnly:RUNTIME_ONLY,
  };
  const {response,data:result}=await syncApi('state',{
    method:'POST',
    body:{
      controllerRevision,
      appliedRevision,
      data,
    },
  });
  if(!response.ok||result?.ok!==true){
    throw Object.assign(new Error(result?.code||'ENGINE_RUNTIME_STATE_PUBLISH_FAILED'),{
      code:String(result?.code||'ENGINE_RUNTIME_STATE_PUBLISH_FAILED'),
    });
  }
  return true;
}

async function invalidateStream(reason='RECONCILIATION_REQUIRED'){
  streamState=markUserStreamNeedsReconciliation(streamState,String(reason||'RECONCILIATION_REQUIRED'));
  try{await postRuntimeState()}catch{}
}

function clearStreamTimers(){
  if(streamKeepaliveTimer){clearInterval(streamKeepaliveTimer);streamKeepaliveTimer=null}
  if(streamRestartTimer){clearTimeout(streamRestartTimer);streamRestartTimer=null}
  if(reconcileTimer){clearInterval(reconcileTimer);reconcileTimer=null}
  if(reconcileDebounceTimer){clearTimeout(reconcileDebounceTimer);reconcileDebounceTimer=null}
}

async function closeStream(reason='STREAM_DISCONNECTED',{reconnect=false}={}){
  const current=socket;
  socket=null;
  streamSeeding=false;
  bufferedEvents=[];
  clearStreamTimers();
  streamState=markUserStreamDisconnected(streamState,{at:Date.now(),reason});
  try{await postRuntimeState()}catch{}
  if(current&&current.readyState<2){
    try{current.close(1000,'zenith-engine-reconnect')}catch{}
  }
  if(reconnect&&authorityReady&&!stopped){
    if(streamReconnectTimer)clearTimeout(streamReconnectTimer);
    streamReconnectTimer=setTimeout(()=>{
      streamReconnectTimer=null;
      void ensureUserStream();
    },1500);
  }
}

function terminalOrderStatus(kind,status){
  const normalized=String(status||'').toUpperCase();
  return kind==='ALGO'
    ?['CANCELED','TRIGGERED','FINISHED','REJECTED','EXPIRED'].includes(normalized)
    :['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(normalized);
}

function streamOrder(kind,clientId){
  const wanted=String(clientId||'');
  const rows=kind==='ALGO'
    ?Object.values(streamState?.algoOrders||{})
    :Object.values(streamState?.standardOrders||{});
  return rows.find(row=>String(kind==='ALGO'?row?.clientAlgoId:row?.clientOrderId)===wanted)||null;
}

async function waitForStreamOrder({kind,clientId,terminal},timeoutMs=3000){
  const deadline=Date.now()+Math.max(300,n(timeoutMs,3000));
  let order=null;
  while(Date.now()<deadline&&!stopped){
    order=streamOrder(kind,clientId);
    if(order){
      const isTerminal=terminalOrderStatus(kind,order.status);
      if((terminal&&isTerminal)||(!terminal&&!isTerminal))return order;
    }
    await sleep(100);
  }
  return order;
}

async function cleanupOrphanProtection(target){
  const body={
    type:'EXEC_CLEAN_ORPHAN_PROTECTION',
    phase:'CANCEL_ORPHAN',
    symbol:target.symbol,
    orderClass:target.orderClass,
    ...(target.orderClass==='ALGO'
      ?{clientAlgoId:target.clientAlgoId}
      :{clientOrderId:target.clientOrderId}),
  };
  const result=await binanceApi('/api/binance-protective-update-execute',{
    method:'POST',
    body,
  });
  if(!result.response.ok||result.data?.ok!==true){
    throw Object.assign(new Error(result.data?.code||'ORPHAN_CLEANUP_FAILED'),{
      code:String(result.data?.code||'ORPHAN_CLEANUP_FAILED'),
    });
  }
  const clientId=target.orderClass==='ALGO'?target.clientAlgoId:target.clientOrderId;
  const kind=target.orderClass==='ALGO'?'ALGO':'STANDARD';
  const order=await waitForStreamOrder({kind,clientId,terminal:true},3000);
  const status=String(order?.status||'').toUpperCase();
  const safe=kind==='ALGO'
    ?['CANCELED','EXPIRED','REJECTED'].includes(status)
    :['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status);
  if(!safe)throw Object.assign(new Error('ORPHAN_CLEANUP_STREAM_NOT_CONFIRMED'),{code:'ORPHAN_CLEANUP_STREAM_NOT_CONFIRMED'});
}

async function reconcileUserStream(secondPass=false){
  if(reconcileBusy||!authorityReady||!socket||socket.readyState!==1)return false;
  reconcileBusy=true;
  try{
    const result=await binanceApi('/api/binance-reconcile',{method:'POST',body:{}});
    if(!result.response.ok||result.data?.ok!==true||!result.data?.report){
      const reason=String(result.data?.code||('BINANCE_RECONCILE_HTTP_'+result.response.status));
      await invalidateStream('BINANCE_RECONCILIATION_'+reason);
      return false;
    }

    const report=result.data.report;
    const orphans=orphanZenithCleanupOrders(report);
    if(orphans.length){
      if(secondPass){
        await invalidateStream('ORPHAN_CLEANUP_RECONCILIATION_FAILED');
        return false;
      }
      for(const target of orphans)await cleanupOrphanProtection(target);
      await postRuntimeState();
      reconcileBusy=false;
      return reconcileUserStream(true);
    }

    const repairTarget=protectionOnlyMismatchTarget(report);
    if(report.failClosed!==false&&!repairTarget){
      await invalidateStream('BINANCE_RECONCILIATION_'+String(report?.reasons?.[0]||'MISMATCH'));
      return false;
    }

    if(streamState.needsReconciliation===true){
      streamState=markUserStreamReconciled(streamState,{
        observedAt:Number(report.observedAt||Date.now()),
        runtimeHash:String(report.runtimeDataHash||report.runtimeHash||''),
      });
      await postRuntimeState();
      if(!secondPass){
        reconcileBusy=false;
        return reconcileUserStream(true);
      }
    }
    return userStreamReady(streamState);
  }catch(error){
    await invalidateStream(errorCode(error));
    return false;
  }finally{
    reconcileBusy=false;
  }
}

function scheduleReconcile(delay=RECONCILE_DEBOUNCE_MS){
  if(reconcileDebounceTimer)clearTimeout(reconcileDebounceTimer);
  reconcileDebounceTimer=setTimeout(()=>{
    reconcileDebounceTimer=null;
    void reconcileUserStream();
  },Math.max(50,n(delay,RECONCILE_DEBOUNCE_MS)));
}

async function processStreamPayload(payload,expectedGeneration=streamGeneration){
  if(expectedGeneration!==streamGeneration)return {applied:false,reason:'STALE_STREAM_GENERATION'};
  const result=applyUserDataEvent(streamState,payload);
  streamState=result.state;
  if([
    'LISTEN_KEY_EXPIRED',
    'STREAM_EVENT_OUT_OF_ORDER',
    'ORDER_EVENT_IDENTITY_INVALID',
    'ALGO_EVENT_IDENTITY_INVALID',
  ].includes(String(result.reason||''))){
    throw Object.assign(new Error(result.reason),{code:result.reason});
  }
  if(result.applied===true&&['ORDER','ACCOUNT','ALGO'].includes(String(result.kind||''))){
    streamState=markUserStreamNeedsReconciliation(streamState,'STREAM_INVENTORY_CHANGED');
    await postRuntimeState();
    scheduleReconcile();
  }
}

async function seedUserStream(connectionId,connectedAt){
  const result=await binanceApi('/api/binance-runtime-snapshot');
  if(!result.response.ok||result.data?.ok!==true||!result.data?.snapshot){
    throw Object.assign(new Error(result.data?.code||'RUNTIME_SEED_FAILED'),{
      code:String(result.data?.code||'RUNTIME_SEED_FAILED'),
    });
  }
  const snapshot=result.data.snapshot;
  streamState=seedUserStreamStateFromRuntimeSnapshot(snapshot,{connectionId,connectedAt});
  const cutoff=n(snapshot.serverTime,0);
  const buffered=bufferedEvents.splice(0)
    .sort((a,b)=>n(a?.E,n(a?.T,0))-n(b?.E,n(b?.T,0)));
  for(const payload of buffered){
    const eventTime=n(payload?.E,n(payload?.T,0));
    if(cutoff>0&&eventTime>0&&eventTime<cutoff)continue;
    await processStreamPayload(payload,streamGeneration);
  }
  streamSeeding=false;
  await postRuntimeState();
}

async function userStreamKeepalive(){
  if(!authorityReady)return false;
  const result=await binanceApi('/api/binance-user-stream-session?action=keepalive',{method:'POST',body:{}});
  if(!result.response.ok||result.data?.ok!==true){
    throw Object.assign(new Error(result.data?.code||'USER_STREAM_KEEPALIVE_FAILED'),{
      code:String(result.data?.code||'USER_STREAM_KEEPALIVE_FAILED'),
    });
  }
  if(result.data.listenKeyChanged===true){
    await closeStream('LISTEN_KEY_ROTATED',{reconnect:true});
  }
  return true;
}

async function ensureUserStream(){
  if(stopped||!authorityReady)return false;
  if(socket&&(socket.readyState===0||socket.readyState===1))return true;

  const started=await binanceApi('/api/binance-user-stream-session?action=start',{method:'POST',body:{}});
  if(!started.response.ok||started.data?.ok!==true||!started.data?.listenKey){
    throw Object.assign(new Error(started.data?.code||'USER_STREAM_START_FAILED'),{
      code:String(started.data?.code||'USER_STREAM_START_FAILED'),
    });
  }

  const listenKey=String(started.data.listenKey);
  const generation=++streamGeneration;
  const ws=new WebSocket('wss://fstream.binance.com/ws/'+encodeURIComponent(listenKey));
  socket=ws;
  streamSeeding=true;
  bufferedEvents=[];

  ws.addEventListener('open',()=>{
    void (async()=>{
      if(socket!==ws||generation!==streamGeneration)return;
      const connectedAt=Date.now();
      const connectionId='engine-ws-'+generation+'-'+connectedAt;
      streamState=markUserStreamConnected(streamState,{connectionId,at:connectedAt});
      streamSeeding=true;
      bufferedEvents=[];
      clearStreamTimers();
      streamKeepaliveTimer=setInterval(()=>{
        void userStreamKeepalive().catch(error=>{
          setStatus(errorCode(error));
          void closeStream(errorCode(error),{reconnect:true});
        });
      },STREAM_KEEPALIVE_MS);
      streamRestartTimer=setTimeout(()=>{
        void closeStream('SCHEDULED_23H_RECONNECT',{reconnect:true});
      },STREAM_RESTART_MS);
      reconcileTimer=setInterval(()=>{void reconcileUserStream()},RECONCILE_INTERVAL_MS);
      try{
        await postRuntimeState();
        await seedUserStream(connectionId,connectedAt);
        scheduleReconcile(100);
        setStatus('BINANCE_USER_STREAM_CONNECTED');
      }catch(error){
        setStatus(errorCode(error));
        await closeStream(errorCode(error),{reconnect:true});
      }
    })();
  });

  ws.addEventListener('message',event=>{
    if(socket!==ws||generation!==streamGeneration)return;
    let payload;
    try{payload=JSON.parse(String(event.data||''))}
    catch{
      void invalidateStream('STREAM_EVENT_INVALID_JSON');
      return;
    }
    if(streamSeeding){
      if(bufferedEvents.length>=STREAM_SEED_BUFFER_MAX){
        setStatus('STREAM_SEED_BUFFER_OVERFLOW');
        void closeStream('STREAM_SEED_BUFFER_OVERFLOW',{reconnect:true});
        return;
      }
      bufferedEvents.push(payload);
      return;
    }
    const eventGeneration=generation;
    messageChain=messageChain.then(()=>processStreamPayload(payload,eventGeneration)).catch(async error=>{
      const code=errorCode(error);
      setStatus(code);
      await closeStream(code,{reconnect:true});
    });
  });

  ws.addEventListener('error',()=>{
    setStatus('STREAM_SOCKET_ERROR');
  });

  ws.addEventListener('close',()=>{
    if(socket!==ws)return;
    socket=null;
    if(!stopped)void closeStream('STREAM_DISCONNECTED',{reconnect:authorityReady});
  });

  return true;
}

async function maintenanceTick(){
  if(stopped||maintenanceBusy)return;
  maintenanceBusy=true;
  try{
    if(!sessionCookie){
      const bootstrapped=await bootstrap();
      if(!bootstrapped)return;
    }

    let hb=await heartbeat();
    if(!hb.ok){
      authorityReady=false;
      await closeStream(hb.code,{reconnect:false});

      if(hb.code==='MASTER_ACTIVATION_REQUIRED'){
        if(Date.now()-lastBootstrapAt>=ACTIVATION_BOOTSTRAP_REFRESH_MS){
          sessionCookie='';
          await bootstrap();
        }
        setStatus('MASTER_ACTIVATION_REQUIRED');
        return;
      }

      if([
        'ENGINE_INSTANCE_FENCED',
        'UNAUTHORIZED_DEVICE',
        'DEVICE_SESSION_EXPIRED',
      ].includes(hb.code)){
        sessionCookie='';
        nextBootstrapAt=0;
        await bootstrap();
        return;
      }

      if([
        'MASTER_ROLE_CHANGED',
        'MASTER_SESSION_REVOKED',
        'ROLE_DEVICE_CONFLICT',
      ].includes(hb.code)){
        sessionCookie='';
        nextBootstrapAt=Date.now()+60000;
        setStatus(hb.code);
        return;
      }

      setStatus(hb.code,{httpStatus:hb.status||0});
      return;
    }

    authorityReady=true;
    await assertRuntimeOnlyPanic();
    await synchronizeConfig();
    await postRuntimeState();
    await ensureUserStream();
    setStatus('ENGINE_AUTHORITY_HEALTHY',{
      masterMode,
      controllerRevision,
      appliedRevision,
      runtimeOnly:RUNTIME_ONLY,
    });
  }catch(error){
    const code=errorCode(error);
    authorityReady=false;
    await closeStream(code,{reconnect:false});
    if(code==='ENGINE_INSTANCE_FENCED')sessionCookie='';
    setStatus(code);
  }finally{
    maintenanceBusy=false;
  }
}

async function shutdown(signal='shutdown'){
  if(stopped)return;
  stopped=true;
  authorityReady=false;
  if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null}
  if(streamReconnectTimer){clearTimeout(streamReconnectTimer);streamReconnectTimer=null}
  clearStreamTimers();
  await closeStream('ENGINE_SHUTDOWN',{reconnect:false});
  setStatus('ENGINE_STOPPED',{signal});
}

async function main(){
  requireEnv();
  setStatus('ENGINE_STARTING',{runtimeOnly:RUNTIME_ONLY});
  await maintenanceTick();
  heartbeatTimer=setInterval(()=>{void maintenanceTick()},HEARTBEAT_INTERVAL_MS);
}

process.on('SIGTERM',()=>{void shutdown('SIGTERM')});
process.on('SIGINT',()=>{void shutdown('SIGINT')});
process.on('uncaughtException',error=>{
  console.error(JSON.stringify({at:new Date().toISOString(),component:'zenith-engine-runtime',fatal:errorCode(error)}));
  void shutdown('uncaughtException').finally(()=>{process.exitCode=1});
});
process.on('unhandledRejection',error=>{
  console.error(JSON.stringify({at:new Date().toISOString(),component:'zenith-engine-runtime',fatal:errorCode(error)}));
  void shutdown('unhandledRejection').finally(()=>{process.exitCode=1});
});

main().catch(error=>{
  console.error(JSON.stringify({at:new Date().toISOString(),component:'zenith-engine-runtime',startupError:errorCode(error)}));
  process.exitCode=1;
});
