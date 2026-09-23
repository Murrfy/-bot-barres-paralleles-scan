import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation, deviceSessionRecordActive, roleAssignmentKey, deviceRoleAssignmentActive } from '../lib/device-session.mjs';
import { buildEntryOrderPlan } from '../lib/order-intent.mjs';
import { placeStandardOrderIdempotent } from '../lib/binance-order-writer.mjs';
import { findCoveringEntryProtection } from '../lib/entry-protection-gate.mjs';
import { runLiveEntryPreflight } from './binance-entry-preflight.js';
import { validateExecutionArmRecord, executionReadiness } from './binance-protective-execute.js';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';

const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_STATE=`${PREFIX}:state`;
const KEY_RECONCILE_LAST=`${PREFIX}:reconcile:last`;
const KEY_AUDIT=`${PREFIX}:audit`;
const KEY_REAL_EXECUTION_ARMED=`${PREFIX}:safety:real-execution-armed`;
const KEY_MASTER_MODE=`${PREFIX}:master-mode`;
const KEY_EMERGENCY_STOP=`${PREFIX}:safety:emergency-stop`;

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
const VERCEL_PRODUCTION_WRITE_ALLOWED=process.env.VERCEL_ENV==='production'&&process.env.VERCEL_GIT_COMMIT_REF==='main';
const ENTRY_EXECUTION_RATE_LIMIT_PER_MINUTE=6;
const BINANCE_API_BASE='https://api.binance.com';
const BINANCE_API_RESTRICTIONS_PATH='/sapi/v1/account/apiRestrictions';
const BINANCE_API_TIME_PATH='/api/v3/time';
const BINANCE_PERMISSION_RECV_WINDOW=5000;

function send(res,status,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function parseJson(raw){try{return raw?JSON.parse(raw):null}catch{return null}}

async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN)throw new Error('UPSTASH_NOT_CONFIGURED');
  const r=await fetch(REDIS_URL,{
    method:'POST',
    headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
    cache:'no-store',
  });
  const text=await r.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok||data?.error)throw new Error(data?.error||`Redis HTTP ${r.status}`);
  return data?.result;
}

async function requireCurrentMaster(req){
  for(const token of deviceTokenCandidates(req)){
    const tokenHash=sha256(token);
    const raw=await redis(['GET',`${PREFIX}:device:${tokenHash}`]);
    if(!raw)continue;
    const device=parseJson(raw);
    if(!deviceSessionRecordActive(device)||!device?.deviceId||device.role!=='master')continue;
    const [registered,lease]=await Promise.all([
      redis(['GET',KEY_MASTER_DEVICE]),
      redis(['GET',KEY_MASTER]),
    ]);
    if(String(registered||'')!==String(device.deviceId))continue;
    const issuedAt=await redis(['GET',roleAssignmentKey(PREFIX,'master')]);
    if(!deviceRoleAssignmentActive(device,issuedAt))continue;
    if(String(lease||'')!==String(device.deviceId)){
      const e=new Error('MASTER_LEASE_REQUIRED');e.code='MASTER_LEASE_REQUIRED';throw e;
    }
    return device;
  }
  return null;
}

