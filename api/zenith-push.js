import crypto from 'node:crypto';
import {
  deviceTokenCandidates,
  deviceSessionRecordActive,
  roleAssignmentKey,
  deviceRoleAssignmentActive,
  engineInstanceHeader,
  enginePrincipalInstanceActive,
  sameOriginMutation,
} from '../lib/device-session.mjs';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';
import { generateVapidKeyPair, sendAppleWebPush } from '../lib/web-push.mjs';

const PREFIX='zenith:v1';
const KEY_CONTROLLER_DEVICE=`${PREFIX}:role-device:controller`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_MASTER=`${PREFIX}:master`;
const KEY_ENGINE_INSTANCE=`${PREFIX}:engine-instance`;
const KEY_VAPID=`${PREFIX}:webpush:vapid`;
const KEY_SUBSCRIPTIONS=`${PREFIX}:webpush:subscriptions`;
const KEY_MAXLOSS_ALERTS=`${PREFIX}:webpush:maxloss-alerts`;
const MAXLOSS_PERSIST_MS=60*1000;
const VAPID_SUBJECT='https://zenithfinal3-ahle.vercel.app';

const REDIS_URL=
  process.env.UPSTASH_REDIS_REST_URL||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL||
  process.env.KV_REST_API_URL||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;
const REDIS_TOKEN=
  process.env.UPSTASH_REDIS_REST_TOKEN||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN||
  process.env.KV_REST_API_TOKEN;

