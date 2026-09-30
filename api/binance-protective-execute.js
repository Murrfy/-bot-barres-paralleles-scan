import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation, deviceSessionRecordActive, roleAssignmentKey, deviceRoleAssignmentActive, engineInstanceHeader, enginePrincipalInstanceActive } from '../lib/device-session.mjs';
import { buildExitOrderPlan } from '../lib/order-intent.mjs';
import { placeStandardOrderIdempotent, cancelEntryOrderIdempotent, signedBinanceRequest, queryOrderByClientId } from '../lib/binance-order-writer.mjs';
import {
  protectionOnlyMismatchTarget,
  protectiveRepairTarget,
  pendingEntryCancelRecoveryAllowed,
  pendingEntryPartialFillFlatTargets,
  pendingEntryPartialFillExitStartedTargets,
  persistedSaleRemainderRecoveryAllowed,
  triggeredProgressiveRemainderRecoveryAllowed,
  triggeredMaxLossRemainderRecoveryAllowed,
  maxLossLocalQuarantineReport,
  maxLossSymbolQuarantine,
} from '../lib/protective-command.mjs';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';
import { readBinanceWriteBackoff, registerBinanceWriteBackoff, binanceBackoffSecondsFromError } from '../lib/binance-write-backoff.mjs';
import { revalidateBinanceTradingApiPermissions } from '../lib/binance-api-permissions.mjs';

const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_STATE=`${PREFIX}:state`;
const KEY_RECONCILE_LAST=`${PREFIX}:reconcile:last`;
const KEY_AUDIT=`${PREFIX}:audit`;
const KEY_REAL_EXECUTION_ARMED=`${PREFIX}:safety:real-execution-armed`;
const KEY_MASTER_MODE=`${PREFIX}:master-mode`;
const KEY_SALE_REMAINDER_RECOVERIES=`${PREFIX}:sale-remainder-recoveries`;
const KEY_ENTRY_TRANSITIONS=`${PREFIX}:entry-transitions`;
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
const VERCEL_PRODUCTION_WRITE_ALLOWED=process.env.VERCEL_ENV==='production'&&process.env.VERCEL_GIT_COMMIT_REF==='main';

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
    signal: AbortSignal.timeout(8000),
    cache:'no-store',
  });
  const text=await r.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok||data?.error)throw new Error(data?.error||`Redis HTTP ${r.status}`);
  return data?.result;
}
async function clearPartialEntryTransitionAfterCertifiedFlat(target){
  const script=[
    "local raw = redis.call('HGET', KEYS[1], ARGV[1])",
    "if not raw then return 0 end",
    "local ok, value = pcall(cjson.decode, raw)",
    "if not ok then return -1 end",
    "if string.upper(tostring(value.state or '')) ~= 'ENTRY_SUBMITTED' then return -2 end",
    "if string.upper(tostring(value.symbol or '')) ~= ARGV[2] then return -3 end",
    "if tostring(value.entryClientOrderId or '') ~= ARGV[3] then return -4 end",
    "if tostring(value.protectionClientAlgoId or '') ~= ARGV[4] then return -5 end",
    "redis.call('HDEL', KEYS[1], ARGV[1])",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL',script,'1',KEY_ENTRY_TRANSITIONS,
    String(target.commandId),String(target.symbol),
    String(target.entryClientOrderId),String(target.protectionClientAlgoId),
  ]));
}

async function requireCurrentMaster(req){
  for(const token of deviceTokenCandidates(req)){
    const tokenHash=sha256(token);
    const raw=await redis(['GET',`${PREFIX}:device:${tokenHash}`]);
    if(!raw)continue;
    let device=null;try{device=JSON.parse(raw)}catch{}
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
    return {...device,roleIssuedAt:String(issuedAt||'0')};
  }
  return null;
}

async function finalProtectiveMasterGate(master){
  const expectedMaster=String(master?.deviceId||'');
  const expectedRoleEpoch=String(master?.roleIssuedAt||'0');
  const script=[
    "local lease = tostring(redis.call('GET', KEYS[1]) or '')",
    "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
    "if lease ~= ARGV[1] or registered ~= ARGV[1] then return -1 end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[3]) or '0')",
    "if roleEpoch ~= ARGV[2] then return -2 end",
    "local mode = tostring(redis.call('GET', KEYS[4]) or 'PAUSED')",
    "if mode == 'PAUSED' then return -3 end",
    "return 1"
  ].join('\n');
  const result=Number(await redis([
    'EVAL',script,'4',
    KEY_MASTER,
    KEY_MASTER_DEVICE,
    roleAssignmentKey(PREFIX,'master'),
    KEY_MASTER_MODE,
    expectedMaster,
    expectedRoleEpoch,
  ]));
  return {
    ok:result===1,
    reason:result===-1
      ?'MASTER_LEASE_REQUIRED'
      :result===-2
        ?'MASTER_ROLE_CHANGED'
        :result===-3
          ?'MASTER_PAUSED'
          :'PROTECTIVE_FINAL_GATE_FAILED'
  };
}

