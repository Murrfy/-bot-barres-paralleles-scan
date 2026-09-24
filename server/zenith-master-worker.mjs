import crypto from 'node:crypto';

const PREFIX='zenith:v1';
const INSTANCE_KEY=`${PREFIX}:server-master-instance`;
const LEASE_TTL_SECONDS=30;
const LEASE_RENEW_MS=10000;
const HEARTBEAT_MS=8000;
const CONFIG_SYNC_MS=5000;

const BASE_URL=String(process.env.ZENITH_BASE_URL||'').replace(/\/$/,'');
const BOOTSTRAP_SECRET=String(process.env.ZENITH_SERVER_MASTER_BOOTSTRAP_SECRET||'');
const REDIS_URL=
  process.env.UPSTASH_REDIS_REST_URL||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL||
  process.env.KV_REST_API_URL||
  process.env.UPSTASH_REDIS_REST_REDIS_URL||
  '';
const REDIS_TOKEN=
  process.env.UPSTASH_REDIS_REST_TOKEN||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN||
  process.env.KV_REST_API_TOKEN||
  '';

const instanceId='server-'+crypto.randomUUID();
let sessionCookie='';
let stopped=false;
let leaseOwned=false;
let heartbeatTimer=null;
let configTimer=null;
let leaseTimer=null;
let lastHeartbeat=null;

function required(name,value){
  if(!value)throw new Error(name+'_REQUIRED');
  return value;
}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

async function redis(command){
  const r=await fetch(required('UPSTASH_REDIS_REST_URL',REDIS_URL),{
    method:'POST',
    headers:{
      Authorization:`Bearer ${required('UPSTASH_REDIS_REST_TOKEN',REDIS_TOKEN)}`,
      'Content-Type':'application/json',
    },
    body:JSON.stringify(command),
    signal:AbortSignal.timeout(8000),
    cache:'no-store',
  });
  const text=await r.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{}
  if(!r.ok||data?.error)throw new Error(data?.error||`REDIS_HTTP_${r.status}`);
  return data?.result;
}

async function acquireInstanceLease(){
  const result=await redis(['SET',INSTANCE_KEY,instanceId,'EX',String(LEASE_TTL_SECONDS),'NX']);
  leaseOwned=result==='OK';
  if(!leaseOwned)throw new Error('SERVER_MASTER_INSTANCE_ALREADY_ACTIVE');
}

async function renewInstanceLease(){
  const script=[
    "local current = tostring(redis.call('GET', KEYS[1]) or '')",
    "if current ~= ARGV[1] then return 0 end",
    "redis.call('EXPIRE', KEYS[1], ARGV[2])",
    "return 1"
  ].join('\n');
  const renewed=Number(await redis(['EVAL',script,'1',INSTANCE_KEY,instanceId,String(LEASE_TTL_SECONDS)]))===1;
  if(!renewed){
    leaseOwned=false;
    throw new Error('SERVER_MASTER_INSTANCE_LEASE_LOST');
  }
  return true;
}

async function releaseInstanceLease(){
  if(!leaseOwned)return false;
  const script=[
    "local current = tostring(redis.call('GET', KEYS[1]) or '')",
    "if current ~= ARGV[1] then return 0 end",
    "redis.call('DEL', KEYS[1])",
    "return 1"
  ].join('\n');
  const released=Number(await redis(['EVAL',script,'1',INSTANCE_KEY,instanceId]))===1;
  leaseOwned=false;
  return released;
}

function cookieFromResponse(response){
  const values=typeof response.headers.getSetCookie==='function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')||''];
  for(const value of values){
    const match=/(?:^|;\s*)__Host-zenith_device=([^;]+)/.exec(String(value||''));
    if(match)return `__Host-zenith_device=${match[1]}`;
  }
  return '';
}

async function api(action,{method='GET',body=null,allowRebootstrap=true}={}){
  const base=required('ZENITH_BASE_URL',BASE_URL);
  const headers={Accept:'application/json',Origin:base};
  if(sessionCookie)headers.Cookie=sessionCookie;
  if(body!==null)headers['Content-Type']='application/json';
  const r=await fetch(`${base}/api/zenith-sync?action=${encodeURIComponent(action)}`,{
    method,
    headers,
    body:body===null?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(15000),
    cache:'no-store',
  });
  const q=await r.json().catch(()=>({}));
  if((r.status===401||r.status===409)&&allowRebootstrap&&action!=='server-master-bootstrap'){
    sessionCookie='';
  }
  return {r,q};
}

