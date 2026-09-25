import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation, deviceSessionRecordActive, roleAssignmentKey, deviceRoleAssignmentActive, engineInstanceHeader, enginePrincipalInstanceActive } from '../lib/device-session.mjs';
import { buildEntryOrderPlan } from '../lib/order-intent.mjs';
import { buildEntryProtectionPlan } from '../lib/entry-protection-plan.mjs';
import { buildEmergencyMaxLossLevel } from '../lib/real-protection-levels.mjs';
import { buildProtectiveAlgoPlan } from '../lib/protective-update-intent.mjs';
import { ensureBinanceEntrySymbolConfig } from '../lib/binance-symbol-config.mjs';
import { placeStandardOrderIdempotent } from '../lib/binance-order-writer.mjs';
import { placeAlgoOrderIdempotent } from '../lib/binance-algo-writer.mjs';
import { normalizeEntryTransition, transitionProtectionMatches } from '../lib/entry-transition.mjs';
import { runLiveEntryPreflight, readConfiguredMaxActivePositions } from './binance-entry-preflight.js';
import { validateExecutionArmRecord, executionReadiness } from './binance-protective-execute.js';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';
import { readBinanceWriteBackoff, registerBinanceWriteBackoff, binanceBackoffSecondsFromError } from '../lib/binance-write-backoff.mjs';

const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_STATE=`${PREFIX}:state`;
const KEY_RECONCILE_LAST=`${PREFIX}:reconcile:last`;
const KEY_AUDIT=`${PREFIX}:audit`;
const KEY_REAL_EXECUTION_ARMED=`${PREFIX}:safety:real-execution-armed`;
const KEY_MASTER_MODE=`${PREFIX}:master-mode`;
const KEY_EMERGENCY_STOP=`${PREFIX}:safety:emergency-stop`;
const KEY_CONTROLLER_STATE=`${PREFIX}:controller-state`;
const KEY_ENTRY_TRANSITIONS=`${PREFIX}:entry-transitions`;
const KEY_ENGINE_INSTANCE=`${PREFIX}:engine-instance`;

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
    if(String(device?.principal||'')==='engine'){
      const suppliedInstance=engineInstanceHeader(req);
      const currentInstance=String(await redis(['GET',`${PREFIX}:engine-instance`])||'');
      if(!enginePrincipalInstanceActive(device,suppliedInstance,currentInstance)){
        const e=new Error('ENGINE_INSTANCE_FENCED');e.code='ENGINE_INSTANCE_FENCED';throw e;
      }
    }
    if(String(lease||'')!==String(device.deviceId)){
      const e=new Error('MASTER_LEASE_REQUIRED');e.code='MASTER_LEASE_REQUIRED';throw e;
    }
    return { ...device, roleIssuedAt: String(issuedAt || '') };
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
  }finally{clearTimeout(timer)}
}

async function fetchBinanceTradingApiPermissions(apiKey,secret){
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
    armRaw:String(armRaw||''),
    masterMode:String(modeRaw||'PAUSED').toUpperCase(),
    emergencyStopActive:panicRaw===null||panicRaw===undefined||panicRaw===''||String(panicRaw)!=='0',
  };
}