async function requireFinalProtectiveMaster(res,master){
  let gate=null;
  try{gate=await finalProtectiveMasterGate(master)}
  catch{return send(res,503,{ok:false,code:'PROTECTIVE_FINAL_GATE_UNAVAILABLE',writeAttempted:false}),false}
  if(gate.ok)return true;
  send(res,gate.reason==='MASTER_PAUSED'?423:409,{ok:false,code:gate.reason,writeAttempted:false});
  return false;
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
function sameQuantity(a,b){
  const x=Number(a),y=Number(b);
  return Number.isFinite(x)&&Number.isFinite(y)&&
    Math.abs(x-y)<=Math.max(1e-12,Math.abs(y)*1e-10);
}
function partialTargetRemainderProof(runtimeState,payload={}){
  const symbol=String(payload?.symbol||'').toUpperCase();
  const dir=String(payload?.direction||'').toUpperCase();
  const requestedQty=Number(payload?.quantity);
  const clientOrderId=String(payload?.previousClientOrderId||'');
  if(String(payload?.recoveryReason||'').toUpperCase()!=='PARTIAL_TARGET_REMAINDER')return null;
  if(String(payload?.exitMode||'').toUpperCase()!=='REMAINDER_MARKET')return null;
  if(!/^zth-EXI-[A-Za-z0-9._:-]+$/.test(clientOrderId)||clientOrderId.length>36)return null;
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!['LONG','SHORT'].includes(dir)||!(requestedQty>0))return null;
  const order=runtimeEntryOrder(runtimeState,symbol,clientOrderId);
  if(!order)return null;
  const expectedSide=dir==='LONG'?'SELL':'BUY';
  const original=Number(order?.origQty);
  const executed=Number(order?.executedQty);
  const remaining=original-executed;
  if(String(order?.side||'').toUpperCase()!==expectedSide||
     String(order?.positionSide||'BOTH').toUpperCase()!=='BOTH'||
     String(order?.type||'').toUpperCase()!=='LIMIT'||
     String(order?.timeInForce||'').toUpperCase()!=='GTC'||
     !(order?.reduceOnly===true||order?.reduceOnly==='true')||
     order?.closePosition===true||order?.closePosition==='true'||
     !(original>0)||!(executed>0)||!(remaining>0)||
     !sameQuantity(remaining,requestedQty)){
    return null;
  }
  return {order,remaining,executed,original};
}
async function incompleteProtectiveCloseRemainderProof({apiKey,secret,payload={}}={}){
  if(String(payload?.recoveryReason||'').toUpperCase()!=='INCOMPLETE_PROTECTIVE_CLOSE_REMAINDER')return null;
  if(String(payload?.exitMode||'').toUpperCase()!=='REMAINDER_MARKET')return null;

  const symbol=String(payload?.symbol||'').toUpperCase();
  const dir=String(payload?.direction||'').toUpperCase();
  const commandId=String(payload?.commandId||'');
  const requestedQty=Number(payload?.quantity);
  const clientOrderId=String(payload?.previousClientOrderId||'');
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!['LONG','SHORT'].includes(dir)||
     !/^[A-Za-z0-9._:-]{8,128}$/.test(commandId)||
     !/^zth-EXI-[A-Za-z0-9._:-]+$/.test(clientOrderId)||clientOrderId.length>36||
     !(requestedQty>0))return null;

  const order=await queryOrderByClientId({
    apiKey,secret,symbol,clientOrderId,timestamp:Date.now(),
  });
  const original=Number(order?.origQty);
  const executed=Number(order?.executedQty);
  const remaining=original-executed;
  const expectedSide=dir==='LONG'?'SELL':'BUY';
  const status=String(order?.status||'').toUpperCase();
  if(String(order?.symbol||'').toUpperCase()!==symbol||
     String(order?.clientOrderId||'')!==clientOrderId||
     String(order?.side||'').toUpperCase()!==expectedSide||
     String(order?.positionSide||'BOTH').toUpperCase()!=='BOTH'||
     String(order?.type||'').toUpperCase()!=='LIMIT'||
     String(order?.timeInForce||'').toUpperCase()!=='IOC'||
     !(order?.reduceOnly===true||order?.reduceOnly==='true')||
     order?.closePosition===true||order?.closePosition==='true'||
     String(order?.priceMatch||'').toUpperCase()!=='OPPONENT'||
     !['EXPIRED','EXPIRED_IN_MATCH','CANCELED'].includes(status)||
     !(original>0)||!(executed>=0)||executed>=original||!(remaining>0)||
     !sameQuantity(remaining,requestedQty)){
    return null;
  }

  const expected=buildExitOrderPlan({
    commandId,symbol,direction:dir,quantity:original,
    exitMode:'PROTECTIVE_IOC',attempt:0,priceMatch:'OPPONENT',
  });
  if(String(expected?.params?.newClientOrderId||'')!==clientOrderId)return null;

  const live=await liveBinancePositionQuantity({apiKey,secret,symbol,direction:dir});
  if(!sameQuantity(live,requestedQty))return null;
  return {order,original,executed,remaining,status};
}