async function entryExecutionRateAllowed(deviceId){
  const bucket=Math.floor(Date.now()/60000);
  const key=`${PREFIX}:rate:entry-execution:${sha256(deviceId)}:${bucket}`;
  const script=[
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count=Number(await redis(['EVAL',script,'1',key,'120']))||0;
  return count<=ENTRY_EXECUTION_RATE_LIMIT_PER_MINUTE;
}
function retryAfterSeconds(){return Math.max(1,60-(Math.floor(Date.now()/1000)%60));}

function binanceApiPermissionBlockers(permission){
  if(!permission||typeof permission!=='object')return ['BINANCE_API_PERMISSIONS_UNAVAILABLE'];
  const blockers=[];
  if(permission.ipRestrict!==true)blockers.push('BINANCE_API_IP_RESTRICTION_REQUIRED');
  if(permission.enableReading!==true)blockers.push('BINANCE_API_READING_REQUIRED');
  if(permission.enableFutures!==true)blockers.push('BINANCE_API_FUTURES_REQUIRED');
  const forbidden=[
    ['enableWithdrawals','BINANCE_API_WITHDRAWALS_MUST_BE_DISABLED'],
    ['enableInternalTransfer','BINANCE_API_INTERNAL_TRANSFER_MUST_BE_DISABLED'],
    ['enableMargin','BINANCE_API_MARGIN_MUST_BE_DISABLED'],
    ['permitsUniversalTransfer','BINANCE_API_UNIVERSAL_TRANSFER_MUST_BE_DISABLED'],
    ['enableVanillaOptions','BINANCE_API_OPTIONS_MUST_BE_DISABLED'],
    ['enableFixApiTrade','BINANCE_API_FIX_TRADE_MUST_BE_DISABLED'],
    ['enableSpotAndMarginTrading','BINANCE_API_SPOT_MARGIN_TRADING_MUST_BE_DISABLED'],
    ['enablePortfolioMarginTrading','BINANCE_API_PORTFOLIO_MARGIN_MUST_BE_DISABLED'],
  ];
  for(const [field,code] of forbidden){
    if(permission[field]===true)blockers.push(code);
  }
  return blockers;
}

async function binancePermissionJson(url,init={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(url,{...init,cache:'no-store',signal:controller.signal});
    const text=await response.text();
    let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    if(!response.ok||data?.code){
      const e=new Error('BINANCE_API_PERMISSION_CHECK_FAILED');
      e.code='BINANCE_API_PERMISSION_CHECK_FAILED';
      e.status=response.status;
      e.binanceCode=data?.code??null;
      throw e;
    }
    return data;
  }finally{
    clearTimeout(timer);
  }
}

async function fetchBinanceApiPermissions(apiKey,secret){
  const time=await binancePermissionJson(`${BINANCE_API_BASE}${BINANCE_API_TIME_PATH}`);
  const serverTime=Number(time?.serverTime);
  if(!Number.isFinite(serverTime)){
    const e=new Error('BINANCE_API_PERMISSION_CHECK_FAILED');
    e.code='BINANCE_API_PERMISSION_CHECK_FAILED';
    throw e;
  }
  const query=new URLSearchParams({
    timestamp:String(serverTime),
    recvWindow:String(BINANCE_PERMISSION_RECV_WINDOW),
  });
  const signature=crypto.createHmac('sha256',secret).update(query.toString()).digest('hex');
  query.set('signature',signature);
  return binancePermissionJson(`${BINANCE_API_BASE}${BINANCE_API_RESTRICTIONS_PATH}?${query.toString()}`,{
    method:'GET',
    headers:{'X-MBX-APIKEY':apiKey},
  });
}

async function readExecutionState(){
  const [runtimeRaw,reportRaw,armRaw,modeRaw,panicRaw]=await Promise.all([
    redis(['GET',KEY_STATE]),
    redis(['GET',KEY_RECONCILE_LAST]),
    redis(['GET',KEY_REAL_EXECUTION_ARMED]),
    redis(['GET',KEY_MASTER_MODE]),
    redis(['GET',KEY_EMERGENCY_STOP]),
  ]);
  return {
    runtimeState:parseJson(runtimeRaw),
    report:parseJson(reportRaw),
    armRecord:parseJson(armRaw),
    masterMode:String(modeRaw||'PAUSED').toUpperCase(),
    emergencyStopActive:panicRaw===null||panicRaw===undefined||panicRaw===''||String(panicRaw)!=='0',
  };
}

function entryReadinessReason(state,masterDeviceId){
  if(state.masterMode!=='RUNNING')return state.masterMode==='PAUSE_PENDING'?'MASTER_PAUSE_PENDING':'MASTER_PAUSED';
  if(state.emergencyStopActive)return 'EMERGENCY_STOP_ACTIVE';
  const armReason=validateExecutionArmRecord(state.armRecord,masterDeviceId);
  if(armReason)return armReason;
  return executionReadiness(state.runtimeState,state.report,masterDeviceId);
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});
  const bodyStatus=requestBodyStatus(req,64*1024);
  if(!bodyStatus.ok)return send(res,413,{ok:false,code:'REQUEST_BODY_TOO_LARGE',maxBytes:bodyStatus.maxBytes,writeAttempted:false});

  let master=null;
  try{master=await requireCurrentMaster(req)}
  catch(e){return send(res,e?.code==='MASTER_LEASE_REQUIRED'?409:503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR',writeAttempted:false})}
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED',writeAttempted:false});

  const type=String(req.body?.type||'').toUpperCase();
  const commandId=String(req.body?.commandId||'');
  const symbol=String(req.body?.symbol||'').trim().toUpperCase();
  const side=String(req.body?.side||'').toUpperCase();
  const orderType=String(req.body?.orderType||'LIMIT').toUpperCase();
  const margin=Number(req.body?.margin);
  const leverage=Number(req.body?.leverage);
  const maxLoss=Number(req.body?.maxLoss);
  const limitPrice=Number(req.body?.limitPrice);

  if(type!=='EXEC_OPEN_POSITION' ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(commandId) ||
      !/^[A-Z0-9]{3,30}$/.test(symbol) ||
      !['BUY','SELL'].includes(side) ||
      orderType!=='LIMIT' ||
      !(margin>0)||!(leverage>0)||!(maxLoss>0)||!(limitPrice>0)){
    return send(res,400,{ok:false,code:'ENTRY_EXECUTION_REQUEST_INVALID',writeAttempted:false});
  }

  try{
    if(!(await entryExecutionRateAllowed(master.deviceId))){
      const retryAfter=retryAfterSeconds();
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{
        ok:false,
        code:'ENTRY_EXECUTION_RATE_LIMIT',
        retryAfterSeconds:retryAfter,
        writeAttempted:false,
      });
    }
  }catch(e){
    return send(res,503,{
      ok:false,
      code:e?.code||'RATE_LIMIT_BACKEND_ERROR',
      writeAttempted:false,
    });
  }

  const apiKey=process.env.BINANCE_API_KEY;
  const secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV',writeAttempted:false});

  try{
    const before=await readExecutionState();
    const beforeReason=entryReadinessReason(before,master.deviceId);
    if(beforeReason)return send(res,423,{ok:false,code:'ENTRY_EXECUTION_NOT_READY',reason:beforeReason,writeAttempted:false});

    let apiPermissions=null;
    try{
      apiPermissions=await fetchBinanceApiPermissions(apiKey,secret);
    }catch(e){
      return send(res,503,{
        ok:false,
        code:'BINANCE_API_PERMISSION_REVALIDATION_FAILED',
        writeAttempted:false,
      });
    }
    const permissionBlockers=binanceApiPermissionBlockers(apiPermissions);
    if(permissionBlockers.length){
      return send(res,423,{
        ok:false,
        code:'BINANCE_API_PERMISSION_REVALIDATION_BLOCKED',
        blockers:permissionBlockers,
        writeAttempted:false,
      });
    }

    const preflight=await runLiveEntryPreflight({
      apiKey,secret,symbol,margin,leverage,maxLoss,requestedPrice:limitPrice,
    });
    if(preflight.evaluation.ready!==true){
      return send(res,409,{
        ok:false,
        code:'ENTRY_PREFLIGHT_REJECTED',
        reasons:preflight.evaluation.reasons,
        normalized:preflight.evaluation.normalized,
        observedAt:preflight.observedAt,
        writeAttempted:false,
      });
    }

    const latest=await readExecutionState();
    const latestReason=entryReadinessReason(latest,master.deviceId);
    if(latestReason)return send(res,423,{ok:false,code:'ENTRY_EXECUTION_NOT_READY',reason:latestReason,writeAttempted:false});

    let plan;
    try{
      plan=buildEntryOrderPlan({
        command:{id:commandId,symbol,side,orderType,limitPrice,margin,leverage,maxLoss},
        riskSnapshot:{
          ready:true,
          observedAt:preflight.observedAt,
          normalized:preflight.evaluation.normalized,
        },
        now:Date.now(),
      });
    }catch(e){
      return send(res,409,{ok:false,code:e?.message||'ENTRY_PLAN_INVALID',writeAttempted:false});
    }

    const protection=findCoveringEntryProtection(latest.runtimeState,{
      symbol,side,quantity:Number(plan.params.quantity),limitPrice,
    });
    if(protection.ready!==true){
      return send(res,423,{
        ok:false,
        code:'ENTRY_PROTECTION_NOT_ARMED',
        reason:protection.reason||'ENTRY_PROTECTION_NOT_ARMED',
        writeAttempted:false,
        plan,
      });
    }

    const writesEnabled=Boolean(
      REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&REAL_ENTRY_WRITE_ENABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED
    );
    if(!writesEnabled){
      return send(res,423,{
        ok:false,
        code:'REAL_ENTRY_WRITE_LOCKED',
        realTradingEnabled:REAL_TRADING_ENABLED,
        binanceWriteEnabled:BINANCE_WRITE_ENABLED,
        pairingDisabled:PAIRING_DISABLED,
        realEntryWriteEnabled:REAL_ENTRY_WRITE_ENABLED,
        writeAttempted:false,
        plan,
        protection:protection.order,
      });
    }

    const result=await placeStandardOrderIdempotent({
      apiKey,
      secret,
      orderParams:plan.params,
      writesEnabled:true,
      timestamp:preflight.serverTime,
    });

    await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
      at:Date.now(),
      kind:'BINANCE_ENTRY_ORDER_DISPATCH',
      deviceId:master.deviceId,
      commandId,
      symbol,
      side,
      limitPrice,
      quantity:Number(plan.params.quantity),
      clientOrderId:plan.params.newClientOrderId,
      protectionIdentity:String(protection.order?.clientAlgoId||protection.order?.clientOrderId||protection.order?.algoId||protection.order?.orderId||''),
      disposition:result.disposition,
      writeAttempted:result.writeAttempted===true,
    })]);
    await redis(['LTRIM',KEY_AUDIT,'0','199']);

    return send(res,200,{
      ok:true,
      plan,
      protection:protection.order,
      result,
      confirmationRequired:true,
    });
  }catch(e){
    return send(res,502,{
      ok:false,
      code:e?.message==='ORDER_RESULT_AMBIGUOUS'?'ORDER_RESULT_AMBIGUOUS':'BINANCE_ENTRY_EXECUTION_FAILED',
      error:'Binance entry execution failed.',
      binanceCode:e?.code??null,
      ambiguous:e?.ambiguous===true,
      writeAttempted:e?.message==='ORDER_RESULT_AMBIGUOUS',
    });
  }
}

export { entryReadinessReason };