function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex')}
function parseJson(raw){try{return raw?JSON.parse(raw):null}catch{return null}}
function send(res,status,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
}
async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN){
    const error=new Error('UPSTASH_NOT_CONFIGURED');error.code='UPSTASH_NOT_CONFIGURED';throw error;
  }
  const response=await fetch(REDIS_URL,{
    method:'POST',
    headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify(command),
    signal:AbortSignal.timeout(8000),
    cache:'no-store',
  });
  const text=await response.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!response.ok||data?.error){
    const error=new Error(data?.error||`Redis HTTP ${response.status}`);
    error.code='REDIS_ERROR';
    throw error;
  }
  return data?.result;
}
function hashEntries(raw){
  const out=[];
  if(Array.isArray(raw)){
    for(let i=0;i+1<raw.length;i+=2)out.push([String(raw[i]||''),raw[i+1]]);
  }else if(raw&&typeof raw==='object'){
    for(const [key,value] of Object.entries(raw))out.push([String(key),value]);
  }
  return out;
}
function validSymbol(value){return /^[A-Z0-9]{3,30}$/.test(String(value||'').toUpperCase())}
function validB64Url(value,min=16,max=512){
  const text=String(value||'');
  return text.length>=min&&text.length<=max&&/^[A-Za-z0-9_-]+$/.test(text);
}
function appleEndpoint(value){
  let url;
  try{url=new URL(String(value||''))}catch{return ''}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||!(host==='push.apple.com'||host.endsWith('.push.apple.com')))return '';
  if(url.href.length>2048)return '';
  return url.href;
}
function normalizeSubscription(input){
  const endpoint=appleEndpoint(input?.endpoint);
  const p256dh=String(input?.keys?.p256dh||'');
  const auth=String(input?.keys?.auth||'');
  if(!endpoint||!validB64Url(p256dh,64,256)||!validB64Url(auth,16,128))return null;
  return {endpoint,keys:{p256dh,auth}};
}
function validVapid(record){
  return Boolean(
    record&&record.version===1&&
    validB64Url(record.publicKey,80,100)&&
    validB64Url(record.privateKey,40,60)
  );
}
async function ensureVapid(){
  const current=parseJson(await redis(['GET',KEY_VAPID]));
  if(validVapid(current))return current;
  const generated=generateVapidKeyPair();
  const record={version:1,...generated,createdAt:Date.now()};
  await redis(['SET',KEY_VAPID,JSON.stringify(record),'NX']);
  const stored=parseJson(await redis(['GET',KEY_VAPID]));
  if(!validVapid(stored))throw new Error('WEB_PUSH_VAPID_UNAVAILABLE');
  return stored;
}
async function requireDevice(req,allowedRoles=['controller','master']){
  for(const token of deviceTokenCandidates(req)){
    const raw=await redis(['GET',`${PREFIX}:device:${sha256(token)}`]);
    const device=parseJson(raw);
    if(!deviceSessionRecordActive(device)||!device?.deviceId||!allowedRoles.includes(String(device.role||'')))continue;
    const role=String(device.role);
    const roleKey=role==='controller'?KEY_CONTROLLER_DEVICE:KEY_MASTER_DEVICE;
    const owner=await redis(['GET',roleKey]);
    if(String(owner||'')!==String(device.deviceId))continue;
    const issuedAt=await redis(['GET',roleAssignmentKey(PREFIX,role)]);
    if(!deviceRoleAssignmentActive(device,issuedAt))continue;
    if(String(device.principal||'')==='engine'){
      const currentInstance=String(await redis(['GET',KEY_ENGINE_INSTANCE])||'');
      if(!enginePrincipalInstanceActive(device,engineInstanceHeader(req),currentInstance)){
        const error=new Error('ENGINE_INSTANCE_FENCED');error.code='ENGINE_INSTANCE_FENCED';throw error;
      }
      const lease=String(await redis(['GET',KEY_MASTER])||'');
      if(lease!==String(device.deviceId)){
        const error=new Error('MASTER_LEASE_REQUIRED');error.code='MASTER_LEASE_REQUIRED';throw error;
      }
    }
    return device;
  }
  return null;
}
async function currentControllerSubscriptions(){
  const owner=String(await redis(['GET',KEY_CONTROLLER_DEVICE])||'');
  if(!owner)return [];
  const rows=hashEntries(await redis(['HGETALL',KEY_SUBSCRIPTIONS]));
  const subscriptions=[];
  for(const [field,raw] of rows){
    const record=parseJson(raw);
    if(!record||record.version!==1||String(record.deviceId||'')!==owner)continue;
    const subscription=normalizeSubscription(record.subscription);
    if(!subscription)continue;
    subscriptions.push({field,subscription});
  }
  return subscriptions;
}
async function subscriptionsForDevice(deviceId){
  const rows=hashEntries(await redis(['HGETALL',KEY_SUBSCRIPTIONS]));
  return rows
    .map(([field,raw])=>({field,record:parseJson(raw)}))
    .filter(row=>row.record?.version===1&&String(row.record.deviceId||'')===String(deviceId||''));
}
async function pushToCurrentController(payload){
  const rows=await currentControllerSubscriptions();
  if(!rows.length)return {attempted:0,sent:0,failed:0,expired:0};
  const vapid=await ensureVapid();
  let sent=0,failed=0,expired=0;
  for(const row of rows){
    try{
      const result=await sendAppleWebPush({
        subscription:row.subscription,
        payload,
        vapid,
        subject:VAPID_SUBJECT,
      });
      if(result.ok){sent++;continue}
      if(result.expired){
        expired++;
        await redis(['HDEL',KEY_SUBSCRIPTIONS,row.field]);
      }else failed++;
    }catch{
      failed++;
    }
  }
  return {attempted:rows.length,sent,failed,expired};
}
async function readAlertStates(){
  const map=new Map();
  for(const [field,raw] of hashEntries(await redis(['HGETALL',KEY_MAXLOSS_ALERTS]))){
    const state=parseJson(raw);
    if(state&&state.version===1&&validSymbol(field))map.set(field,state);
  }
  return map;
}
async function writeAlertState(symbol,state){
  await redis(['HSET',KEY_MAXLOSS_ALERTS,symbol,JSON.stringify(state)]);
}
async function syncMaxLossStates(positions,now=Date.now()){
  const active=new Map();
  for(const row of Array.isArray(positions)?positions:[]){
    const symbol=String(row?.symbol||'').toUpperCase();
    if(!validSymbol(symbol)||typeof row?.red!=='boolean')throw new Error('MAXLOSS_PUSH_POSITION_INVALID');
    if(active.has(symbol))throw new Error('MAXLOSS_PUSH_POSITION_DUPLICATE');
    active.set(symbol,{symbol,red:row.red,reason:String(row?.reason||'').slice(0,120)});
  }
  const states=await readAlertStates();
  const subs=await currentControllerSubscriptions();

  for(const symbol of [...states.keys()]){
    if(!active.has(symbol)){
      await redis(['HDEL',KEY_MAXLOSS_ALERTS,symbol]);
      states.delete(symbol);
    }
  }

  const events=[];
  for(const [symbol,row] of active){
    const previous=states.get(symbol)||null;
    if(!row.red){
      if(previous?.red===true&&Number(previous.notifiedAt)>0){
        const result=subs.length?await pushToCurrentController({
          title:'🟢 ZENITH — MAX-LOSS RÉTABLIE',
          body:`${symbol} est de nouveau protégé et confirmé sur Binance.`,
          tag:`zenith-maxloss-${symbol}`,
          data:{url:'/',symbol,state:'GREEN'},
        }):{attempted:0,sent:0,failed:0,expired:0};
        events.push({symbol,event:'RECOVERED',...result});
      }
      if(previous)await redis(['HDEL',KEY_MAXLOSS_ALERTS,symbol]);
      continue;
    }

    const redSince=previous?.red===true&&Number(previous.redSince)>0
      ?Number(previous.redSince)
      :now;
    let state={
      version:1,red:true,redSince,
      notifiedAt:previous?.red===true?Number(previous.notifiedAt||0):0,
      reason:row.reason,
      updatedAt:now,
    };
    await writeAlertState(symbol,state);

    if(now-redSince<MAXLOSS_PERSIST_MS||state.notifiedAt>0||!subs.length)continue;
    const claimAt=now;
    state={...state,notifiedAt:claimAt};
    await writeAlertState(symbol,state);
    const seconds=Math.max(60,Math.floor((now-redSince)/1000));
    const result=await pushToCurrentController({
      title:'⚠️ ZENITH — MAX-LOSS PERSISTANT',
      body:`${symbol} est rouge depuis ${seconds} s. La protection n’est toujours pas confirmée sur Binance. Vérification nécessaire.`,
      tag:`zenith-maxloss-${symbol}`,
      data:{url:'/',symbol,state:'RED'},
    });
    events.push({symbol,event:'PERSISTENT_RED',...result});
    if(result.sent===0&&result.failed>0){
      const latest=parseJson(await redis(['HGET',KEY_MAXLOSS_ALERTS,symbol]));
      if(Number(latest?.notifiedAt||0)===claimAt){
        await writeAlertState(symbol,{...state,notifiedAt:0,updatedAt:Date.now()});
      }
    }
  }
  return {active:active.size,events};
}

