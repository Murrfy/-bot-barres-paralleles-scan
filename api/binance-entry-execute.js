import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation } from '../lib/device-session.mjs';
import { evaluateEntryRisk, REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';
import { buildEntryOrderPlan, deterministicClientOrderId } from '../lib/order-intent.mjs';
import {
  BinanceRequestError,
  placeStandardOrderIdempotent,
  queryOrderByClientId,
} from '../lib/binance-order-writer.mjs';

const BASE='https://fapi.binance.com';
const RECV_WINDOW=5000;
const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_STATE=`${PREFIX}:state`;
const KEY_RECONCILE_LAST=`${PREFIX}:reconcile:last`;
const KEY_REAL_EXECUTION_ARMED=`${PREFIX}:safety:real-execution-armed`;
const KEY_EMERGENCY_STOP=`${PREFIX}:safety:emergency-stop`;
const KEY_MASTER_MODE=`${PREFIX}:master-mode`;
const KEY_CONTROLLER_STATE=`${PREFIX}:controller-state`;
const KEY_MASTER_CONFIG_ACK=`${PREFIX}:master-config:applied`;
const KEY_AUDIT=`${PREFIX}:audit`;
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
const REAL_ENTRY_ENABLED=process.env.ZENITH_REAL_ENTRY_ENABLED==='1';
const BINANCE_WRITE_ENABLED=process.env.ZENITH_BINANCE_WRITE_ENABLED==='1';
const PAIRING_DISABLED=process.env.ZENITH_PAIRING_DISABLED==='1';

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
function number(value,fallback=0){
  const n=Number(value);
  return Number.isFinite(n)?n:fallback;
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
async function jsonFetch(url,init={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(url,{...init,cache:'no-store',signal:controller.signal});
    const text=await r.text();
    let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    if(!r.ok){
      const e=new Error(data?.msg||`Binance HTTP ${r.status}`);
      e.status=r.status;e.binanceCode=data?.code;throw e;
    }
    return data;
  }finally{clearTimeout(timer)}
}
async function signedGet(path,apiKey,secret,serverTime,extra={}){
  const params=new URLSearchParams({timestamp:String(serverTime),recvWindow:String(RECV_WINDOW)});
  for(const [key,value] of Object.entries(extra||{})){
    if(value!==undefined&&value!==null&&value!=='')params.set(key,String(value));
  }
  const signature=crypto.createHmac('sha256',secret).update(params.toString()).digest('hex');
  params.set('signature',signature);
  return jsonFetch(`${BASE}${path}?${params.toString()}`,{headers:{'X-MBX-APIKEY':apiKey}});
}
function firstForSymbol(value,symbol){
  const rows=Array.isArray(value)?value:value?[value]:[];
  return rows.find(x=>String(x?.symbol||'').toUpperCase()===symbol)||null;
}
function parseJson(raw){try{return raw?JSON.parse(raw):null}catch{return null}}
function armReason(record,masterDeviceId){
  if(!REAL_TRADING_ENABLED)return 'REAL_TRADING_DISABLED';
  if(!REAL_ENTRY_ENABLED)return 'REAL_ENTRY_DISABLED';
  if(!BINANCE_WRITE_ENABLED)return 'BINANCE_WRITE_DISABLED';
  if(!PAIRING_DISABLED)return 'PAIRING_OPEN';
  if(!DEPLOYMENT_SHA)return 'REAL_EXECUTION_DEPLOYMENT_SHA_MISSING';
  if(!record||record.version!==1)return 'REAL_EXECUTION_NOT_ARMED';
  if(String(record.masterDeviceId||'')!==String(masterDeviceId||''))return 'REAL_EXECUTION_ARM_MASTER_CHANGED';
  if(String(record.deploymentSha||'')!==DEPLOYMENT_SHA)return 'REAL_EXECUTION_ARM_DEPLOYMENT_CHANGED';
  return '';
}
function configSyncReason(controllerState,appliedState,masterDeviceId){
  const controllerRevision=Number(controllerState?.revision||0);
  const controllerHash=String(controllerState?.stateHash||'');
  if(!(controllerRevision>0)||!controllerHash)return 'NO_CONTROLLER_STATE';
  if(Number(appliedState?.revision||0)!==controllerRevision)return 'MASTER_CONFIG_OUT_OF_SYNC';
  if(String(appliedState?.stateHash||'')!==controllerHash)return 'MASTER_CONFIG_OUT_OF_SYNC';
  if(String(appliedState?.masterDeviceId||'')!==String(masterDeviceId||''))return 'MASTER_CONFIG_WRONG_DEVICE';
  return '';
}
function executionReadiness(runtimeState,report,masterDeviceId){
  const age=Date.now()-Number(runtimeState?.updatedAt||0);
  if(!runtimeState?.data||String(runtimeState?.masterDeviceId||'')!==String(masterDeviceId))return 'MASTER_RUNTIME_WRONG_DEVICE';
  if(!Number.isFinite(age)||age<0||age>30000)return 'MASTER_RUNTIME_STALE';
  const data=runtimeState.data;
  if(String(data.executionMode||data.mode||'').toUpperCase()!=='REAL')return 'MASTER_RUNTIME_NOT_REAL';
  const stream=data.userStream;
  if(!stream||stream.connected!==true||stream.ready!==true||stream.failClosed!==false||stream.needsReconciliation!==false)return 'USER_STREAM_NOT_READY';
  const reportAge=Date.now()-Number(report?.observedAt||0);
  if(!report||report.version!==2||report.status!=='CLEAN_REAL'||report.failClosed!==false||!Array.isArray(report.reasons)||report.reasons.length)return 'BINANCE_RECONCILIATION_MISMATCH';
  if(!Number.isFinite(reportAge)||reportAge<0||reportAge>10000)return 'BINANCE_RECONCILIATION_STALE';
  if(String(report.runtimeDataHash||'')!==sha256(stableStringify(data)))return 'BINANCE_RECONCILIATION_RUNTIME_CHANGED';
  return '';
}
function commandRequest(body={}){
  const commandId=String(body.commandId||'').trim();
  const symbol=String(body.symbol||'').trim().toUpperCase();
  const side=String(body.side||'').trim().toUpperCase();
  const orderType=String(body.orderType||'LIMIT').trim().toUpperCase();
  const limitPrice=number(body.limitPrice);
  const margin=number(body.margin);
  const leverage=number(body.leverage);
  const maxLoss=number(body.maxLoss);
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(commandId))throw new Error('COMMAND_ID_INVALID');
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))throw new Error('SYMBOL_INVALID');
  if(!['BUY','SELL'].includes(side))throw new Error('SIDE_INVALID');
  if(orderType!=='LIMIT')throw new Error('REAL_ENTRY_LIMIT_ONLY');
  if(!(limitPrice>0))throw new Error('LIMIT_PRICE_INVALID');
  if(!(margin>0)||margin>REAL_RISK_LIMITS.maxMarginUsdt)throw new Error('MARGIN_INVALID');
  if(!(leverage>0)||leverage>REAL_RISK_LIMITS.maxLeverage)throw new Error('LEVERAGE_INVALID');
  if(!(maxLoss>0)||maxLoss>REAL_RISK_LIMITS.maxLossUsd||maxLoss>margin)throw new Error('MAX_LOSS_INVALID');
  if(margin*leverage>REAL_RISK_LIMITS.maxNotionalUsdt)throw new Error('NOTIONAL_OVER_SERVER_CAP');
  return {commandId,symbol,side,orderType,limitPrice,margin,leverage,maxLoss};
}
function validateExistingEntry(order,request,clientOrderId){
  if(String(order?.clientOrderId||'')!==clientOrderId)return 'ENTRY_EXISTING_CLIENT_ID_MISMATCH';
  if(String(order?.symbol||'').toUpperCase()!==request.symbol)return 'ENTRY_EXISTING_SYMBOL_MISMATCH';
  if(String(order?.side||'').toUpperCase()!==request.side)return 'ENTRY_EXISTING_SIDE_MISMATCH';
  if(String(order?.positionSide||'BOTH').toUpperCase()!=='BOTH')return 'ENTRY_EXISTING_HEDGE_MODE';
  if(order?.reduceOnly===true||order?.reduceOnly==='true')return 'ENTRY_EXISTING_REDUCE_ONLY';
  if(String(order?.type||'').toUpperCase()!=='LIMIT')return 'ENTRY_EXISTING_TYPE_MISMATCH';
  if(Math.abs(number(order?.price)-request.limitPrice)>1e-12)return 'ENTRY_EXISTING_PRICE_MISMATCH';
  if(!(number(order?.origQty)>0))return 'ENTRY_EXISTING_QUANTITY_INVALID';
  return '';
}
async function persistExecutionRecord(record){
  const key=`${PREFIX}:entry-execution:${record.commandId}`;
  await redis(['SET',key,JSON.stringify(record),'EX','600']);
}
async function audit(entry){
  await redis(['LPUSH',KEY_AUDIT,JSON.stringify(entry)]);
  await redis(['LTRIM',KEY_AUDIT,'0','199']);
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});

  let master=null;
  try{master=await requireCurrentMaster(req)}
  catch(e){return send(res,e?.code==='MASTER_LEASE_REQUIRED'?409:503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR',writeAttempted:false})}
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED',writeAttempted:false});

  let request;
  try{request=commandRequest(req.body||{})}
  catch(e){return send(res,400,{ok:false,code:e?.message||'ENTRY_REQUEST_INVALID',writeAttempted:false})}

  const apiKey=process.env.BINANCE_API_KEY;
  const secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV',writeAttempted:false});

  try{
    const [runtimeRaw,reportRaw,armRaw,modeRaw,haltedRaw,controllerRaw,appliedRaw]=await Promise.all([
      redis(['GET',KEY_STATE]),
      redis(['GET',KEY_RECONCILE_LAST]),
      redis(['GET',KEY_REAL_EXECUTION_ARMED]),
      redis(['GET',KEY_MASTER_MODE]),
      redis(['GET',KEY_EMERGENCY_STOP]),
      redis(['GET',KEY_CONTROLLER_STATE]),
      redis(['GET',KEY_MASTER_CONFIG_ACK]),
    ]);
    const runtimeState=parseJson(runtimeRaw);
    const report=parseJson(reportRaw);
    const armRecord=parseJson(armRaw);
    const controllerState=parseJson(controllerRaw);
    const appliedState=parseJson(appliedRaw);

    const arm=armReason(armRecord,master.deviceId);
    if(arm)return send(res,423,{ok:false,code:'EXECUTION_NOT_ARMED',reason:arm,writeAttempted:false});
    if(String(modeRaw||'').toUpperCase()!=='RUNNING'){
      return send(res,423,{ok:false,code:'ENTRY_MASTER_NOT_RUNNING',reason:String(modeRaw||'PAUSED'),writeAttempted:false});
    }
    if(String(haltedRaw??'1')!=='0'){
      return send(res,423,{ok:false,code:'EMERGENCY_STOP_ACTIVE',writeAttempted:false});
    }
    const sync=configSyncReason(controllerState,appliedState,master.deviceId);
    if(sync)return send(res,423,{ok:false,code:'MASTER_CONFIG_OUT_OF_SYNC',reason:sync,writeAttempted:false});
    const readiness=executionReadiness(runtimeState,report,master.deviceId);
    if(readiness)return send(res,423,{ok:false,code:'EXECUTION_NOT_READY',reason:readiness,writeAttempted:false});

    const clientOrderId=deterministicClientOrderId({
      commandId:request.commandId,
      symbol:request.symbol,
      leg:'ENTRY',
    });
    const time=await jsonFetch(`${BASE}/fapi/v1/time`);
    const serverTime=Number(time?.serverTime);
    if(!Number.isFinite(serverTime))throw new Error('BINANCE_TIME_UNAVAILABLE');

    // Recovery path first: a previous POST may have succeeded while its response was lost.
    try{
      const existing=await queryOrderByClientId({
        apiKey,secret,symbol:request.symbol,clientOrderId,timestamp:serverTime,
      });
      const mismatch=validateExistingEntry(existing,request,clientOrderId);
      if(mismatch)return send(res,409,{ok:false,code:mismatch,writeAttempted:false});
      const record={
        version:1,
        commandId:request.commandId,
        masterDeviceId:master.deviceId,
        deploymentSha:DEPLOYMENT_SHA,
        symbol:request.symbol,
        side:request.side,
        orderType:'LIMIT',
        limitPrice:request.limitPrice,
        plannedQuantity:number(existing?.origQty),
        clientOrderId,
        preflightObservedAt:0,
        recoveredExisting:true,
        recordedAt:Date.now(),
      };
      await persistExecutionRecord(record);
      await audit({at:Date.now(),kind:'BINANCE_ENTRY_RECOVERED_EXISTING',deviceId:master.deviceId,commandId:request.commandId,symbol:request.symbol,clientOrderId});
      return send(res,200,{
        ok:true,
        confirmationRequired:true,
        plan:{commandId:request.commandId,params:{symbol:request.symbol,side:request.side,positionSide:'BOTH',type:'LIMIT',quantity:String(record.plannedQuantity),price:String(request.limitPrice),timeInForce:'GTC',reduceOnly:'false',newClientOrderId:clientOrderId}},
        result:{ok:true,disposition:'EXISTING',writeAttempted:false,order:existing},
      });
    }catch(e){
      if(!(e instanceof BinanceRequestError)||Number(e.code)!==-2013)throw e;
    }

    const [exchangeInfo,ticker]=await Promise.all([
      jsonFetch(`${BASE}/fapi/v1/exchangeInfo`),
      jsonFetch(`${BASE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(request.symbol)}`),
    ]);

    const [symbolConfigRaw,bracketsRaw,positionMode,account,positions,standardOrders,algoOrders]=await Promise.all([
      signedGet('/fapi/v1/symbolConfig',apiKey,secret,serverTime,{symbol:request.symbol}),
      signedGet('/fapi/v1/leverageBracket',apiKey,secret,serverTime,{symbol:request.symbol}),
      signedGet('/fapi/v1/positionSide/dual',apiKey,secret,serverTime),
      signedGet('/fapi/v3/account',apiKey,secret,serverTime),
      signedGet('/fapi/v3/positionRisk',apiKey,secret,serverTime),
      signedGet('/fapi/v1/openOrders',apiKey,secret,serverTime,{symbol:request.symbol}),
      signedGet('/fapi/v1/openAlgoOrders',apiKey,secret,serverTime,{symbol:request.symbol,algoType:'CONDITIONAL'}),
    ]);

    const symbolInfo=(Array.isArray(exchangeInfo?.symbols)?exchangeInfo.symbols:[])
      .find(x=>String(x?.symbol||'').toUpperCase()===request.symbol)||null;
    const symbolConfig=firstForSymbol(symbolConfigRaw,request.symbol);
    const bracketInfo=firstForSymbol(bracketsRaw,request.symbol);
    const usdt=(Array.isArray(account?.assets)?account.assets:[])
      .find(x=>String(x?.asset||'').toUpperCase()==='USDT')||{};

    const evaluation=evaluateEntryRisk({
      symbol:request.symbol,
      margin:request.margin,
      leverage:request.leverage,
      maxLoss:request.maxLoss,
      referencePrice:request.limitPrice,
      symbolInfo,
      symbolConfig,
      bracketInfo,
      dualSidePosition:positionMode?.dualSidePosition===true,
      positions,
      standardOrders,
      algoOrders,
      availableBalanceUsdt:number(usdt?.availableBalance,number(account?.availableBalance,-1)),
    });
    if(!evaluation.ready){
      return send(res,409,{ok:false,code:'ENTRY_PREFLIGHT_REJECTED',reasons:evaluation.reasons,normalized:evaluation.normalized,writeAttempted:false});
    }

    const riskSnapshot={ready:true,observedAt:Date.now(),normalized:evaluation.normalized};
    let plan;
    try{
      plan=buildEntryOrderPlan({
        command:{
          id:request.commandId,
          symbol:request.symbol,
          side:request.side,
          orderType:'LIMIT',
          limitPrice:request.limitPrice,
        },
        riskSnapshot,
        now:Date.now(),
      });
    }catch(e){
      return send(res,409,{ok:false,code:e?.message||'ENTRY_PLAN_INVALID',writeAttempted:false});
    }

    const writeTime=await jsonFetch(`${BASE}/fapi/v1/time`);
    const writeServerTime=Number(writeTime?.serverTime);
    if(!Number.isFinite(writeServerTime))throw new Error('BINANCE_WRITE_TIME_UNAVAILABLE');
    const result=await placeStandardOrderIdempotent({
      apiKey,
      secret,
      orderParams:plan.params,
      writesEnabled:true,
      timestamp:writeServerTime,
    });
    if(result?.ok!==true){
      return send(res,502,{ok:false,code:'ENTRY_WRITE_NOT_ACCEPTED',result,writeAttempted:result?.writeAttempted===true});
    }

    const record={
      version:1,
      commandId:request.commandId,
      masterDeviceId:master.deviceId,
      deploymentSha:DEPLOYMENT_SHA,
      symbol:request.symbol,
      side:request.side,
      orderType:'LIMIT',
      limitPrice:request.limitPrice,
      plannedQuantity:Number(plan.params.quantity),
      clientOrderId:String(plan.params.newClientOrderId||''),
      preflightObservedAt:riskSnapshot.observedAt,
      recordedAt:Date.now(),
    };
    await persistExecutionRecord(record);
    await audit({
      at:Date.now(),
      kind:'BINANCE_ENTRY_DISPATCH',
      deviceId:master.deviceId,
      commandId:request.commandId,
      symbol:request.symbol,
      side:request.side,
      clientOrderId:record.clientOrderId,
      plannedQuantity:record.plannedQuantity,
      disposition:result.disposition,
      writeAttempted:result.writeAttempted===true,
    });

    return send(res,200,{
      ok:true,
      confirmationRequired:true,
      preflight:{observedAt:riskSnapshot.observedAt,normalized:evaluation.normalized},
      plan,
      result,
    });
  }catch(e){
    return send(res,502,{
      ok:false,
      code:e?.message==='ORDER_RESULT_AMBIGUOUS'?'ORDER_RESULT_AMBIGUOUS':'BINANCE_ENTRY_EXECUTION_FAILED',
      error:e?.message||'Binance entry execution failed.',
      binanceCode:e?.code??e?.binanceCode??null,
      ambiguous:e?.ambiguous===true,
      writeAttempted:e instanceof BinanceRequestError ? e.ambiguous===true : false,
    });
  }
}

export { armReason, configSyncReason, executionReadiness, commandRequest, validateExistingEntry };
