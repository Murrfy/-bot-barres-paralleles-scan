import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation } from '../lib/device-session.mjs';
import { buildExitOrderPlan } from '../lib/order-intent.mjs';
import { placeStandardOrderIdempotent, cancelEntryOrderIdempotent } from '../lib/binance-order-writer.mjs';
import { protectionOnlyMismatchTarget, protectiveRepairTarget } from '../lib/protective-command.mjs';

const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_STATE=`${PREFIX}:state`;
const KEY_RECONCILE_LAST=`${PREFIX}:reconcile:last`;
const KEY_AUDIT=`${PREFIX}:audit`;
const KEY_REAL_EXECUTION_ARMED=`${PREFIX}:safety:real-execution-armed`;
const KEY_MASTER_MODE=`${PREFIX}:master-mode`;
const DEPLOYMENT_SHA=String(process.env.VERCEL_GIT_COMMIT_SHA||'');

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
const VERCEL_PRODUCTION_WRITE_ALLOWED=!process.env.VERCEL_ENV||(process.env.VERCEL_ENV==='production'&&process.env.VERCEL_GIT_COMMIT_REF==='main');

function send(res,status,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function stableStringify(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(v=>v===undefined?'null':stableStringify(v)).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableStringify(value[k])).join(',')+'}';
}
async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN)throw new Error('UPSTASH_NOT_CONFIGURED');
  const r=await fetch(REDIS_URL,{
    method:'POST',
    headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify(command),
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
    let device=null;try{device=JSON.parse(raw)}catch{}
    if(!device?.deviceId||device.role!=='master')continue;
    const [registered,lease]=await Promise.all([
      redis(['GET',KEY_MASTER_DEVICE]),
      redis(['GET',KEY_MASTER]),
    ]);
    if(String(registered||'')!==String(device.deviceId))continue;
    if(String(lease||'')!==String(device.deviceId)){
      const e=new Error('MASTER_LEASE_REQUIRED');e.code='MASTER_LEASE_REQUIRED';throw e;
    }
    return device;
  }
  return null;
}
function direction(position){
  const explicit=String(position?.direction||'').toUpperCase();
  if(explicit==='LONG'||explicit==='SHORT')return explicit;
  return Number(position?.positionAmt||position?.quantity||0)<0?'SHORT':'LONG';
}
function quantity(position){return Math.abs(Number(position?.positionAmt??position?.quantity??0));}
function runtimePosition(runtimeState,symbol,dir){
  const list=Array.isArray(runtimeState?.data?.binancePositions)?runtimeState.data.binancePositions:[];
  return list.find(p=>String(p?.symbol||'').toUpperCase()===symbol&&direction(p)===dir)||null;
}
function runtimeEntryOrder(runtimeState,symbol,clientOrderId){
  const list=Array.isArray(runtimeState?.data?.binanceOrders)?runtimeState.data.binanceOrders:[];
  return list.find(o =>
    String(o?.orderClass||'STANDARD').toUpperCase()==='STANDARD' &&
    String(o?.symbol||'').toUpperCase()===symbol &&
    String(o?.clientOrderId||'')===clientOrderId
  )||null;
}
function validateExecutionArmRecord(record,masterDeviceId,deploymentSha=DEPLOYMENT_SHA){
  if(!deploymentSha)return 'REAL_EXECUTION_DEPLOYMENT_SHA_MISSING';
  if(!record||record.version!==1)return 'REAL_EXECUTION_NOT_ARMED';
  if(String(record.masterDeviceId||'')!==String(masterDeviceId||''))return 'REAL_EXECUTION_ARM_MASTER_CHANGED';
  if(String(record.deploymentSha||'')!==String(deploymentSha))return 'REAL_EXECUTION_ARM_DEPLOYMENT_CHANGED';
  return '';
}
function protectiveModeReason(mode){
  const normalized=String(mode||'').toUpperCase();
  if(normalized==='RUNNING'||normalized==='PAUSE_PENDING')return '';
  return 'MASTER_PAUSED';
}
function executionReadiness(runtimeState,report,masterDeviceId,repairTarget=''){
  const age=Date.now()-Number(runtimeState?.updatedAt||0);
  if(!runtimeState?.data||String(runtimeState?.masterDeviceId||'')!==String(masterDeviceId))return 'MASTER_RUNTIME_WRONG_DEVICE';
  if(!Number.isFinite(age)||age<0||age>30000)return 'MASTER_RUNTIME_STALE';
  const data=runtimeState.data;
  if(String(data.executionMode||data.mode||'').toUpperCase()!=='REAL')return 'MASTER_RUNTIME_NOT_REAL';
  const stream=data.userStream;
  if(!stream||stream.connected!==true||stream.ready!==true||stream.failClosed!==false||stream.needsReconciliation!==false)return 'USER_STREAM_NOT_READY';

  const reportAge=Date.now()-Number(report?.observedAt||0);
  if(!report||report.version!==2||!Array.isArray(report.reasons))return 'BINANCE_RECONCILIATION_MISMATCH';
  if(!Number.isFinite(reportAge)||reportAge<0||reportAge>10000)return 'BINANCE_RECONCILIATION_STALE';
  const currentDataHash=sha256(stableStringify(data));
  if(String(report.runtimeDataHash||'')!==currentDataHash)return 'BINANCE_RECONCILIATION_RUNTIME_CHANGED';

  const clean=report.status==='CLEAN_REAL'&&report.failClosed===false&&report.reasons.length===0;
  if(clean)return '';

  const target=String(repairTarget||'').toUpperCase();
  if(target&&protectionOnlyMismatchTarget(report)===target)return '';

  return 'BINANCE_RECONCILIATION_MISMATCH';
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});

  let master=null;
  try{master=await requireCurrentMaster(req)}
  catch(e){return send(res,e?.code==='MASTER_LEASE_REQUIRED'?409:503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR'})}
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED'});

  const apiKey=process.env.BINANCE_API_KEY;
  const secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV'});

  const [runtimeRaw,reportRaw,armRaw,masterModeRaw]=await Promise.all([
    redis(['GET',KEY_STATE]),
    redis(['GET',KEY_RECONCILE_LAST]),
    redis(['GET',KEY_REAL_EXECUTION_ARMED]),
    redis(['GET',KEY_MASTER_MODE]),
  ]);
  let runtimeState=null,report=null,armRecord=null;
  try{runtimeState=runtimeRaw?JSON.parse(runtimeRaw):null}catch{}
  try{report=reportRaw?JSON.parse(reportRaw):null}catch{}
  try{armRecord=armRaw?JSON.parse(armRaw):null}catch{}

  const armReason=validateExecutionArmRecord(armRecord,master.deviceId);
  if(armReason)return send(res,423,{ok:false,code:'EXECUTION_NOT_ARMED',reason:armReason,writeAttempted:false});
  const modeReason=protectiveModeReason(masterModeRaw);
  if(modeReason)return send(res,423,{ok:false,code:'EXECUTION_NOT_READY',reason:modeReason,writeAttempted:false});

  const type=String(req.body?.type||'').toUpperCase();
  if(!['EXEC_CLOSE_POSITION','EXEC_CANCEL_ENTRY'].includes(type)){
    return send(res,400,{ok:false,code:'PROTECTIVE_COMMAND_UNSUPPORTED',writeAttempted:false});
  }

  const repairTarget=protectiveRepairTarget(type,{
    symbol:req.body?.symbol,
    direction:req.body?.direction,
    closeAll:req.body?.closeAll,
  });
  const readinessReason=executionReadiness(runtimeState,report,master.deviceId,repairTarget);
  if(readinessReason)return send(res,423,{ok:false,code:'EXECUTION_NOT_READY',reason:readinessReason,writeAttempted:false});

  const writesEnabled=Boolean(REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED);

  if(type==='EXEC_CANCEL_ENTRY'){
    const symbol=String(req.body?.symbol||'').toUpperCase();
    const clientOrderId=String(req.body?.clientOrderId||'');
    const commandId=String(req.body?.commandId||'');
    if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!clientOrderId||clientOrderId.length>36){
      return send(res,400,{ok:false,code:'CANCEL_ENTRY_REQUEST_INVALID',writeAttempted:false});
    }
    const liveOrder=runtimeEntryOrder(runtimeState,symbol,clientOrderId);
    if(!liveOrder)return send(res,409,{ok:false,code:'ENTRY_ORDER_NOT_OPEN',writeAttempted:false});
    if(liveOrder.reduceOnly===true||liveOrder.reduceOnly==='true'){
      return send(res,409,{ok:false,code:'CANCEL_TARGET_IS_REDUCE_ONLY',writeAttempted:false});
    }
    if(String(liveOrder.positionSide||'BOTH').toUpperCase()!=='BOTH'){
      return send(res,409,{ok:false,code:'HEDGE_MODE_UNSUPPORTED',writeAttempted:false});
    }
    if(!writesEnabled){
      return send(res,423,{
        ok:false,code:'BINANCE_WRITE_LOCKED',
        realTradingEnabled:REAL_TRADING_ENABLED,
        binanceWriteEnabled:BINANCE_WRITE_ENABLED,
        pairingDisabled:PAIRING_DISABLED,
        writeAttempted:false,
      });
    }
    try{
      const result=await cancelEntryOrderIdempotent({
        apiKey,secret,symbol,clientOrderId,writesEnabled:true,timestamp:Date.now(),
      });
      await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
        at:Date.now(),kind:'BINANCE_ENTRY_CANCEL_DISPATCH',
        deviceId:master.deviceId,commandId,symbol,clientOrderId,
        disposition:result.disposition,writeAttempted:result.writeAttempted===true,
      })]);
      await redis(['LTRIM',KEY_AUDIT,'0','199']);
      return send(res,200,{ok:true,result});
    }catch(e){
      return send(res,502,{
        ok:false,
        code:['CANCEL_RESULT_AMBIGUOUS','CANCEL_TARGET_UNKNOWN'].includes(e?.message)?e.message:'BINANCE_ENTRY_CANCEL_FAILED',
        error:'Binance entry cancellation failed.',
        binanceCode:e?.code??null,
        ambiguous:e?.ambiguous===true,
        writeAttempted:true,
      });
    }
  }

  const symbol=String(req.body?.symbol||'').toUpperCase();
  const dir=String(req.body?.direction||'').toUpperCase();
  const requestedQty=Number(req.body?.quantity);
  const commandId=String(req.body?.commandId||'');
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!['LONG','SHORT'].includes(dir)||!(requestedQty>0)){
    return send(res,400,{ok:false,code:'PROTECTIVE_REQUEST_INVALID',writeAttempted:false});
  }

  const livePosition=runtimePosition(runtimeState,symbol,dir);
  const liveQty=quantity(livePosition);
  if(!livePosition||!(liveQty>0))return send(res,409,{ok:false,code:'POSITION_NOT_FOUND',writeAttempted:false});
  if(requestedQty>liveQty+1e-12)return send(res,409,{ok:false,code:'CLOSE_QUANTITY_EXCEEDS_POSITION',liveQuantity:liveQty,writeAttempted:false});
  if(Math.abs(requestedQty-liveQty)>1e-12)return send(res,409,{ok:false,code:'FULL_CLOSE_QUANTITY_REQUIRED',liveQuantity:liveQty,writeAttempted:false});
  if(String(livePosition.positionSide||'BOTH').toUpperCase()!=='BOTH'){
    return send(res,409,{ok:false,code:'HEDGE_MODE_UNSUPPORTED',writeAttempted:false});
  }

  const exitMode=String(req.body?.exitMode||'PROTECTIVE_IOC').toUpperCase();
  if(!['PROTECTIVE_IOC','MARKET_LAST_RESORT'].includes(exitMode)){
    return send(res,400,{ok:false,code:'EXIT_MODE_INVALID',writeAttempted:false});
  }

  let plan;
  try{
    plan=buildExitOrderPlan({
      commandId,
      symbol,
      direction:dir,
      quantity:requestedQty,
      exitMode,
      targetPrice:Number(req.body?.targetPrice||0),
      attempt:Number(req.body?.attempt||0),
      priceMatch:String(req.body?.priceMatch||'OPPONENT'),
    });
  }catch(e){
    return send(res,400,{ok:false,code:e?.message||'EXIT_PLAN_INVALID',writeAttempted:false});
  }

  if(!writesEnabled){
    return send(res,423,{
      ok:false,
      code:'BINANCE_WRITE_LOCKED',
      realTradingEnabled:REAL_TRADING_ENABLED,
      binanceWriteEnabled:BINANCE_WRITE_ENABLED,
      pairingDisabled:PAIRING_DISABLED,
      writeAttempted:false,
      plan,
    });
  }

  try{
    const result=await placeStandardOrderIdempotent({
      apiKey,
      secret,
      orderParams:plan.params,
      writesEnabled:true,
      timestamp:Date.now(),
    });
    await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
      at:Date.now(),
      kind:'BINANCE_PROTECTIVE_ORDER_DISPATCH',
      deviceId:master.deviceId,
      commandId,
      symbol,
      direction:dir,
      exitMode,
      priceMatch:String(plan.params.priceMatch||''),
      clientOrderId:plan.params.newClientOrderId,
      disposition:result.disposition,
      writeAttempted:result.writeAttempted===true,
      orderId:String(result.order?.orderId??''),
    })]);
    await redis(['LTRIM',KEY_AUDIT,'0','199']);
    return send(res,200,{ok:true,plan,result});
  }catch(e){
    return send(res,502,{
      ok:false,
      code:e?.message==='ORDER_RESULT_AMBIGUOUS'?'ORDER_RESULT_AMBIGUOUS':'BINANCE_PROTECTIVE_EXECUTION_FAILED',
      error:'Binance protective execution failed.',
      binanceCode:e?.code??null,
      ambiguous:e?.ambiguous===true,
      writeAttempted:true,
    });
  }
}

export { validateExecutionArmRecord, protectiveModeReason, executionReadiness };
