import crypto from 'node:crypto';
import {
  deviceTokenCandidates,
  sameOriginMutation,
  deviceSessionRecordActive,
  roleAssignmentKey,
  deviceRoleAssignmentActive,
  engineInstanceHeader,
  enginePrincipalInstanceActive,
} from '../lib/device-session.mjs';
import { runLiveEntryPreflight } from './binance-entry-preflight.js';
import {
  entryReadinessReason,
  fetchBinanceTradingApiPermissions,
  binanceApiPermissionBlockers,
} from './binance-entry-execute.js';
import { buildPreparedEntryBundle } from '../lib/entry-bundle.mjs';
import { normalizeEntryTransition } from '../lib/entry-transition.mjs';
import { placeAlgoOrderIdempotent } from '../lib/binance-algo-writer.mjs';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';
import {
  readBinanceWriteBackoff,
  registerBinanceWriteBackoff,
  binanceBackoffSecondsFromError,
} from '../lib/binance-write-backoff.mjs';

const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_STATE=`${PREFIX}:state`;
const KEY_RECONCILE_LAST=`${PREFIX}:reconcile:last`;
const KEY_AUDIT=`${PREFIX}:audit`;
const KEY_REAL_EXECUTION_ARMED=`${PREFIX}:safety:real-execution-armed`;
const KEY_MASTER_MODE=`${PREFIX}:master-mode`;
const KEY_EMERGENCY_STOP=`${PREFIX}:safety:emergency-stop`;
const KEY_CONTROLLER_REV=`${PREFIX}:controller-state:rev`;
const KEY_ENGINE_INSTANCE=`${PREFIX}:engine-instance`;
const KEY_ENTRY_TRANSITIONS=`${PREFIX}:entry-transitions`;

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN;

const REAL_TRADING_ENABLED=process.env.ZENITH_REAL_TRADING_ENABLED==='1';
const BINANCE_WRITE_ENABLED=process.env.ZENITH_BINANCE_WRITE_ENABLED==='1';
const PAIRING_DISABLED=process.env.ZENITH_PAIRING_DISABLED==='1';
const REAL_ENTRY_WRITE_ENABLED=process.env.ZENITH_REAL_ENTRY_WRITE_ENABLED==='1';
const VERCEL_PRODUCTION_WRITE_ALLOWED=
  process.env.VERCEL_ENV==='production'&&process.env.VERCEL_GIT_COMMIT_REF==='main';
const ENTRY_PREPARE_RATE_LIMIT_PER_MINUTE=6;
const BINANCE_PUBLIC_BASE='https://fapi.binance.com';
const MAX_ENTRY_TRANSITIONS=3;

function send(res,status,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex')}
function parseJson(raw){try{return raw?JSON.parse(raw):null}catch{return null}}
function near(a,b){
  const x=Number(a),y=Number(b);
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=Math.max(1e-9,Math.abs(y)*1e-10);
}

async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN){
    const e=new Error('UPSTASH_NOT_CONFIGURED');e.code='UPSTASH_NOT_CONFIGURED';throw e;
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
    const e=new Error(data?.error||`Redis HTTP ${response.status}`);e.code='REDIS_ERROR';throw e;
  }
  return data?.result;
}

async function requireEngineMaster(req){
  for(const token of deviceTokenCandidates(req)){
    const raw=await redis(['GET',`${PREFIX}:device:${sha256(token)}`]);
    if(!raw)continue;
    const device=parseJson(raw);
    if(!deviceSessionRecordActive(device)||!device?.deviceId||device.role!=='master')continue;
    if(String(device?.principal||'')!=='engine')continue;

    const [registered,lease,issuedAt,currentInstance]=await Promise.all([
      redis(['GET',KEY_MASTER_DEVICE]),
      redis(['GET',KEY_MASTER]),
      redis(['GET',roleAssignmentKey(PREFIX,'master')]),
      redis(['GET',KEY_ENGINE_INSTANCE]),
    ]);
    if(String(registered||'')!==String(device.deviceId))continue;
    if(!deviceRoleAssignmentActive(device,issuedAt))continue;

    const suppliedInstance=engineInstanceHeader(req);
    if(!enginePrincipalInstanceActive(device,suppliedInstance,String(currentInstance||''))){
      const e=new Error('ENGINE_INSTANCE_FENCED');e.code='ENGINE_INSTANCE_FENCED';throw e;
    }
    if(String(lease||'')!==String(device.deviceId)){
      const e=new Error('MASTER_LEASE_REQUIRED');e.code='MASTER_LEASE_REQUIRED';throw e;
    }
    return {
      ...device,
      roleIssuedAt:String(issuedAt||'0'),
      engineInstanceId:String(suppliedInstance||''),
    };
  }
  return null;
}

