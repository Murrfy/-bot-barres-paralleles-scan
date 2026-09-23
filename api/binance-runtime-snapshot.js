import crypto from 'node:crypto';
import { deviceTokenCandidates, deviceSessionRecordActive } from '../lib/device-session.mjs';

const BASE = 'https://fapi.binance.com';
const RECV_WINDOW = 5000;
const PREFIX = 'zenith:v1';
const BINANCE_RUNTIME_SNAPSHOT_RATE_LIMIT_PER_MINUTE = 12;

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN;

function send(res,status,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
}
function sha256(v){ return crypto.createHash('sha256').update(String(v)).digest('hex'); }

async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN){
    const e=new Error('UPSTASH_NOT_CONFIGURED');e.code='UPSTASH_NOT_CONFIGURED';throw e;
  }
  const r=await fetch(REDIS_URL,{
    method:'POST',
    headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify(command),
    cache:'no-store',
  });
  const text=await r.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok||data?.error){
    const e=new Error(data?.error||`Redis HTTP ${r.status}`);e.code='REDIS_ERROR';throw e;
  }
  return data?.result;
}

async function requireCurrentMaster(req){
  for(const token of deviceTokenCandidates(req)){
    const tokenHash=sha256(token);
    const raw=await redis(['GET',`${PREFIX}:device:${tokenHash}`]);
    if(!raw)continue;
    let device=null;try{device=JSON.parse(raw)}catch{}
    if(!deviceSessionRecordActive(device)||!device?.deviceId||device.role!=='master')continue;
    const [registered,lease]=await Promise.all([
      redis(['GET',`${PREFIX}:role-device:master`]),
      redis(['GET',`${PREFIX}:master`]),
    ]);
    if(String(registered||'')!==String(device.deviceId))continue;
    if(String(lease||'')!==String(device.deviceId)){
      const e=new Error('MASTER_LEASE_REQUIRED');e.code='MASTER_LEASE_REQUIRED';throw e;
    }
    return device;
  }
  return null;
}