export default async function handler(req,res){
  const action=String(req.query?.action||'');
  if(!['GET','POST'].includes(String(req.method||'').toUpperCase())){
    return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  }
  if(req.method==='POST'){
    if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});
    const bodyStatus=requestBodyStatus(req,64*1024);
    if(!bodyStatus.ok)return send(res,413,{ok:false,code:'REQUEST_BODY_TOO_LARGE',maxBytes:bodyStatus.maxBytes});
  }

  try{
    if(action==='config'&&req.method==='GET'){
      const device=await requireDevice(req,['controller']);
      if(!device||String(device.principal||'')==='engine')return send(res,401,{ok:false,code:'CONTROLLER_REQUIRED'});
      const vapid=await ensureVapid();
      const subscriptions=await subscriptionsForDevice(device.deviceId);
      return send(res,200,{
        ok:true,
        publicKey:vapid.publicKey,
        subscribed:subscriptions.length>0,
        thresholdSeconds:MAXLOSS_PERSIST_MS/1000,
      });
    }

    if(action==='subscribe'&&req.method==='POST'){
      const device=await requireDevice(req,['controller']);
      if(!device||String(device.principal||'')==='engine')return send(res,401,{ok:false,code:'CONTROLLER_REQUIRED'});
      const subscription=normalizeSubscription(req.body?.subscription);
      if(!subscription)return send(res,400,{ok:false,code:'PUSH_SUBSCRIPTION_INVALID'});
      await ensureVapid();
      const field=sha256(subscription.endpoint);
      const record={
        version:1,
        deviceId:String(device.deviceId),
        subscription,
        createdAt:Date.now(),
        updatedAt:Date.now(),
      };
      await redis(['HSET',KEY_SUBSCRIPTIONS,field,JSON.stringify(record)]);
      return send(res,200,{ok:true,subscribed:true});
    }

    if(action==='unsubscribe'&&req.method==='POST'){
      const device=await requireDevice(req,['controller']);
      if(!device||String(device.principal||'')==='engine')return send(res,401,{ok:false,code:'CONTROLLER_REQUIRED'});
      const endpoint=appleEndpoint(req.body?.endpoint);
      if(!endpoint)return send(res,400,{ok:false,code:'PUSH_ENDPOINT_INVALID'});
      const field=sha256(endpoint);
      const record=parseJson(await redis(['HGET',KEY_SUBSCRIPTIONS,field]));
      if(record&&String(record.deviceId||'')===String(device.deviceId)){
        await redis(['HDEL',KEY_SUBSCRIPTIONS,field]);
      }
      return send(res,200,{ok:true,subscribed:false});
    }

    if(action==='maxloss-sync'&&req.method==='POST'){
      const device=await requireDevice(req,['master']);
      if(!device||String(device.principal||'')!=='engine')return send(res,403,{ok:false,code:'ENGINE_PRINCIPAL_REQUIRED'});
      const positions=req.body?.positions;
      if(!Array.isArray(positions)){
        return send(res,400,{ok:false,code:'MAXLOSS_PUSH_POSITIONS_INVALID'});
      }
      const result=await syncMaxLossStates(positions);
      return send(res,200,{ok:true,...result});
    }

    return send(res,404,{ok:false,code:'ACTION_NOT_FOUND'});
  }catch(error){
    const raw=String(error?.code||'');
    const code=['UPSTASH_NOT_CONFIGURED','REDIS_ERROR','ENGINE_INSTANCE_FENCED','MASTER_LEASE_REQUIRED']
      .includes(raw)?raw:'PUSH_BACKEND_ERROR';
    const status=['ENGINE_INSTANCE_FENCED','MASTER_LEASE_REQUIRED'].includes(code)?409:503;
    return send(res,status,{ok:false,code});
  }
}