async function entryPrepareRateAllowed(deviceId){
  const bucket=Math.floor(Date.now()/60000);
  const key=`${PREFIX}:rate:entry-prepare:${sha256(deviceId)}:${bucket}`;
  const script=[
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count=Number(await redis(['EVAL',script,'1',key,'120']))||0;
  return count<=ENTRY_PREPARE_RATE_LIMIT_PER_MINUTE;
}
function retryAfterSeconds(){return Math.max(1,60-(Math.floor(Date.now()/1000)%60))}

async function readExecutionState(){
  const [runtimeRaw,reportRaw,armRaw,modeRaw,panicRaw,controllerRevRaw]=await Promise.all([
    redis(['GET',KEY_STATE]),
    redis(['GET',KEY_RECONCILE_LAST]),
    redis(['GET',KEY_REAL_EXECUTION_ARMED]),
    redis(['GET',KEY_MASTER_MODE]),
    redis(['GET',KEY_EMERGENCY_STOP]),
    redis(['GET',KEY_CONTROLLER_REV]),
  ]);
  return {
    runtimeState:parseJson(runtimeRaw),
    report:parseJson(reportRaw),
    armRecord:parseJson(armRaw),
    armRaw:String(armRaw||''),
    masterMode:String(modeRaw||'PAUSED').toUpperCase(),
    emergencyStopActive:panicRaw===null||panicRaw===undefined||panicRaw===''||String(panicRaw)!=='0',
    controllerRevision:Math.max(0,Number(controllerRevRaw||0)),
  };
}

async function publicCurrentPrice(symbol){
  const response=await fetch(
    `${BINANCE_PUBLIC_BASE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`,
    {cache:'no-store',signal:AbortSignal.timeout(8000)}
  );
  const text=await response.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={}}
  if(!response.ok||!(Number(data?.price)>0)){
    const e=new Error('BINANCE_CURRENT_PRICE_UNAVAILABLE');e.status=response.status;throw e;
  }
  return Number(data.price);
}

function bundleMatchesTransition(bundle,record){
  const checked=normalizeEntryTransition(record,{now:Date.now()});
  if(!checked.ok)return false;
  const t=checked.transition,b=bundle.transition;
  return t.state==='PROTECTION_PREPARED'&&
    t.commandId===b.commandId&&t.symbol===b.symbol&&t.side===b.side&&t.direction===b.direction&&
    near(t.quantity,b.quantity)&&near(t.limitPrice,b.limitPrice)&&near(t.maxLossUsd,b.maxLossUsd)&&
    near(t.protectionTriggerPrice,b.protectionTriggerPrice)&&
    t.protectionClientAlgoId===b.protectionClientAlgoId&&
    t.validatedAt===b.validatedAt&&t.controllerRevision===b.controllerRevision&&
    t.masterDeviceId===b.masterDeviceId&&t.masterRoleEpoch===b.masterRoleEpoch&&
    t.engineInstanceId===b.engineInstanceId;
}