async function bootstrapSession(){
  if(BOOTSTRAP_SECRET.length<32)throw new Error('ZENITH_SERVER_MASTER_BOOTSTRAP_SECRET_TOO_WEAK');
  await renewInstanceLease();
  const {r,q}=await api('server-master-bootstrap',{
    method:'POST',
    body:{bootstrapSecret:BOOTSTRAP_SECRET,instanceId},
    allowRebootstrap:false,
  });
  if(!r.ok||q?.ok!==true||q?.sessionReady!==true){
    const e=new Error(q?.code||`BOOTSTRAP_HTTP_${r.status}`);
    e.status=r.status;
    throw e;
  }
  const cookie=cookieFromResponse(r);
  if(!cookie)throw new Error('SERVER_MASTER_SESSION_COOKIE_MISSING');
  sessionCookie=cookie;
}

async function heartbeat(){
  await renewInstanceLease();
  if(!sessionCookie)await bootstrapSession();
  let result=await api('master-heartbeat',{method:'POST',body:{}});
  if(result.r.status===401||result.q?.code==='UNAUTHORIZED_DEVICE'||result.q?.code==='MASTER_SESSION_REVOKED'){
    await bootstrapSession();
    result=await api('master-heartbeat',{method:'POST',body:{},allowRebootstrap:false});
  }
  if(!result.r.ok||result.q?.ok!==true){
    throw new Error(result.q?.code||`HEARTBEAT_HTTP_${result.r.status}`);
  }
  lastHeartbeat=result.q;
  return result.q;
}

async function syncControllerConfig(){
  if(!sessionCookie)return false;
  const {r,q}=await api('master-config-status',{allowRebootstrap:false});
  if(!r.ok||q?.ok!==true)return false;
  if(q.synchronized===true)return true;
  if(q.applyAllowed!==true||!q.controllerState)return false;
  const revision=Number(q.controllerRevision||q.controllerState?.revision||0);
  const stateHash=String(q.controllerStateHash||q.controllerState?.stateHash||'');
  if(!Number.isInteger(revision)||revision<=0||!stateHash)return false;
  const ack=await api('master-config-ack',{
    method:'POST',
    body:{revision,stateHash},
    allowRebootstrap:false,
  });
  if(!ack.r.ok||ack.q?.ok!==true){
    throw new Error(ack.q?.code||`CONFIG_ACK_HTTP_${ack.r.status}`);
  }
  return true;
}

async function guarded(task,label){
  if(stopped)return;
  try{
    await task();
  }catch(error){
    console.error(JSON.stringify({
      at:new Date().toISOString(),
      component:'zenith-server-master',
      instanceId,
      label,
      error:String(error?.message||error),
    }));
    if(String(error?.message||'').includes('INSTANCE_LEASE_LOST')){
      await shutdown(2);
    }
  }
}

async function shutdown(code=0){
  if(stopped)return;
  stopped=true;
  if(heartbeatTimer)clearInterval(heartbeatTimer);
  if(configTimer)clearInterval(configTimer);
  if(leaseTimer)clearInterval(leaseTimer);
  try{await releaseInstanceLease()}catch{}
  process.exitCode=code;
}

async function main(){
  required('ZENITH_BASE_URL',BASE_URL);
  required('UPSTASH_REDIS_REST_URL',REDIS_URL);
  required('UPSTASH_REDIS_REST_TOKEN',REDIS_TOKEN);
  if(BOOTSTRAP_SECRET.length<32)throw new Error('ZENITH_SERVER_MASTER_BOOTSTRAP_SECRET_TOO_WEAK');

  await acquireInstanceLease();
  await bootstrapSession();
  await heartbeat();
  await syncControllerConfig();

  leaseTimer=setInterval(()=>guarded(renewInstanceLease,'lease-renew'),LEASE_RENEW_MS);
  heartbeatTimer=setInterval(()=>guarded(heartbeat,'heartbeat'),HEARTBEAT_MS);
  configTimer=setInterval(()=>guarded(syncControllerConfig,'config-sync'),CONFIG_SYNC_MS);

  console.log(JSON.stringify({
    at:new Date().toISOString(),
    component:'zenith-server-master',
    status:'FOUNDATION_RUNNING',
    instanceId,
    masterMode:String(lastHeartbeat?.masterMode||'UNKNOWN'),
    realExecutionArmed:lastHeartbeat?.realExecutionArmed===true,
  }));
}

process.on('SIGTERM',()=>{void shutdown(0)});
process.on('SIGINT',()=>{void shutdown(0)});
process.on('uncaughtException',error=>{
  console.error(JSON.stringify({component:'zenith-server-master',fatal:String(error?.message||error)}));
  void shutdown(1);
});
process.on('unhandledRejection',error=>{
  console.error(JSON.stringify({component:'zenith-server-master',fatal:String(error?.message||error)}));
  void shutdown(1);
});

main().catch(async error=>{
  console.error(JSON.stringify({component:'zenith-server-master',startupError:String(error?.message||error)}));
  await shutdown(1);
});