async function finalEntryDispatchGate(masterDeviceId,masterRoleEpoch,expectedArmRaw,expectedControllerRevision){
  const script=[
    "local registered = tostring(redis.call('GET', KEYS[1]) or '')",
    "if registered ~= ARGV[1] then return -1 end",
    "local lease = tostring(redis.call('GET', KEYS[2]) or '')",
    "if lease ~= ARGV[1] then return -2 end",
    "local mode = tostring(redis.call('GET', KEYS[3]) or 'PAUSED')",
    "if mode ~= 'RUNNING' then return -3 end",
    "local panic = tostring(redis.call('GET', KEYS[4]) or '')",
    "if panic ~= '0' then return -4 end",
    "local arm = tostring(redis.call('GET', KEYS[5]) or '')",
    "if arm ~= ARGV[3] then return -5 end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[6]) or '')",
    "if roleEpoch ~= ARGV[2] then return -6 end",
    "local controllerRaw = redis.call('GET', KEYS[7])",
    "if not controllerRaw then return -7 end",
    "local ok, controller = pcall(cjson.decode, controllerRaw)",
    "if not ok or not controller then return -7 end",
    "if tonumber(controller['revision'] or 0) ~= tonumber(ARGV[4]) then return -7 end",
    "return 1"
  ].join('\n');
  const result=Number(await redis([
    'EVAL',script,'7',
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    KEY_MASTER_MODE,
    KEY_EMERGENCY_STOP,
    KEY_REAL_EXECUTION_ARMED,
    roleAssignmentKey(PREFIX,'master'),
    KEY_CONTROLLER_STATE,
    String(masterDeviceId||''),
    String(masterRoleEpoch||''),
    String(expectedArmRaw||''),
    String(expectedControllerRevision||0),
  ]));
  return {
    ok:result===1,
    reason:result===-1
      ?'MASTER_ROLE_CHANGED_DURING_ENTRY'
      :result===-2
        ?'MASTER_LEASE_CHANGED_DURING_ENTRY'
        :result===-3
          ?'MASTER_NOT_RUNNING_DURING_ENTRY'
          :result===-4
            ?'EMERGENCY_STOP_ACTIVE'
            :result===-5
              ?'REAL_EXECUTION_ARM_CHANGED_DURING_ENTRY'
              :result===-6
                ?'MASTER_ROLE_EPOCH_CHANGED_DURING_ENTRY'
                :result===-7
                  ?'CONTROLLER_CONFIG_CHANGED_DURING_ENTRY'
                  :'ENTRY_DISPATCH_GATE_FAILED',
  };
}

function entryReadinessReason(state,masterDeviceId){
  if(state.masterMode!=='RUNNING')return state.masterMode==='PAUSE_PENDING'?'MASTER_PAUSE_PENDING':'MASTER_PAUSED';
  if(state.emergencyStopActive)return 'EMERGENCY_STOP_ACTIVE';
  const armReason=validateExecutionArmRecord(state.armRecord,masterDeviceId);
  if(armReason)return armReason;
  return executionReadiness(state.runtimeState,state.report,masterDeviceId);
}