async function commitPreparedTransition({
  master,
  expectedArmRaw,
  expectedControllerRevision,
  transition,
}){
  const raw=JSON.stringify(transition);
  const now=Date.now();
  const script=[
    "local registered = tostring(redis.call('GET', KEYS[1]) or '')",
    "if registered ~= ARGV[1] then return {-1, ''} end",
    "local lease = tostring(redis.call('GET', KEYS[2]) or '')",
    "if lease ~= ARGV[1] then return {-2, ''} end",
    "local mode = tostring(redis.call('GET', KEYS[3]) or 'PAUSED')",
    "if mode ~= 'RUNNING' then return {-3, mode} end",
    "local panic = tostring(redis.call('GET', KEYS[4]) or '')",
    "if panic ~= '0' then return {-4, panic} end",
    "local arm = tostring(redis.call('GET', KEYS[5]) or '')",
    "if arm ~= ARGV[3] then return {-5, ''} end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[6]) or '')",
    "if roleEpoch ~= ARGV[2] then return {-6, roleEpoch} end",
    "local revision = tostring(redis.call('GET', KEYS[7]) or '0')",
    "if revision ~= ARGV[4] then return {-7, revision} end",
    "local instance = tostring(redis.call('GET', KEYS[8]) or '')",
    "if instance ~= ARGV[5] then return {-8, instance} end",
    "local rows = redis.call('HGETALL', KEYS[9])",
    "for i=1,#rows,2 do",
    "  local ok, value = pcall(cjson.decode, rows[i+1])",
    "  if not ok then return {-11, rows[i]} end",
    "  if tonumber(value.expiresAt or 0) <= tonumber(ARGV[9]) then",
    "    redis.call('HDEL', KEYS[9], rows[i])",
    "  end",
    "end",
    "local existing = redis.call('HGET', KEYS[9], ARGV[6])",
    "if existing then",
    "  local ok, value = pcall(cjson.decode, existing)",
    "  if not ok then return {-11, existing} end",
    "  if tostring(value.commandId or '') == ARGV[8] then return {0, existing} end",
    "  return {-9, existing}",
    "end",
    "if redis.call('HLEN', KEYS[9]) >= tonumber(ARGV[10]) then return {-10, ''} end",
    "redis.call('HSET', KEYS[9], ARGV[6], ARGV[7])",
    "return {1, ARGV[7]}"
  ].join('\n');
  const result=await redis([
    'EVAL',script,'9',
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    KEY_MASTER_MODE,
    KEY_EMERGENCY_STOP,
    KEY_REAL_EXECUTION_ARMED,
    roleAssignmentKey(PREFIX,'master'),
    KEY_CONTROLLER_REV,
    KEY_ENGINE_INSTANCE,
    KEY_ENTRY_TRANSITIONS,
    String(master.deviceId||''),
    String(master.roleIssuedAt||''),
    String(expectedArmRaw||''),
    String(expectedControllerRevision||0),
    String(master.engineInstanceId||''),
    String(transition.symbol||''),
    raw,
    String(transition.commandId||''),
    String(now),
    String(MAX_ENTRY_TRANSITIONS),
  ]);
  const code=Number(Array.isArray(result)?result[0]:-99);
  const stored=String(Array.isArray(result)?result[1]||'':'');
  return {
    ok:code===1||code===0,
    created:code===1,
    existing:code===0,
    stored,
    reason:code===-1?'MASTER_ROLE_CHANGED_DURING_ENTRY_PREPARE'
      :code===-2?'MASTER_LEASE_CHANGED_DURING_ENTRY_PREPARE'
      :code===-3?'MASTER_NOT_RUNNING_DURING_ENTRY_PREPARE'
      :code===-4?'EMERGENCY_STOP_ACTIVE'
      :code===-5?'REAL_EXECUTION_ARM_CHANGED_DURING_ENTRY_PREPARE'
      :code===-6?'MASTER_ROLE_EPOCH_CHANGED_DURING_ENTRY_PREPARE'
      :code===-7?'CONTROLLER_REVISION_CHANGED_DURING_ENTRY_PREPARE'
      :code===-8?'ENGINE_INSTANCE_CHANGED_DURING_ENTRY_PREPARE'
      :code===-9?'ENTRY_TRANSITION_CONFLICT'
      :code===-10?'MAX_ENTRY_TRANSITIONS_REACHED'
      :code===-11?'ENTRY_TRANSITION_STORE_CORRUPT'
      :code===1||code===0?'':'ENTRY_TRANSITION_COMMIT_FAILED',
  };
}