async function liveBinancePositionQuantity({apiKey,secret,symbol,direction:dir}){
  const rows=await signedBinanceRequest({
    path:'/fapi/v3/positionRisk',method:'GET',apiKey,secret,timestamp:Date.now(),
    params:{symbol},
  });
  const list=Array.isArray(rows)?rows:[rows];
  const row=list.find(item=>
    String(item?.symbol||'').toUpperCase()===symbol&&
    String(item?.positionSide||'BOTH').toUpperCase()==='BOTH'&&
    quantity(item)>0&&direction(item)===dir
  );
  return row?quantity(row):0;
}
function saleRemainderField(symbol,dir){
  const s=String(symbol||'').toUpperCase();
  const d=String(dir||'').toUpperCase();
  return /^[A-Z0-9]{3,30}$/.test(s)&&['LONG','SHORT'].includes(d)?s+':'+d:'';
}
function validSaleRemainderRecord(row){
  if(!row||typeof row!=='object'||Array.isArray(row)||row.version!==1)return false;
  const symbol=String(row.symbol||'').toUpperCase();
  const dir=String(row.direction||'').toUpperCase();
  const commandId=String(row.commandId||'');
  const sourceReason=String(row.sourceReason||'').toUpperCase();
  const initialQuantity=Number(row.initialQuantity);
  const attemptQuantity=Number(row.attemptQuantity);
  const nextAttempt=Math.floor(Number(row.nextAttempt));
  if(!saleRemainderField(symbol,dir)||
     !/^[A-Za-z0-9._:-]{8,128}$/.test(commandId)||
     !['PARTIAL_TARGET_REMAINDER','TRIGGERED_PROGRESSIVE_REMAINDER','TRIGGERED_MAX_LOSS_REMAINDER','INCOMPLETE_PROTECTIVE_CLOSE_REMAINDER'].includes(sourceReason)||
     !(initialQuantity>0)||!(attemptQuantity>0)||attemptQuantity>initialQuantity+1e-12||
     nextAttempt<0||nextAttempt>3)return false;
  if(sourceReason==='PARTIAL_TARGET_REMAINDER'||sourceReason==='INCOMPLETE_PROTECTIVE_CLOSE_REMAINDER'){
    const id=String(row.previousClientOrderId||'');
    if(!/^zth-EXI-[A-Za-z0-9._:-]+$/.test(id)||id.length>36)return false;
  }else{
    const algo=String(row.clientAlgoId||'');
    const actual=String(row.actualOrderId||'');
    const pattern=sourceReason==='TRIGGERED_MAX_LOSS_REMAINDER'
      ?/^zth-MAX-[A-Za-z0-9._:-]+$/
      :/^zth-PRO-[A-Za-z0-9._:-]+$/;
    if(!pattern.test(algo)||algo.length>36||!actual)return false;
  }
  return true;
}
function saleRemainderSource({
  reqBody={},partialTargetRemainder=null,progressiveRemainderRecovery=false,
  maxLossRemainderRecovery=false,incompleteProtectiveRemainder=null
}={}){
  const sourceReason=String(reqBody?.recoveryReason||'').toUpperCase();
  const row={
    version:1,
    commandId:String(reqBody?.commandId||''),
    symbol:String(reqBody?.symbol||'').toUpperCase(),
    direction:String(reqBody?.direction||'').toUpperCase(),
    sourceReason,
    initialQuantity:Number(reqBody?.quantity),
    attemptQuantity:Number(reqBody?.quantity),
    nextAttempt:0,
    previousClientOrderId:String(reqBody?.previousClientOrderId||''),
    clientAlgoId:String(reqBody?.clientAlgoId||''),
    actualOrderId:String(reqBody?.actualOrderId||''),
    createdAt:Date.now(),
    updatedAt:Date.now(),
    expiresAt:Date.now()+60*60*1000,
  };
  if(sourceReason==='PARTIAL_TARGET_REMAINDER'&&!partialTargetRemainder)return null;
  if(sourceReason==='TRIGGERED_PROGRESSIVE_REMAINDER'&&progressiveRemainderRecovery!==true)return null;
  if(sourceReason==='TRIGGERED_MAX_LOSS_REMAINDER'&&maxLossRemainderRecovery!==true)return null;
  if(sourceReason==='INCOMPLETE_PROTECTIVE_CLOSE_REMAINDER'&&!incompleteProtectiveRemainder)return null;
  return validSaleRemainderRecord(row)?row:null;
}
async function beginSaleRemainderRecovery(row){
  if(!validSaleRemainderRecord(row))throw new Error('SALE_REMAINDER_STATE_INVALID');
  const field=saleRemainderField(row.symbol,row.direction);
  const script=[
    "local raw = redis.call('HGET', KEYS[1], ARGV[1])",
    "if raw then",
    "  local ok, value = pcall(cjson.decode, raw)",
    "  if not ok then return {'ERR','INVALID'} end",
    "  if tonumber(value.expiresAt or 0) < tonumber(ARGV[5]) then",
    "    redis.call('HDEL', KEYS[1], ARGV[1])",
    "  else",
    "    if tostring(value.commandId or '') ~= ARGV[2] then return {'ERR','CONFLICT'} end",
    "    if string.upper(tostring(value.sourceReason or '')) ~= ARGV[3] then return {'ERR','CONFLICT'} end",
    "    return {'OK',raw}",
    "  end",
    "end",
    "redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])",
    "redis.call('EXPIRE', KEYS[1], 7200)",
    "return {'OK',ARGV[4]}"
  ].join('\n');
  const result=await redis([
    'EVAL',script,'1',KEY_SALE_REMAINDER_RECOVERIES,
    field,String(row.commandId),String(row.sourceReason),JSON.stringify(row),String(Date.now()),
  ]);
  if(!Array.isArray(result)||String(result[0])!=='OK'){
    throw new Error(String(result?.[1]||'SALE_REMAINDER_STATE_CONFLICT'));
  }
  let stored=null;try{stored=JSON.parse(String(result[1]||''))}catch{}
  if(!validSaleRemainderRecord(stored))throw new Error('SALE_REMAINDER_STATE_INVALID');
  return stored;
}
async function loadSaleRemainderRecovery(symbol,dir){
  const field=saleRemainderField(symbol,dir);
  if(!field)return null;
  const raw=await redis(['HGET',KEY_SALE_REMAINDER_RECOVERIES,field]);
  if(!raw)return null;
  let row=null;try{row=JSON.parse(String(raw))}catch{}
  return validSaleRemainderRecord(row)?row:null;
}
async function advanceSaleRemainderRecovery(row,remainingQuantity){
  const remaining=Number(remainingQuantity);
  if(!validSaleRemainderRecord(row)||!(remaining>0))throw new Error('SALE_REMAINDER_ADVANCE_INVALID');
  const field=saleRemainderField(row.symbol,row.direction);
  const next={...row,
    nextAttempt:Number(row.nextAttempt)+1,
    attemptQuantity:remaining,
    updatedAt:Date.now(),
    expiresAt:Date.now()+60*60*1000,
  };
  if(!validSaleRemainderRecord(next))throw new Error('SALE_REMAINDER_ATTEMPTS_EXHAUSTED');
  const script=[
    "local raw = redis.call('HGET', KEYS[1], ARGV[1])",
    "if not raw then return 0 end",
    "local ok, value = pcall(cjson.decode, raw)",
    "if not ok then return -1 end",
    "if tostring(value.commandId or '') ~= ARGV[2] then return -2 end",
    "if tonumber(value.nextAttempt or -1) ~= tonumber(ARGV[3]) then return -3 end",
    "if tostring(value.attemptQuantity or '') ~= ARGV[4] then return -4 end",
    "redis.call('HSET', KEYS[1], ARGV[1], ARGV[5])",
    "redis.call('EXPIRE', KEYS[1], 7200)",
    "return 1"
  ].join('\n');
  const result=Number(await redis([
    'EVAL',script,'1',KEY_SALE_REMAINDER_RECOVERIES,field,
    String(row.commandId),String(row.nextAttempt),String(row.attemptQuantity),JSON.stringify(next),
  ]));
  if(result!==1)throw new Error('SALE_REMAINDER_STATE_CHANGED');
  return next;
}
async function clearSaleRemainderRecovery(row){
  if(!validSaleRemainderRecord(row))return false;
  const field=saleRemainderField(row.symbol,row.direction);
  const script=[
    "local raw = redis.call('HGET', KEYS[1], ARGV[1])",
    "if not raw then return 0 end",
    "local ok, value = pcall(cjson.decode, raw)",
    "if not ok or tostring(value.commandId or '') ~= ARGV[2] then return -1 end",
    "redis.call('HDEL', KEYS[1], ARGV[1])",
    "return 1"
  ].join('\n');
  return Number(await redis(['EVAL',script,'1',KEY_SALE_REMAINDER_RECOVERIES,field,String(row.commandId)]))===1;
}
function marketAttemptIdentityMatches(order,plan){
  const expected=plan?.params||{};
  const same=(a,b)=>{
    const x=Number(a),y=Number(b);
    return Number.isFinite(x)&&Number.isFinite(y)&&
      Math.abs(x-y)<=Math.max(1e-12,Math.abs(y)*1e-10);
  };
  return Boolean(
    order&&
    String(order?.symbol||'').toUpperCase()===String(expected.symbol||'').toUpperCase()&&
    String(order?.clientOrderId||'')===String(expected.newClientOrderId||'')&&
    String(order?.side||'').toUpperCase()===String(expected.side||'').toUpperCase()&&
    String(order?.positionSide||'BOTH').toUpperCase()==='BOTH'&&
    String(order?.type||'').toUpperCase()==='MARKET'&&
    (order?.reduceOnly===true||order?.reduceOnly==='true')&&
    same(order?.origQty??order?.quantity,expected.quantity)
  );
}

