import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation } from '../lib/device-session.mjs';
import { validateStandardOrderPlan } from '../lib/binance-order-wire.mjs';

const BASE='https://fapi.binance.com';
const PREFIX='zenith:v1';
const RECV_WINDOW=5000;

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
function sha256(v){return crypto.createHash('sha256').update(String(v)).digest('hex')}

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
    const hash=sha256(token);
    const raw=await redis(['GET',`${PREFIX}:device:${hash}`]);
    if(!raw)continue;
    let device=null;try{device=JSON.parse(raw)}catch{}
    if(!device?.deviceId||device.role!=='master')continue;
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

async function submitTestOrder(params,apiKey,secret){
  const time=await jsonFetch(`${BASE}/fapi/v1/time`);
  const serverTime=Number(time?.serverTime);
  if(!Number.isFinite(serverTime))throw new Error('BINANCE_TIME_INVALID');

  const body=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
    if(value!==undefined&&value!==null&&String(value)!=='')body.set(key,String(value));
  }
  body.set('timestamp',String(serverTime));
  body.set('recvWindow',String(RECV_WINDOW));
  const signature=crypto.createHmac('sha256',secret).update(body.toString()).digest('hex');
  body.set('signature',signature);

  return jsonFetch(`${BASE}/fapi/v1/order/test`,{
    method:'POST',
    headers:{
      'X-MBX-APIKEY':apiKey,
      'Content-Type':'application/x-www-form-urlencoded',
    },
    body:body.toString(),
  });
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});

  let master=null;
  try{master=await requireCurrentMaster(req)}
  catch(e){
    if(e?.code==='MASTER_LEASE_REQUIRED')return send(res,409,{ok:false,code:'MASTER_LEASE_REQUIRED'});
    return send(res,503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR'});
  }
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED'});

  let params=null;
  try{params=validateStandardOrderPlan(req.body?.plan)}
  catch(e){return send(res,400,{ok:false,code:e?.message||'ORDER_PLAN_INVALID'})}

  const apiKey=process.env.BINANCE_API_KEY;
  const secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV'});

  try{
    const result=await submitTestOrder(params,apiKey,secret);
    return send(res,200,{
      ok:true,
      validatedByBinance:true,
      matchingEngineSubmitted:false,
      endpoint:'/fapi/v1/order/test',
      clientOrderId:params.newClientOrderId,
      result,
    });
  }catch(e){
    return send(res,502,{
      ok:false,
      code:'BINANCE_TEST_ORDER_FAILED',
      error:e?.message||'Binance test order failed.',
      binanceCode:e?.binanceCode??null,
      matchingEngineSubmitted:false,
    });
  }
}