async function rollbackPreparedTransition(symbol,raw){
  const script=[
    "local current = redis.call('HGET', KEYS[1], ARGV[1])",
    "if not current then return 0 end",
    "if current ~= ARGV[2] then return -1 end",
    "redis.call('HDEL', KEYS[1], ARGV[1])",
    "return 1"
  ].join('\n');
  return Number(await redis(['EVAL',script,'1',KEY_ENTRY_TRANSITIONS,String(symbol||''),String(raw||'')]));
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED',writeAttempted:false});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN',writeAttempted:false});
  const bodyStatus=requestBodyStatus(req,64*1024);
  if(!bodyStatus.ok)return send(res,413,{ok:false,code:'REQUEST_BODY_TOO_LARGE',maxBytes:bodyStatus.maxBytes,writeAttempted:false});

  let master=null;
  try{master=await requireEngineMaster(req)}
  catch(e){return send(res,(e?.code==='MASTER_LEASE_REQUIRED'||e?.code==='ENGINE_INSTANCE_FENCED')?409:503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR',writeAttempted:false})}
  if(!master)return send(res,401,{ok:false,code:'ENGINE_MASTER_REQUIRED',writeAttempted:false});

  const type=String(req.body?.type||'').toUpperCase();
  const commandId=String(req.body?.commandId||'');
  const symbol=String(req.body?.symbol||'').toUpperCase();
  const side=String(req.body?.side||'').toUpperCase();
  const margin=Number(req.body?.margin);
  const leverage=Number(req.body?.leverage);
  const maxLoss=Number(req.body?.maxLoss);
  const targetProfit=Number(req.body?.targetProfit||1);
  const limitPrice=Number(req.body?.limitPrice);
  const validatedAt=Number(req.body?.validatedAt);
  const requestedRevision=Number(req.body?.controllerRevision);

  if(type!=='PREPARE_OPEN_POSITION'||
     !/^[A-Za-z0-9._:-]{8,128}$/.test(commandId)||
     !/^[A-Z0-9]{3,30}$/.test(symbol)||
     !['BUY','SELL'].includes(side)||
     !(margin>0)||!(leverage>0)||!(maxLoss>0)||!(targetProfit>0)||!(limitPrice>0)||
     !(validatedAt>0)||!(requestedRevision>0)){
    return send(res,400,{ok:false,code:'ENTRY_PREPARE_REQUEST_INVALID',writeAttempted:false});
  }

  try{
    if(!(await entryPrepareRateAllowed(master.deviceId))){
      const retryAfter=retryAfterSeconds();
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{ok:false,code:'ENTRY_PREPARE_RATE_LIMIT',retryAfterSeconds:retryAfter,writeAttempted:false});
    }
  }catch(e){
    return send(res,503,{ok:false,code:e?.code||'RATE_LIMIT_BACKEND_ERROR',writeAttempted:false});
  }

  const writesEnabled=Boolean(
    REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&
    REAL_ENTRY_WRITE_ENABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED
  );
  if(!writesEnabled){
    return send(res,423,{
      ok:false,code:'REAL_ENTRY_PREPARE_LOCKED',
      realTradingEnabled:REAL_TRADING_ENABLED,
      binanceWriteEnabled:BINANCE_WRITE_ENABLED,
      pairingDisabled:PAIRING_DISABLED,
      realEntryWriteEnabled:REAL_ENTRY_WRITE_ENABLED,
      writeAttempted:false,
    });
  }

  const apiKey=process.env.BINANCE_TRADING_API_KEY;
  const secret=process.env.BINANCE_TRADING_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'BINANCE_TRADING_CREDENTIALS_MISSING',writeAttempted:false});

  try{
    const backoff=await readBinanceWriteBackoff(redis);
    if(backoff.active){
      res.setHeader('Retry-After',String(backoff.retryAfterSeconds));
      return send(res,429,{
        ok:false,code:'BINANCE_WRITE_BACKOFF_ACTIVE',
        retryAfterSeconds:backoff.retryAfterSeconds,
        binanceStatus:backoff.status,writeAttempted:false,
      });
    }
  }catch{
    return send(res,503,{ok:false,code:'BINANCE_BACKOFF_STATE_UNAVAILABLE',writeAttempted:false});
  }

  let transitionRaw='';
  try{
    const before=await readExecutionState();
    const beforeReason=entryReadinessReason(before,master.deviceId);
    if(beforeReason)return send(res,423,{ok:false,code:'ENTRY_PREPARE_NOT_READY',reason:beforeReason,writeAttempted:false});
    if(before.controllerRevision!==requestedRevision){
      return send(res,409,{
        ok:false,code:'ENTRY_PREPARE_CONTROLLER_REVISION_MISMATCH',
        controllerRevision:before.controllerRevision,writeAttempted:false,
      });
    }

    let permissions;
    try{permissions=await fetchBinanceTradingApiPermissions(apiKey,secret)}
    catch{return send(res,503,{ok:false,code:'BINANCE_API_PERMISSION_REVALIDATION_FAILED',writeAttempted:false})}
    const permissionBlockers=binanceApiPermissionBlockers(permissions);
    if(permissionBlockers.length){
      return send(res,423,{ok:false,code:'BINANCE_API_PERMISSION_REVALIDATION_BLOCKED',blockers:permissionBlockers,writeAttempted:false});
    }

    const currentPrice=await publicCurrentPrice(symbol);
    const resting=side==='BUY'?limitPrice<currentPrice:limitPrice>currentPrice;
    if(!resting){
      return send(res,409,{
        ok:false,code:'ENTRY_LIMIT_NOT_RESTING',
        currentPrice,limitPrice,side,writeAttempted:false,
      });
    }

    const preflight=await runLiveEntryPreflight({
      apiKey,secret,symbol,margin,leverage,maxLoss,requestedPrice:limitPrice,
    });
    if(preflight.evaluation.ready!==true){
      return send(res,409,{
        ok:false,code:'ENTRY_PREFLIGHT_REJECTED',
        reasons:preflight.evaluation.reasons,
        normalized:preflight.evaluation.normalized,
        observedAt:preflight.observedAt,writeAttempted:false,
      });
    }

    const bundle=buildPreparedEntryBundle({
      command:{
        id:commandId,symbol,side,orderType:'LIMIT',limitPrice,
        margin,leverage,maxLoss,targetProfit,
      },
      riskSnapshot:{
        ready:true,
        observedAt:preflight.observedAt,
        normalized:preflight.evaluation.normalized,
      },
      validatedAt,
      controllerRevision:requestedRevision,
      masterDeviceId:master.deviceId,
      masterRoleEpoch:master.roleIssuedAt,
      engineInstanceId:master.engineInstanceId,
      now:Date.now(),
    });

    const latest=await readExecutionState();
    const latestReason=entryReadinessReason(latest,master.deviceId);
    if(latestReason)return send(res,423,{ok:false,code:'ENTRY_PREPARE_NOT_READY',reason:latestReason,writeAttempted:false});
    if(latest.controllerRevision!==requestedRevision){
      return send(res,409,{ok:false,code:'ENTRY_PREPARE_CONTROLLER_REVISION_CHANGED',writeAttempted:false});
    }

    const committed=await commitPreparedTransition({
      master,
      expectedArmRaw:latest.armRaw,
      expectedControllerRevision:requestedRevision,
      transition:bundle.transition,
    });
    if(!committed.ok){
      return send(res,409,{ok:false,code:'ENTRY_PREPARE_COMMIT_BLOCKED',reason:committed.reason,writeAttempted:false});
    }
    transitionRaw=committed.stored;
    const stored=parseJson(committed.stored);
    if(!bundleMatchesTransition(bundle,stored)){
      return send(res,409,{ok:false,code:'ENTRY_PREPARE_TRANSITION_IDENTITY_MISMATCH',writeAttempted:false});
    }

    const result=await placeAlgoOrderIdempotent({
      apiKey,
      secret,
      algoParams:bundle.protectionPlan.params,
      writesEnabled:true,
      timestamp:preflight.serverTime,
    });

    await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
      at:Date.now(),kind:'BINANCE_ENTRY_MAX_LOSS_PREPARED',
      deviceId:master.deviceId,commandId,symbol,side,limitPrice,
      quantity:Number(bundle.transition.quantity),
      maxLossUsd:Number(bundle.transition.maxLossUsd),
      triggerPrice:Number(bundle.transition.protectionTriggerPrice),
      clientAlgoId:String(bundle.transition.protectionClientAlgoId),
      disposition:String(result?.disposition||''),
      writeAttempted:result?.writeAttempted===true,
    })]);
    await redis(['LTRIM',KEY_AUDIT,'0','199']);

    return send(res,200,{
      ok:true,
      mode:'ENTRY_PROTECTION_PREPARED',
      transition:stored,
      entryPlan:bundle.entryPlan,
      protectionPlan:bundle.protectionPlan,
      result,
      currentPrice,
      writeAttempted:result?.writeAttempted===true,
      entryWriteAttempted:false,
      streamConfirmationRequired:true,
    });
  }catch(e){
    const ambiguous=e?.ambiguous===true||
      e?.message==='ALGO_ORDER_RESULT_AMBIGUOUS';
    if(transitionRaw&&!ambiguous){
      try{await rollbackPreparedTransition(symbol,transitionRaw)}catch{}
    }
    const retryAfter=binanceBackoffSecondsFromError(e);
    if(retryAfter>0){
      try{await registerBinanceWriteBackoff(redis,e)}catch{}
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{
        ok:false,code:Number(e?.status)===418?'BINANCE_IP_BANNED':'BINANCE_RATE_LIMITED',
        retryAfterSeconds:retryAfter,binanceStatus:Number(e?.status)||0,
        binanceCode:e?.code??null,ambiguous,writeAttempted:ambiguous,
      });
    }
    return send(res,502,{
      ok:false,
      code:ambiguous?'ENTRY_MAX_LOSS_RESULT_AMBIGUOUS':'ENTRY_MAX_LOSS_PREPARE_FAILED',
      error:'Protected entry preparation failed.',
      binanceCode:e?.code??null,
      ambiguous,
      writeAttempted:ambiguous,
    });
  }
}

export { bundleMatchesTransition, commitPreparedTransition };