async function waitMarketAttemptTerminal({apiKey,secret,symbol,clientOrderId,initialOrder}){
  let order=initialOrder||null;
  for(let i=0;i<5;i++){
    const status=String(order?.status||'').toUpperCase();
    if(['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status))return order;
    if(i<4){
      await new Promise(resolve=>setTimeout(resolve,100));
      order=await queryOrderByClientId({
        apiKey,secret,symbol,clientOrderId,timestamp:Date.now(),
      });
    }
  }
  return order;
}
function certifiedReportPosition(report,symbol,dir){
  const list=Array.isArray(report?.certifiedPositions)?report.certifiedPositions:[];
  return list.find(p=>
    String(p?.symbol||'').toUpperCase()===symbol&&direction(p)===dir&&quantity(p)>0
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
function executionReadiness(
  runtimeState,report,masterDeviceId,repairTarget='',
  pendingEntryCancelRecovery=false,maxLossRemainderRecovery=false,
  executionTarget='',quarantineOperationAllowed=false,
  partialTargetRemainderRecovery=false,progressiveRemainderRecovery=false,
  persistedSaleRemainderRecovery=false
){
  const age=Date.now()-Number(runtimeState?.updatedAt||0);
  if(!runtimeState?.data||String(runtimeState?.masterDeviceId||'')!==String(masterDeviceId))return 'MASTER_RUNTIME_WRONG_DEVICE';
  if(!Number.isFinite(age)||age<0||age>30000)return 'MASTER_RUNTIME_STALE';
  const data=runtimeState.data;
  if(String(data.executionMode||data.mode||'').toUpperCase()!=='REAL')return 'MASTER_RUNTIME_NOT_REAL';
  const stream=data.userStream;
  if(!stream||stream.connected!==true)return 'USER_STREAM_NOT_READY';
  if(pendingEntryCancelRecovery!==true&&maxLossRemainderRecovery!==true&&
     partialTargetRemainderRecovery!==true&&progressiveRemainderRecovery!==true&&
     persistedSaleRemainderRecovery!==true&&
     (stream.ready!==true||stream.failClosed!==false||stream.needsReconciliation!==false)){
    return 'USER_STREAM_NOT_READY';
  }

  const reportAge=Date.now()-Number(report?.observedAt||0);
  if(!report||report.version!==2||!Array.isArray(report.reasons))return 'BINANCE_RECONCILIATION_MISMATCH';
  if(!Number.isFinite(reportAge)||reportAge<0||reportAge>10000)return 'BINANCE_RECONCILIATION_STALE';
  const currentDataHash=sha256(stableStringify(data));
  if(String(report.runtimeDataHash||'')!==currentDataHash)return 'BINANCE_RECONCILIATION_RUNTIME_CHANGED';

  const clean=report.status==='CLEAN_REAL'&&report.failClosed===false&&report.reasons.length===0;
  if(clean)return '';

  if(pendingEntryCancelRecovery===true||maxLossRemainderRecovery===true||
     partialTargetRemainderRecovery===true||progressiveRemainderRecovery===true||
     persistedSaleRemainderRecovery===true)return '';

  const repair=String(repairTarget||'').toUpperCase();
  if(repair&&protectionOnlyMismatchTarget(report)===repair)return '';

  if(maxLossLocalQuarantineReport(report)){
    const target=String(executionTarget||'').toUpperCase();
    if(!target)return 'EXECUTION_TARGET_REQUIRED';
    const [symbol,direction='']=target.split(':');
    const quarantine=maxLossSymbolQuarantine(report,symbol,direction);
    if(quarantine&&quarantineOperationAllowed!==true)return 'SYMBOL_MAX_LOSS_QUARANTINED';
    return '';
  }

  return 'BINANCE_RECONCILIATION_MISMATCH';
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});
  const bodyStatus=requestBodyStatus(req,64*1024);
  if(!bodyStatus.ok)return send(res,413,{ok:false,code:'REQUEST_BODY_TOO_LARGE',maxBytes:bodyStatus.maxBytes,writeAttempted:false});

  let master=null;
  try{master=await requireCurrentMaster(req)}
  catch(e){return send(res,(e?.code==='MASTER_LEASE_REQUIRED'||e?.code==='ENGINE_INSTANCE_FENCED')?409:503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR'})}
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED'});

  const apiKey=process.env.BINANCE_TRADING_API_KEY;
  const secret=process.env.BINANCE_TRADING_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'BINANCE_TRADING_CREDENTIALS_MISSING'});

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

  const permissionStatus=await revalidateBinanceTradingApiPermissions(apiKey,secret);
  if(!permissionStatus.ok){
    return send(
      res,
      permissionStatus.code==='BINANCE_API_PERMISSION_REVALIDATION_BLOCKED'?423:503,
      {
        ok:false,
        code:permissionStatus.code,
        ...(permissionStatus.blockers?.length?{blockers:permissionStatus.blockers}:{}),
        writeAttempted:false,
      }
    );
  }

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
  const pendingEntryCancelRecovery=type==='EXEC_CANCEL_ENTRY'&&pendingEntryCancelRecoveryAllowed(report,{
    symbol:req.body?.symbol,
    clientOrderId:req.body?.clientOrderId,
  });
  const partialEntryFlatTarget=type==='EXEC_CANCEL_ENTRY'
    ?pendingEntryPartialFillFlatTargets(report).find(row=>
      row.symbol===String(req.body?.symbol||'').toUpperCase()&&
      row.entryClientOrderId===String(req.body?.clientOrderId||'')
    )||null
    :null;
  const partialEntryExitStartedTarget=type==='EXEC_CANCEL_ENTRY'
    ?pendingEntryPartialFillExitStartedTargets(report).find(row=>
      row.symbol===String(req.body?.symbol||'').toUpperCase()&&
      row.entryClientOrderId===String(req.body?.clientOrderId||'')
    )||null
    :null;
  const partialEntryCancelTarget=partialEntryFlatTarget||partialEntryExitStartedTarget;
  if(pendingEntryCancelRecovery&&String(master?.principal||'')!=='engine'){
    return send(res,423,{
      ok:false,
      code:partialEntryFlatTarget
        ?'ENTRY_PARTIAL_FILL_FLAT_RECOVERY_ENGINE_REQUIRED'
        :partialEntryExitStartedTarget
          ?'ENTRY_PARTIAL_FILL_EXIT_STARTED_RECOVERY_ENGINE_REQUIRED'
          :'ENTRY_PROTECTION_RECOVERY_ENGINE_REQUIRED',
      writeAttempted:false
    });
  }
  const maxLossRemainderRecovery=type==='EXEC_CLOSE_POSITION'&&
    triggeredMaxLossRemainderRecoveryAllowed(report,req.body);
  if(maxLossRemainderRecovery&&String(master?.principal||'')!=='engine'){
    return send(res,423,{ok:false,code:'MAX_LOSS_REMAINDER_RECOVERY_ENGINE_REQUIRED',writeAttempted:false});
  }
  const progressiveRemainderRecovery=type==='EXEC_CLOSE_POSITION'&&
    triggeredProgressiveRemainderRecoveryAllowed(report,req.body);
  if(progressiveRemainderRecovery&&String(master?.principal||'')!=='engine'){
    return send(res,423,{ok:false,code:'PROGRESSIVE_REMAINDER_RECOVERY_ENGINE_REQUIRED',writeAttempted:false});
  }
  const persistedRemainderRecovery=type==='EXEC_CLOSE_POSITION'&&
    persistedSaleRemainderRecoveryAllowed(report,req.body);
  if(persistedRemainderRecovery&&String(master?.principal||'')!=='engine'){
    return send(res,423,{ok:false,code:'PERSISTED_SALE_REMAINDER_ENGINE_REQUIRED',writeAttempted:false});
  }
  const partialTargetRemainder=type==='EXEC_CLOSE_POSITION'
    ?partialTargetRemainderProof(runtimeState,req.body)
    :null;
  if(partialTargetRemainder&&String(master?.principal||'')!=='engine'){
    return send(res,423,{ok:false,code:'PARTIAL_TARGET_REMAINDER_ENGINE_REQUIRED',writeAttempted:false});
  }

  let incompleteProtectiveRemainder=null;
  if(type==='EXEC_CLOSE_POSITION'&&
     String(req.body?.recoveryReason||'').toUpperCase()==='INCOMPLETE_PROTECTIVE_CLOSE_REMAINDER'){
    try{
      incompleteProtectiveRemainder=await incompleteProtectiveCloseRemainderProof({
        apiKey,secret,payload:req.body,
      });
    }catch(e){
      return send(res,503,{
        ok:false,code:'INCOMPLETE_PROTECTIVE_REMAINDER_PROOF_UNAVAILABLE',
        binanceCode:e?.code??null,writeAttempted:false,
      });
    }
    if(!incompleteProtectiveRemainder){
      return send(res,423,{ok:false,code:'INCOMPLETE_PROTECTIVE_REMAINDER_PROOF_REQUIRED',writeAttempted:false});
    }
    if(String(master?.principal||'')!=='engine'){
      return send(res,423,{ok:false,code:'INCOMPLETE_PROTECTIVE_REMAINDER_ENGINE_REQUIRED',writeAttempted:false});
    }
  }
  const executionSymbol=String(req.body?.symbol||'').toUpperCase();
  const executionDirection=String(req.body?.direction||'').toUpperCase();
  const executionTarget=['LONG','SHORT'].includes(executionDirection)
    ?executionSymbol+':'+executionDirection
    :executionSymbol;
  const quarantineOperationAllowed=
    type==='EXEC_CANCEL_ENTRY'||type==='EXEC_CLOSE_POSITION'||
    pendingEntryCancelRecovery||maxLossRemainderRecovery||progressiveRemainderRecovery||
    persistedRemainderRecovery||Boolean(partialTargetRemainder);
  const readinessReason=executionReadiness(
    runtimeState,report,master.deviceId,repairTarget,pendingEntryCancelRecovery,maxLossRemainderRecovery,
    executionTarget,quarantineOperationAllowed,Boolean(partialTargetRemainder),progressiveRemainderRecovery,
    persistedRemainderRecovery
  );
  if(readinessReason)return send(res,423,{ok:false,code:'EXECUTION_NOT_READY',reason:readinessReason,writeAttempted:false});

  const writesEnabled=Boolean(REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED);

  if(type==='EXEC_CANCEL_ENTRY'){
    const symbol=String(req.body?.symbol||'').toUpperCase();
    const clientOrderId=String(req.body?.clientOrderId||'');
    const commandId=String(req.body?.commandId||'');
    if(partialEntryCancelTarget&&commandId!==partialEntryCancelTarget.commandId){
      return send(res,409,{
        ok:false,
        code:partialEntryExitStartedTarget
          ?'ENTRY_PARTIAL_FILL_EXIT_STARTED_COMMAND_MISMATCH'
          :'ENTRY_PARTIAL_FILL_FLAT_COMMAND_MISMATCH',
        writeAttempted:false
      });
    }
    if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!/^zth-ENT-[a-f0-9]{24}$/i.test(clientOrderId)){
      return send(res,400,{ok:false,code:'CANCEL_TARGET_NOT_ZENITH_ENTRY',writeAttempted:false});
    }
    const liveOrder=runtimeEntryOrder(runtimeState,symbol,clientOrderId);
    if(!liveOrder)return send(res,409,{ok:false,code:'ENTRY_ORDER_NOT_OPEN',writeAttempted:false});
    if(String(liveOrder.side||'').toUpperCase()!=='BUY'){
      return send(res,409,{ok:false,code:'CANCEL_TARGET_NOT_BUY',writeAttempted:false});
    }
    if(String(liveOrder.type||'').toUpperCase()!=='LIMIT'){
      return send(res,409,{ok:false,code:'CANCEL_TARGET_NOT_LIMIT',writeAttempted:false});
    }
    if(String(liveOrder.timeInForce||'').toUpperCase()!=='GTC'){
      return send(res,409,{ok:false,code:'CANCEL_TARGET_NOT_GTC',writeAttempted:false});
    }
    if(partialEntryCancelTarget){
      const original=Number(liveOrder?.origQty);
      const executed=Number(liveOrder?.executedQty);
      const remaining=original-executed;
      if(String(liveOrder.status||'').toUpperCase()!=='PARTIALLY_FILLED'||
         !(original>0)||!(executed>0)||!(remaining>0)||
         !sameQuantity(original,partialEntryCancelTarget.quantity)||
         !sameQuantity(executed,partialEntryCancelTarget.executedQuantity)||
         !sameQuantity(remaining,partialEntryCancelTarget.remainingQuantity)){
        return send(res,409,{
          ok:false,
          code:partialEntryExitStartedTarget
            ?'ENTRY_PARTIAL_FILL_EXIT_STARTED_RUNTIME_MISMATCH'
            :'ENTRY_PARTIAL_FILL_FLAT_RUNTIME_MISMATCH',
          writeAttempted:false
        });
      }
    }
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
    if(partialEntryExitStartedTarget){
      try{
        const directOrder=await queryOrderByClientId({
          apiKey,secret,symbol,clientOrderId,timestamp:Date.now(),
        });
        const directStatus=String(directOrder?.status||'').toUpperCase();
        if(directStatus==='FILLED'){
          return send(res,200,{
            ok:true,result:{order:directOrder,disposition:'ALREADY_FILLED',writeAttempted:false},
            partialFillExitStartedRecovery:true,fillRace:true,transitionCleared:false,
          });
        }
        const original=Number(directOrder?.origQty);
        const executed=Number(directOrder?.executedQty);
        const remaining=original-executed;
        if(directStatus!=='PARTIALLY_FILLED'||
           !(original>0)||!(executed>0)||!(remaining>0)||
           !sameQuantity(original,partialEntryExitStartedTarget.quantity)||
           executed+Math.max(1e-12,Math.abs(executed)*1e-10)<
             Number(partialEntryExitStartedTarget.executedQuantity)){
          return send(res,409,{
            ok:false,code:'ENTRY_PARTIAL_FILL_EXIT_STARTED_DIRECT_ORDER_CHANGED',
            writeAttempted:false
          });
        }
        const directLiveQty=await liveBinancePositionQuantity({
          apiKey,secret,symbol,direction:partialEntryExitStartedTarget.direction,
        });
        const tolerance=Math.max(1e-12,Math.abs(executed)*1e-10);
        if(!(directLiveQty>0)||!(directLiveQty<executed-tolerance)){
          return send(res,409,{
            ok:false,code:'ENTRY_PARTIAL_FILL_EXIT_STARTED_DIRECT_PROOF_CHANGED',
            liveQuantity:directLiveQty,executedQuantity:executed,writeAttempted:false
          });
        }
      }catch(e){
        return send(res,503,{
          ok:false,code:'ENTRY_PARTIAL_FILL_EXIT_STARTED_PROOF_UNAVAILABLE',
          binanceCode:e?.code??null,writeAttempted:false
        });
      }
    }

    if(!(await requireFinalProtectiveMaster(res,master)))return;
    try{
      const result=await cancelEntryOrderIdempotent({
        apiKey,secret,symbol,clientOrderId,writesEnabled:true,timestamp:Date.now(),
      });
      await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
        at:Date.now(),kind:'BINANCE_ENTRY_CANCEL_DISPATCH',
        deviceId:master.deviceId,commandId,symbol,clientOrderId,
        disposition:result.disposition,writeAttempted:result.writeAttempted===true,
        recoveryKind:partialEntryFlatTarget
          ?'PARTIAL_FILL_FLAT'
          :partialEntryExitStartedTarget
            ?'PARTIAL_FILL_EXIT_STARTED'
            :'PROTECTION_LOSS',
      })]);
      await redis(['LTRIM',KEY_AUDIT,'0','199']);

      if(partialEntryExitStartedTarget){
        const status=String(result?.order?.status||'').toUpperCase();
        const disposition=String(result?.disposition||'').toUpperCase();
        if(status==='FILLED'||disposition==='ALREADY_FILLED'){
          return send(res,200,{
            ok:true,result,partialFillExitStartedRecovery:true,
            fillRace:true,transitionCleared:false,
          });
        }
        const terminal=['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status);
        if(!terminal){
          return send(res,409,{
            ok:false,code:'ENTRY_PARTIAL_FILL_EXIT_STARTED_CANCEL_NOT_TERMINAL',
            writeAttempted:result?.writeAttempted===true,result,
          });
        }

        const liveQty=await liveBinancePositionQuantity({
          apiKey,secret,symbol,direction:partialEntryExitStartedTarget.direction,
        });
        const cleared=await clearPartialEntryTransitionAfterCertifiedFlat(partialEntryExitStartedTarget);
        if(cleared!==1){
          return send(res,409,{
            ok:false,code:'ENTRY_PARTIAL_FILL_EXIT_STARTED_TRANSITION_CHANGED',
            transitionClearResult:cleared,writeAttempted:result?.writeAttempted===true,
          });
        }
        await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
          at:Date.now(),kind:'ENTRY_PARTIAL_FILL_EXIT_STARTED_RECOVERED',
          deviceId:master.deviceId,commandId,symbol,clientOrderId,
          protectionClientAlgoId:partialEntryExitStartedTarget.protectionClientAlgoId,
          executedQuantity:Number(result?.order?.executedQty||partialEntryExitStartedTarget.executedQuantity),
          canceledRemainderQuantity:Number(result?.order?.origQty||partialEntryExitStartedTarget.quantity)-
            Number(result?.order?.executedQty||partialEntryExitStartedTarget.executedQuantity),
          liveQuantity:liveQty,
          transitionCleared:true,
        })]);
        await redis(['LTRIM',KEY_AUDIT,'0','199']);
        return send(res,200,{
          ok:true,result,partialFillExitStartedRecovery:true,
          fillRace:false,transitionCleared:true,liveQuantity:liveQty,
          protectionRepairRequired:liveQty>1e-12,
          protectionCleanupRequired:liveQty<=1e-12&&partialEntryExitStartedTarget.protectionPresent===true,
        });
      }

      if(partialEntryFlatTarget){
        const status=String(result?.order?.status||'').toUpperCase();
        const disposition=String(result?.disposition||'').toUpperCase();
        if(status==='FILLED'||disposition==='ALREADY_FILLED'){
          return send(res,200,{
            ok:true,result,partialFillFlatRecovery:true,
            fillRace:true,transitionCleared:false,
          });
        }
        const terminal=['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(status);
        if(!terminal){
          return send(res,409,{
            ok:false,code:'ENTRY_PARTIAL_FILL_FLAT_CANCEL_NOT_TERMINAL',
            writeAttempted:result?.writeAttempted===true,result,
          });
        }

        const liveQty=await liveBinancePositionQuantity({
          apiKey,secret,symbol,direction:partialEntryFlatTarget.direction,
        });
        if(liveQty>1e-12){
          return send(res,200,{
            ok:true,result,partialFillFlatRecovery:true,
            fillRace:true,liveQuantity:liveQty,transitionCleared:false,
          });
        }

        const cleared=await clearPartialEntryTransitionAfterCertifiedFlat(partialEntryFlatTarget);
        if(cleared!==1){
          return send(res,409,{
            ok:false,code:'ENTRY_PARTIAL_FILL_FLAT_TRANSITION_CHANGED',
            transitionClearResult:cleared,writeAttempted:result?.writeAttempted===true,
          });
        }
        await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
          at:Date.now(),kind:'ENTRY_PARTIAL_FILL_FLAT_RECOVERED',
          deviceId:master.deviceId,commandId,symbol,clientOrderId,
          protectionClientAlgoId:partialEntryFlatTarget.protectionClientAlgoId,
          executedQuantity:partialEntryFlatTarget.executedQuantity,
          canceledRemainderQuantity:partialEntryFlatTarget.remainingQuantity,
          certifiedFlat:true,
        })]);
        await redis(['LTRIM',KEY_AUDIT,'0','199']);
        return send(res,200,{
          ok:true,result,partialFillFlatRecovery:true,
          fillRace:false,transitionCleared:true,
          protectionCleanupRequired:partialEntryFlatTarget.protectionPresent===true,
        });
      }

      return send(res,200,{ok:true,result});
    }catch(e){
      const retryAfter=binanceBackoffSecondsFromError(e);
      if(retryAfter>0){
        try{await registerBinanceWriteBackoff(redis,e)}catch{}
        res.setHeader('Retry-After',String(retryAfter));
        return send(res,429,{
          ok:false,code:Number(e?.status)===418?'BINANCE_IP_BANNED':'BINANCE_RATE_LIMITED',
          retryAfterSeconds:retryAfter,binanceStatus:Number(e?.status)||0,
          binanceCode:e?.code??null,ambiguous:false,writeAttempted:false,
        });
      }
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

  const livePosition=(maxLossRemainderRecovery||progressiveRemainderRecovery||persistedRemainderRecovery)
    ?certifiedReportPosition(report,symbol,dir)
    :runtimePosition(runtimeState,symbol,dir);
  const liveQty=quantity(livePosition);
  if(!livePosition||!(liveQty>0))return send(res,409,{ok:false,code:'POSITION_NOT_FOUND',writeAttempted:false});
  if(requestedQty>liveQty+1e-12)return send(res,409,{ok:false,code:'CLOSE_QUANTITY_EXCEEDS_POSITION',liveQuantity:liveQty,writeAttempted:false});
  if(Math.abs(requestedQty-liveQty)>1e-12)return send(res,409,{ok:false,code:'FULL_CLOSE_QUANTITY_REQUIRED',liveQuantity:liveQty,writeAttempted:false});
  if(String(livePosition.positionSide||'BOTH').toUpperCase()!=='BOTH'){
    return send(res,409,{ok:false,code:'HEDGE_MODE_UNSUPPORTED',writeAttempted:false});
  }

  const exitMode=String(req.body?.exitMode||'PROTECTIVE_IOC').toUpperCase();
  if(exitMode==='REMAINDER_MARKET'){
    return send(res,400,{ok:false,code:'EXIT_MODE_LIMIT_REQUIRED',writeAttempted:false});
  }
  if(exitMode!=='PROTECTIVE_IOC'){
    return send(res,400,{ok:false,code:'EXIT_MODE_LIMIT_REQUIRED',writeAttempted:false});
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

  if(!(await requireFinalProtectiveMaster(res,master)))return;
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
    const retryAfter=binanceBackoffSecondsFromError(e);
    if(retryAfter>0){
      try{await registerBinanceWriteBackoff(redis,e)}catch{}
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{
        ok:false,code:Number(e?.status)===418?'BINANCE_IP_BANNED':'BINANCE_RATE_LIMITED',
        retryAfterSeconds:retryAfter,binanceStatus:Number(e?.status)||0,
        binanceCode:e?.code??null,ambiguous:false,writeAttempted:false,
      });
    }
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