function near(a,b){
  const x=Number(a),y=Number(b);
  return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=Math.max(1e-9,Math.abs(y)*1e-10);
}
async function readEntryTransition(commandId){
  const raw=await redis(['HGET',KEY_ENTRY_TRANSITIONS,String(commandId||'')]);
  return parseJson(raw);
}
async function writeEntryTransition(commandId,transition){
  await redis(['HSET',KEY_ENTRY_TRANSITIONS,String(commandId||''),JSON.stringify(transition)]);
  return transition;
}
function entryTransitionMatchesRequest(transition,{symbol,side,quantity,limitPrice,maxLoss}={}){
  return String(transition?.symbol||'').toUpperCase()===String(symbol||'').toUpperCase()&&
    String(transition?.side||'').toUpperCase()===String(side||'').toUpperCase()&&
    near(transition?.quantity,quantity)&&
    near(transition?.limitPrice,limitPrice)&&
    near(transition?.maxLossUsd,maxLoss);
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});
  const bodyStatus=requestBodyStatus(req,64*1024);
  if(!bodyStatus.ok)return send(res,413,{ok:false,code:'REQUEST_BODY_TOO_LARGE',maxBytes:bodyStatus.maxBytes,writeAttempted:false});

  let master=null;
  try{master=await requireCurrentMaster(req)}
  catch(e){return send(res,(e?.code==='MASTER_LEASE_REQUIRED'||e?.code==='ENGINE_INSTANCE_FENCED')?409:503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR',writeAttempted:false})}
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED',writeAttempted:false});

  const type=String(req.body?.type||'').toUpperCase();
  const phaseProvided=req.body?.phase!==undefined&&req.body?.phase!==null&&String(req.body.phase)!=='';
  const phase=String(req.body?.phase||'').toUpperCase();
  const commandId=String(req.body?.commandId||'');
  const symbol=String(req.body?.symbol||'').trim().toUpperCase();
  const side=String(req.body?.side||'').toUpperCase();
  const orderType=String(req.body?.orderType||'LIMIT').toUpperCase();
  const margin=Number(req.body?.margin);
  const leverage=Number(req.body?.leverage);
  const maxLoss=Number(req.body?.maxLoss);
  const limitPrice=Number(req.body?.limitPrice);
  const requestedAt=Number(req.body?.requestedAt);

  if(String(master?.principal||'')!=='engine'){
    return send(res,423,{ok:false,code:'ENTRY_ENGINE_REQUIRED',writeAttempted:false});
  }
  const marketEntry=type==='EXEC_OPEN_MARKET_POSITION'&&phase==='SUBMIT_MARKET_ENTRY';
  const limitEntry=type==='EXEC_OPEN_POSITION'&&['PREPARE_PROTECTION','SUBMIT_ENTRY'].includes(phase);
  const requestValid=Boolean(
    phaseProvided &&
    (marketEntry||limitEntry) &&
    /^[A-Za-z0-9._:-]{8,128}$/.test(commandId) &&
    /^[A-Z0-9]{3,30}$/.test(symbol) &&
    (marketEntry?side==='BUY':['BUY','SELL'].includes(side)) &&
    (marketEntry?orderType==='MARKET':orderType==='LIMIT') &&
    margin>0&&leverage>0&&maxLoss>0 &&
    (marketEntry||limitPrice>0) &&
    (!marketEntry||(Number.isFinite(requestedAt)&&requestedAt>0&&Date.now()-requestedAt>=-5000&&Date.now()-requestedAt<=30000))
  );
  if(!requestValid){
    return send(res,400,{ok:false,code:phaseProvided?'ENTRY_EXECUTION_REQUEST_INVALID':'ENTRY_PHASE_REQUIRED',writeAttempted:false});
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
        binanceStatus:backoff.status,
        writeAttempted:false,
      });
    }
  }catch{
    return send(res,503,{ok:false,code:'BINANCE_BACKOFF_STATE_UNAVAILABLE',writeAttempted:false});
  }

  try{
    const before=await readExecutionState();
    const beforeReason=entryReadinessReason(before,master.deviceId);
    if(beforeReason)return send(res,423,{ok:false,code:'ENTRY_EXECUTION_NOT_READY',reason:beforeReason,writeAttempted:false});

    let apiPermissions=null;
    try{
      apiPermissions=await fetchBinanceTradingApiPermissions(apiKey,secret);
    }catch{
      return send(res,503,{ok:false,code:'BINANCE_API_PERMISSION_REVALIDATION_FAILED',writeAttempted:false});
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

    const writesEnabled=Boolean(
      REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&REAL_ENTRY_WRITE_ENABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED
    );
    const maxActivePositions=await readConfiguredMaxActivePositions();
    let preflight=await runLiveEntryPreflight({
      apiKey,secret,symbol,margin,leverage,maxLoss,requestedPrice:marketEntry?0:limitPrice,maxActivePositions,
    });
    const configOnlyReasons=new Set(['MARGIN_TYPE_NOT_ISOLATED','ACCOUNT_LEVERAGE_MISMATCH']);
    let initialReasons=Array.isArray(preflight.evaluation?.reasons)?preflight.evaluation.reasons:[];
    let configReasons=initialReasons.filter(reason=>configOnlyReasons.has(reason));
    let nonConfigReasons=initialReasons.filter(reason=>!configOnlyReasons.has(reason));

    if(preflight.evaluation.ready!==true&&nonConfigReasons.length){
      return send(res,409,{
        ok:false,code:'ENTRY_PREFLIGHT_REJECTED',
        reasons:initialReasons,normalized:preflight.evaluation.normalized,
        observedAt:preflight.observedAt,writeAttempted:false,
      });
    }

    if(configReasons.length){
      if(phase!=='PREPARE_PROTECTION'&&!marketEntry){
        return send(res,409,{
          ok:false,code:'ENTRY_SYMBOL_CONFIG_CHANGED_AFTER_PREPARE',
          reasons:initialReasons,normalized:preflight.evaluation.normalized,writeAttempted:false,
        });
      }
      if(!writesEnabled){
        return send(res,423,{
          ok:false,code:'REAL_ENTRY_WRITE_LOCKED',
          realTradingEnabled:REAL_TRADING_ENABLED,binanceWriteEnabled:BINANCE_WRITE_ENABLED,
          pairingDisabled:PAIRING_DISABLED,realEntryWriteEnabled:REAL_ENTRY_WRITE_ENABLED,
          reason:'BINANCE_SYMBOL_CONFIG_CHANGE_REQUIRED',writeAttempted:false,
        });
      }
      const configGateState=await readExecutionState();
      const configGateReason=entryReadinessReason(configGateState,master.deviceId);
      if(configGateReason){
        return send(res,423,{ok:false,code:'ENTRY_EXECUTION_NOT_READY',reason:configGateReason,writeAttempted:false});
      }
      const configDispatchGate=await finalEntryDispatchGate(
        master.deviceId,master.roleIssuedAt,configGateState.armRaw,
        configGateState.armRecord?.controllerRevision
      );
      if(!configDispatchGate.ok){
        return send(res,423,{
          ok:false,code:'ENTRY_SYMBOL_CONFIG_COMMIT_BLOCKED',
          reason:configDispatchGate.reason,writeAttempted:false,
        });
      }

      const configResult=await ensureBinanceEntrySymbolConfig({
        apiKey,secret,symbol,leverage,timestamp:preflight.serverTime,
      });
      await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
        at:Date.now(),kind:'BINANCE_SYMBOL_CONFIG_APPLY',
        deviceId:master.deviceId,commandId,symbol,
        requestedMarginType:'ISOLATED',requestedLeverage:leverage,
        marginTypeChanged:configResult.marginTypeChanged===true,
        leverageChanged:configResult.leverageChanged===true,
        recoveredAfterAmbiguous:configResult.recoveredAfterAmbiguous===true,
        writeAttempted:configResult.writeAttempted===true,
      })]);
      await redis(['LTRIM',KEY_AUDIT,'0','199']);

      preflight=await runLiveEntryPreflight({
        apiKey,secret,symbol,margin,leverage,maxLoss,requestedPrice:marketEntry?0:limitPrice,maxActivePositions,
      });
      initialReasons=Array.isArray(preflight.evaluation?.reasons)?preflight.evaluation.reasons:[];
      if(preflight.evaluation.ready!==true){
        return send(res,409,{
          ok:false,code:'ENTRY_PREFLIGHT_REJECTED_AFTER_CONFIG',
          reasons:initialReasons,normalized:preflight.evaluation.normalized,
          observedAt:preflight.observedAt,writeAttempted:configResult.writeAttempted===true,
        });
      }
    }

    const latest=await readExecutionState();
    const latestReason=entryReadinessReason(latest,master.deviceId);
    if(latestReason)return send(res,423,{ok:false,code:'ENTRY_EXECUTION_NOT_READY',reason:latestReason,writeAttempted:false});

    let plan;
    try{
      plan=buildEntryOrderPlan({
        command:{id:commandId,symbol,side,orderType,...(marketEntry?{}:{limitPrice}),margin,leverage,maxLoss},
        riskSnapshot:{ready:true,observedAt:preflight.observedAt,normalized:preflight.evaluation.normalized},
        now:Date.now(),
      });
    }catch(e){
      return send(res,409,{ok:false,code:e?.message||'ENTRY_PLAN_INVALID',writeAttempted:false});
    }

    if(marketEntry){
      if(!writesEnabled){
        return send(res,423,{
          ok:false,code:'REAL_ENTRY_WRITE_LOCKED',
          realTradingEnabled:REAL_TRADING_ENABLED,binanceWriteEnabled:BINANCE_WRITE_ENABLED,
          pairingDisabled:PAIRING_DISABLED,realEntryWriteEnabled:REAL_ENTRY_WRITE_ENABLED,
          writeAttempted:false,plan,
        });
      }
      const dispatchGate=await finalEntryDispatchGate(
        master.deviceId,master.roleIssuedAt,latest.armRaw,latest.armRecord?.controllerRevision
      );
      if(!dispatchGate.ok){
        return send(res,423,{
          ok:false,code:'MARKET_ENTRY_COMMIT_BLOCKED',reason:dispatchGate.reason,
          writeAttempted:false,plan,
        });
      }
      const result=await placeStandardOrderIdempotent({
        apiKey,secret,orderParams:plan.params,writesEnabled:true,timestamp:preflight.serverTime,
      });
      const order=result?.order||{};
      const status=String(order?.status||'').toUpperCase();
      const executedQty=Number(order?.executedQty||order?.cumQty||0);
      const avgPrice=Number(order?.avgPrice||0);
      await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
        at:Date.now(),kind:'BINANCE_MARKET_ENTRY_DISPATCH',
        deviceId:master.deviceId,commandId,symbol,side,
        quantity:Number(plan.params.quantity),clientOrderId:plan.params.newClientOrderId,
        status,executedQty:Number.isFinite(executedQty)?executedQty:0,
        avgPrice:Number.isFinite(avgPrice)?avgPrice:0,
        disposition:result.disposition,writeAttempted:result.writeAttempted===true,
        maxLossPendingExactFill:true,
      })]);
      await redis(['LTRIM',KEY_AUDIT,'0','199']);
      return send(res,200,{
        ok:true,phase:'MARKET_ENTRY_SUBMITTED',plan,result,
        fillConfirmed:status==='FILLED'&&executedQty>0,
        confirmationRequired:true,
        maxLossRepairRequired:true,
      });
    }

    if(phase==='PREPARE_PROTECTION'){
      let protectionPlan;
      try{
        const normalized=preflight.evaluation.normalized||{};
        protectionPlan=buildEntryProtectionPlan({
          commandId,symbol,side,quantity:Number(plan.params.quantity),limitPrice,maxLoss,
          priceFilter:{
            tickSize:normalized.priceTickSize,
            minPrice:normalized.minPrice,
            maxPrice:normalized.maxPrice,
          },
        });
      }catch(e){
        return send(res,409,{ok:false,code:e?.message||'ENTRY_PROTECTION_PLAN_INVALID',writeAttempted:false,plan});
      }

      const at=Date.now();
      const existing=await readEntryTransition(commandId);
      if(existing){
        const checkedExisting=normalizeEntryTransition(existing,{now:at});
        if(!checkedExisting.ok){
          return send(res,409,{ok:false,code:checkedExisting.reason||'ENTRY_TRANSITION_INVALID',writeAttempted:false});
        }
        if(!entryTransitionMatchesRequest(checkedExisting.transition,{
          symbol,side,quantity:Number(plan.params.quantity),limitPrice,maxLoss
        })){
          return send(res,409,{ok:false,code:'ENTRY_TRANSITION_REQUEST_MISMATCH',writeAttempted:false});
        }
      }
      const engineInstanceId=String(await redis(['GET',KEY_ENGINE_INSTANCE])||'');
      const createdAt=Number(existing?.createdAt||at);
      const transitionDraft={
        version:1,
        state:String(existing?.state||'PROTECTION_PREPARED').toUpperCase()==='ENTRY_SUBMITTED'
          ?'ENTRY_SUBMITTED':'PROTECTION_PREPARED',
        commandId,symbol,side,direction:side==='BUY'?'LONG':'SHORT',
        quantity:Number(plan.params.quantity),limitPrice,maxLossUsd:maxLoss,
        protectionTriggerPrice:protectionPlan.triggerPrice,
        protectionClientAlgoId:protectionPlan.algoPlan.params.clientAlgoId,
        entryClientOrderId:String(existing?.entryClientOrderId||''),
        createdAt,expiresAt:Number(existing?.expiresAt||createdAt+120000),validatedAt:at,
        controllerRevision:Number(latest.armRecord?.controllerRevision||0),
        masterDeviceId:String(master.deviceId||''),
        masterRoleEpoch:String(master.roleIssuedAt||''),
        engineInstanceId,
      };
      const checked=normalizeEntryTransition(transitionDraft,{now:at});
      if(!checked.ok){
        return send(res,409,{ok:false,code:checked.reason||'ENTRY_TRANSITION_INVALID',writeAttempted:false});
      }
      if(!writesEnabled){
        return send(res,423,{
          ok:false,code:'REAL_ENTRY_WRITE_LOCKED',
          realTradingEnabled:REAL_TRADING_ENABLED,binanceWriteEnabled:BINANCE_WRITE_ENABLED,
          pairingDisabled:PAIRING_DISABLED,realEntryWriteEnabled:REAL_ENTRY_WRITE_ENABLED,
          writeAttempted:false,plan,protectionPlan,
        });
      }
      const dispatchGate=await finalEntryDispatchGate(
        master.deviceId,master.roleIssuedAt,latest.armRaw,latest.armRecord?.controllerRevision
      );
      if(!dispatchGate.ok){
        return send(res,423,{
          ok:false,code:'ENTRY_PROTECTION_COMMIT_BLOCKED',reason:dispatchGate.reason,
          writeAttempted:false,plan,protectionPlan,
        });
      }
      const protectionResult=await placeAlgoOrderIdempotent({
        apiKey,secret,algoParams:protectionPlan.algoPlan.params,writesEnabled:true,timestamp:preflight.serverTime,
      });
      await writeEntryTransition(commandId,checked.transition);
      await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
        at:Date.now(),kind:'BINANCE_ENTRY_PROTECTION_PREPARED',
        deviceId:master.deviceId,commandId,symbol,side,limitPrice,
        quantity:Number(plan.params.quantity),maxLoss,
        triggerPrice:protectionPlan.triggerPrice,
        clientAlgoId:protectionPlan.algoPlan.params.clientAlgoId,
        disposition:protectionResult.disposition,writeAttempted:protectionResult.writeAttempted===true,
      })]);
      await redis(['LTRIM',KEY_AUDIT,'0','199']);
      return send(res,200,{
        ok:true,phase:'PROTECTION_PREPARED',plan,protectionPlan,
        result:protectionResult,transition:checked.transition,confirmationRequired:true,
      });
    }

    const rawTransition=await readEntryTransition(commandId);
    const checkedTransition=normalizeEntryTransition(rawTransition,{now:Date.now()});
    if(!checkedTransition.ok){
      return send(res,423,{
        ok:false,code:'ENTRY_PROTECTION_TRANSITION_REQUIRED',
        reason:checkedTransition.reason||'ENTRY_TRANSITION_MISSING',writeAttempted:false,plan,
      });
    }
    let storedTransition=checkedTransition.transition;
    if(!entryTransitionMatchesRequest(storedTransition,{
      symbol,side,quantity:Number(plan.params.quantity),limitPrice,maxLoss
    })){
      return send(res,409,{ok:false,code:'ENTRY_TRANSITION_REQUEST_MISMATCH',writeAttempted:false,plan});
    }
    const exactOrder=(Array.isArray(latest.runtimeState?.data?.binanceOrders)?latest.runtimeState.data.binanceOrders:[])
      .find(order=>transitionProtectionMatches(order,storedTransition));
    if(!exactOrder){
      return send(res,423,{
        ok:false,code:'ENTRY_PROTECTION_NOT_STREAM_CONFIRMED',
        writeAttempted:false,plan,transition:storedTransition,
      });
    }
    if(!writesEnabled){
      return send(res,423,{
        ok:false,code:'REAL_ENTRY_WRITE_LOCKED',
        realTradingEnabled:REAL_TRADING_ENABLED,binanceWriteEnabled:BINANCE_WRITE_ENABLED,
        pairingDisabled:PAIRING_DISABLED,realEntryWriteEnabled:REAL_ENTRY_WRITE_ENABLED,
        writeAttempted:false,plan,protection:exactOrder,
      });
    }

    const dispatchGate=await finalEntryDispatchGate(
      master.deviceId,master.roleIssuedAt,latest.armRaw,storedTransition.controllerRevision
    );
    if(!dispatchGate.ok){
      return send(res,423,{
        ok:false,code:'ENTRY_EXECUTION_COMMIT_BLOCKED',reason:dispatchGate.reason,
        writeAttempted:false,plan,protection:exactOrder,
      });
    }
    const submittedIntent={
      ...storedTransition,state:'ENTRY_SUBMITTED',
      entryClientOrderId:plan.params.newClientOrderId,validatedAt:Date.now(),
    };
    const checkedSubmittedIntent=normalizeEntryTransition(submittedIntent,{now:Date.now()});
    if(!checkedSubmittedIntent.ok){
      return send(res,500,{
        ok:false,code:'ENTRY_TRANSITION_SUBMIT_STATE_INVALID',
        reason:checkedSubmittedIntent.reason,writeAttempted:false,ambiguous:false,
      });
    }

    // Write-ahead fence: persist the exact deterministic LIMIT identity before Binance POST.
    // If the engine dies after Binance accepts the order, reconciliation can still prove
    // that this exact LIMIT belongs to the prepared MAX-LOSS transition.
    await writeEntryTransition(commandId,checkedSubmittedIntent.transition);
    storedTransition=checkedSubmittedIntent.transition;
    await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
      at:Date.now(),kind:'BINANCE_ENTRY_ORDER_INTENT_COMMITTED',
      deviceId:master.deviceId,commandId,symbol,side,limitPrice,
      quantity:Number(plan.params.quantity),clientOrderId:plan.params.newClientOrderId,
      protectionClientAlgoId:storedTransition.protectionClientAlgoId,
    })]);
    await redis(['LTRIM',KEY_AUDIT,'0','199']);

    const result=await placeStandardOrderIdempotent({
      apiKey,secret,orderParams:plan.params,writesEnabled:true,timestamp:preflight.serverTime,
    });

    await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
      at:Date.now(),kind:'BINANCE_ENTRY_ORDER_DISPATCH',
      deviceId:master.deviceId,commandId,symbol,side,limitPrice,
      quantity:Number(plan.params.quantity),clientOrderId:plan.params.newClientOrderId,
      protectionIdentity:String(exactOrder?.clientAlgoId||exactOrder?.clientOrderId||exactOrder?.algoId||exactOrder?.orderId||''),
      disposition:result.disposition,writeAttempted:result.writeAttempted===true,
    })]);
    await redis(['LTRIM',KEY_AUDIT,'0','199']);
    return send(res,200,{
      ok:true,phase:'ENTRY_SUBMITTED',plan,protection:exactOrder,
      transition:storedTransition,result,confirmationRequired:true,
    });
  }catch(e){
    const retryAfter=binanceBackoffSecondsFromError(e);
    if(retryAfter>0){
      try{await registerBinanceWriteBackoff(redis,e)}catch{}
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{
        ok:false,
        code:Number(e?.status)===418?'BINANCE_IP_BANNED':'BINANCE_RATE_LIMITED',
        retryAfterSeconds:retryAfter,
        binanceStatus:Number(e?.status)||0,
        binanceCode:e?.binanceCode??(typeof e?.code==='number'?e.code:null),
        ambiguous:false,
        writeAttempted:e?.writeAttempted===true,
      });
    }
    const internalCode=String(e?.code||e?.message||'');
    const configFailure=/^BINANCE_(?:MARGIN_TYPE|LEVERAGE|SYMBOL_CONFIG)_/.test(internalCode);
    return send(res,502,{
      ok:false,
      code:e?.message==='ORDER_RESULT_AMBIGUOUS'?'ORDER_RESULT_AMBIGUOUS':configFailure?internalCode:'BINANCE_ENTRY_EXECUTION_FAILED',
      error:'Binance entry execution failed.',
      binanceCode:e?.binanceCode??(typeof e?.code==='number'?e.code:null),
      ambiguous:e?.ambiguous===true,
      writeAttempted:e?.writeAttempted===true||e?.message==='ORDER_RESULT_AMBIGUOUS',
    });
  }
}

export { entryReadinessReason };