async function runtimeSnapshotRateAllowed(deviceId){
  const bucket=Math.floor(Date.now()/60000);
  const key=`${PREFIX}:rate:binance-runtime-snapshot:${sha256(deviceId)}:${bucket}`;
  const script=[
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count=Number(await redis(['EVAL',script,'1',key,'120']))||0;
  return count<=BINANCE_RUNTIME_SNAPSHOT_RATE_LIMIT_PER_MINUTE;
}
function retryAfterSeconds(){
  return Math.max(1,60-(Math.floor(Date.now()/1000)%60));
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
  params.set('signature',crypto.createHmac('sha256',secret).update(params.toString()).digest('hex'));
  return jsonFetch(`${BASE}${path}?${params.toString()}`,{headers:{'X-MBX-APIKEY':apiKey}});
}

function n(v,fallback=0){const x=Number(v);return Number.isFinite(x)?x:fallback}
function bool(v){return v===true||v==='true'}

function normalizePosition(p){
  return {
    symbol:String(p.symbol||'').toUpperCase(),
    positionSide:String(p.positionSide||'BOTH').toUpperCase(),
    positionAmt:String(p.positionAmt??''),
    quantity:Math.abs(n(p.positionAmt)),
    entryPrice:n(p.entryPrice),
    breakEvenPrice:n(p.breakEvenPrice),
    markPrice:n(p.markPrice),
    unrealizedProfit:n(p.unRealizedProfit??p.unrealizedProfit),
    liquidationPrice:n(p.liquidationPrice),
    leverage:n(p.leverage),
    marginType:String(p.marginType||''),
    isolatedMargin:n(p.isolatedMargin),
    notional:n(p.notional),
    updateTime:n(p.updateTime),
  };
}

function normalizeStandardOrder(o){
  return {
    orderClass:'STANDARD',
    symbol:String(o.symbol||'').toUpperCase(),
    orderId:String(o.orderId??''),
    clientOrderId:String(o.clientOrderId??''),
    side:String(o.side||'').toUpperCase(),
    positionSide:String(o.positionSide||'BOTH').toUpperCase(),
    type:String(o.type||'').toUpperCase(),
    status:String(o.status||'').toUpperCase(),
    origQty:String(o.origQty??''),
    executedQty:String(o.executedQty??''),
    price:String(o.price??''),
    stopPrice:String(o.stopPrice??''),
    reduceOnly:bool(o.reduceOnly),
    closePosition:bool(o.closePosition),
    timeInForce:String(o.timeInForce||''),
    workingType:String(o.workingType||''),
    priceProtect:bool(o.priceProtect),
    updateTime:n(o.updateTime??o.time),
  };
}

function normalizeAlgoOrder(o){
  return {
    orderClass:'ALGO',
    symbol:String(o.symbol||'').toUpperCase(),
    algoId:String(o.algoId??''),
    clientAlgoId:String(o.clientAlgoId??''),
    side:String(o.side||'').toUpperCase(),
    positionSide:String(o.positionSide||'BOTH').toUpperCase(),
    type:String(o.orderType||o.type||'').toUpperCase(),
    status:String(o.algoStatus||'').toUpperCase(),
    origQty:String(o.quantity??''),
    executedQty:'',
    price:String(o.price??''),
    stopPrice:String(o.triggerPrice??''),
    triggerPrice:String(o.triggerPrice??''),
    reduceOnly:bool(o.reduceOnly),
    closePosition:bool(o.closePosition),
    timeInForce:String(o.timeInForce||''),
    workingType:String(o.workingType||''),
    priceProtect:bool(o.priceProtect),
    updateTime:n(o.updateTime??o.createTime),
  };
}

export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});

  let master=null;
  try{master=await requireCurrentMaster(req)}
  catch(e){
    if(e?.code==='MASTER_LEASE_REQUIRED')return send(res,409,{ok:false,code:'MASTER_LEASE_REQUIRED'});
    return send(res,503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR'});
  }
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED'});

  try{
    if(!(await runtimeSnapshotRateAllowed(master.deviceId))){
      const retryAfter=retryAfterSeconds();
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{ok:false,code:'BINANCE_RUNTIME_SNAPSHOT_RATE_LIMIT',retryAfterSeconds:retryAfter});
    }
  }catch(e){
    return send(res,503,{ok:false,code:e?.code||'RATE_LIMIT_BACKEND_ERROR',error:'Protection anti-abus indisponible.'});
  }

  const apiKey=process.env.BINANCE_API_KEY;
  const secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV'});

  const startedAt=Date.now();
  try{
    const time=await jsonFetch(`${BASE}/fapi/v1/time`);
    const serverTime=n(time?.serverTime,NaN);
    if(!Number.isFinite(serverTime))throw new Error('BINANCE_TIME_INVALID');

    const [positionsRaw,standardRaw,algoRaw]=await Promise.all([
      signedGet('/fapi/v3/positionRisk',apiKey,secret,serverTime),
      signedGet('/fapi/v1/openOrders',apiKey,secret,serverTime),
      signedGet('/fapi/v1/openAlgoOrders',apiKey,secret,serverTime,{algoType:'CONDITIONAL'}),
    ]);
    if(![positionsRaw,standardRaw,algoRaw].every(Array.isArray))throw new Error('BINANCE_RESPONSE_INVALID');

    const positions=positionsRaw.filter(p=>Math.abs(n(p?.positionAmt))>0).map(normalizePosition);
    const standardOrders=standardRaw.map(normalizeStandardOrder);
    const algoOrders=algoRaw.map(normalizeAlgoOrder);
    const orders=[...standardOrders,...algoOrders];
    const observedAt=Date.now();
    const snapshot={
      version:1,
      observedAt,
      serverTime,
      masterDeviceId:master.deviceId,
      positions,
      standardOrders,
      algoOrders,
      orders,
    };
    const snapshotHash=sha256(JSON.stringify(snapshot));

    return send(res,200,{
      ok:true,
      mode:'READ_ONLY_RUNTIME_SEED',
      writeAttempted:false,
      snapshot:{...snapshot,snapshotHash},
      latencyMs:Date.now()-startedAt,
    });
  }catch(e){
    return send(res,502,{
      ok:false,
      code:'BINANCE_RUNTIME_SNAPSHOT_FAILED',
      error:e?.message||'Binance runtime snapshot unavailable.',
      binanceCode:e?.binanceCode??null,
      writeAttempted:false,
    });
  }
}
