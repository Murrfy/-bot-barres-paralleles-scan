import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation, deviceSessionRecordActive, roleAssignmentKey, deviceRoleAssignmentActive } from '../lib/device-session.mjs';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';
import { readBinanceWriteBackoff, registerBinanceWriteBackoff, binanceBackoffSecondsFromError } from '../lib/binance-write-backoff.mjs';

const BASE='https://fapi.binance.com';
const TEST_ORDER_PATH='/fapi/v1/order/test';
const TIME_PATH='/fapi/v1/time';
const RECV_WINDOW=5000;
const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const BINANCE_ORDER_TEST_RATE_LIMIT_PER_MINUTE=6;

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
function sha256(v){return crypto.createHash('sha256').update(String(v)).digest('hex');}
async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN) throw Object.assign(new Error('UPSTASH_NOT_CONFIGURED'),{code:'UPSTASH_NOT_CONFIGURED'});
  const r=await fetch(REDIS_URL,{method:'POST',headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(8000),cache:'no-store'});
  const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok||data?.error) throw Object.assign(new Error(data?.error||`Redis HTTP ${r.status}`),{code:'REDIS_ERROR'});
  return data?.result;
}
async function requireMaster(req){
  for(const token of deviceTokenCandidates(req)){
    const raw=await redis(['GET',`${PREFIX}:device:${sha256(token)}`]);
    if(!raw)continue;
    let device=null;try{device=JSON.parse(raw)}catch{}
    if(!deviceSessionRecordActive(device)||!device?.deviceId||device.role!=='master')continue;
    const [registered,lease]=await Promise.all([redis(['GET',KEY_MASTER_DEVICE]),redis(['GET',KEY_MASTER])]);
    if(String(registered||'')!==String(device.deviceId))continue;
    const issuedAt=await redis(['GET',roleAssignmentKey(PREFIX,'master')]);
    if(!deviceRoleAssignmentActive(device,issuedAt))continue;
    if(String(lease||'')!==String(device.deviceId)) throw Object.assign(new Error('MASTER_LEASE_REQUIRED'),{code:'MASTER_LEASE_REQUIRED'});
    return device;
  }
  return null;
}
async function orderTestRateAllowed(deviceId){
  const bucket=Math.floor(Date.now()/60000);
  const key=`${PREFIX}:rate:binance-order-test:${sha256(deviceId)}:${bucket}`;
  const script=[
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count=Number(await redis(['EVAL',script,'1',key,'120']))||0;
  return count<=BINANCE_ORDER_TEST_RATE_LIMIT_PER_MINUTE;
}
function retryAfterSeconds(){return Math.max(1,60-(Math.floor(Date.now()/1000)%60));}

async function jsonFetch(url,init={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(url,{...init,cache:'no-store',signal:controller.signal});
    const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    if(!r.ok||data?.code){
      const e=new Error(data?.msg||`Binance HTTP ${r.status}`);
      e.status=r.status;
      e.binanceCode=data?.code;
      e.retryAfterSeconds=Math.max(0,Math.ceil(Number(r?.headers?.get?.('retry-after'))||0));
      throw e;
    }
    return data;
  }finally{clearTimeout(timer)}
}
function cleanParams(value){
  const p=value&&typeof value==='object'?value:{};
  const allowed=['symbol','side','positionSide','type','timeInForce','quantity','price','newClientOrderId','reduceOnly','priceMatch'];
  const out={};
  for(const k of allowed)if(p[k]!==undefined&&p[k]!==null&&p[k]!=='')out[k]=String(p[k]);
  out.symbol=String(out.symbol||'').toUpperCase();
  out.side=String(out.side||'').toUpperCase();
  out.positionSide=String(out.positionSide||'BOTH').toUpperCase();
  out.type=String(out.type||'').toUpperCase();
  out.timeInForce=String(out.timeInForce||'').toUpperCase();
  out.priceMatch=String(out.priceMatch||'').toUpperCase();

  if(!/^[A-Z0-9]{3,30}$/.test(out.symbol))throw new Error('SYMBOL_INVALID');
  if(!['BUY','SELL'].includes(out.side))throw new Error('SIDE_INVALID');
  if(out.positionSide!=='BOTH')throw new Error('ONLY_ONE_WAY_SUPPORTED');
  if(!['LIMIT','MARKET'].includes(out.type))throw new Error('ORDER_TYPE_NOT_ALLOWED');
  if(out.reduceOnly!=='true')throw new Error('TEST_MUST_BE_REDUCE_ONLY');
  if(!/^zth-[A-Za-z0-9._:-]{1,32}$/.test(String(out.newClientOrderId||''))||String(out.newClientOrderId).length>36)throw new Error('CLIENT_ORDER_ID_INVALID');
  const q=Number(out.quantity);if(!(q>0))throw new Error('QUANTITY_INVALID');
  if(out.type==='LIMIT'){
    if(!['GTC','IOC','FOK','GTX'].includes(out.timeInForce))throw new Error('TIME_IN_FORCE_INVALID');
    const hasPrice=Number(out.price)>0,hasMatch=Boolean(out.priceMatch);
    if(hasPrice===hasMatch)throw new Error('LIMIT_REQUIRES_PRICE_XOR_PRICE_MATCH');
    if(hasMatch&&!['OPPONENT','OPPONENT_5','OPPONENT_10','OPPONENT_20','QUEUE','QUEUE_5','QUEUE_10','QUEUE_20'].includes(out.priceMatch))throw new Error('PRICE_MATCH_INVALID');
  }else{
    delete out.timeInForce;delete out.price;delete out.priceMatch;
  }
  return out;
}
function signedBody(params,secret,timestamp){
  const q=new URLSearchParams({...params,timestamp:String(timestamp),recvWindow:String(RECV_WINDOW)});
  const signature=crypto.createHmac('sha256',secret).update(q.toString()).digest('hex');
  q.set('signature',signature);
  return q.toString();
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});
  const bodyStatus=requestBodyStatus(req,64*1024);
  if(!bodyStatus.ok)return send(res,413,{ok:false,code:'REQUEST_BODY_TOO_LARGE',maxBytes:bodyStatus.maxBytes,matchingEngineSubmitted:false,tradingWriteAttempted:false});
  let master=null;
  try{master=await requireMaster(req)}catch(e){return send(res,e?.code==='MASTER_LEASE_REQUIRED'?409:503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR'})}
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED'});
  try{
    if(!(await orderTestRateAllowed(master.deviceId))){
      const retryAfter=retryAfterSeconds();
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{ok:false,code:'BINANCE_ORDER_TEST_RATE_LIMIT',retryAfterSeconds:retryAfter,matchingEngineSubmitted:false,tradingWriteAttempted:false});
    }
  }catch(e){
    return send(res,503,{ok:false,code:e?.code||'RATE_LIMIT_BACKEND_ERROR',matchingEngineSubmitted:false,tradingWriteAttempted:false});
  }
  const apiKey=process.env.BINANCE_TRADING_API_KEY,secret=process.env.BINANCE_TRADING_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'BINANCE_TRADING_CREDENTIALS_MISSING'});

  try{
    const backoff=await readBinanceWriteBackoff(redis);
    if(backoff.active){
      res.setHeader('Retry-After',String(backoff.retryAfterSeconds));
      return send(res,429,{
        ok:false,code:'BINANCE_WRITE_BACKOFF_ACTIVE',
        retryAfterSeconds:backoff.retryAfterSeconds,
        binanceStatus:backoff.status,
        matchingEngineSubmitted:false,tradingWriteAttempted:false,
      });
    }
  }catch{
    return send(res,503,{ok:false,code:'BINANCE_BACKOFF_STATE_UNAVAILABLE',matchingEngineSubmitted:false,tradingWriteAttempted:false});
  }

  let params;
  try{params=cleanParams(req.body?.params)}catch(e){return send(res,400,{ok:false,code:e?.message||'PARAMS_INVALID'})}

  try{
    const time=await jsonFetch(`${BASE}${TIME_PATH}`);
    const serverTime=Number(time?.serverTime);
    if(!Number.isFinite(serverTime))throw new Error('BINANCE_TIME_INVALID');
    const body=signedBody(params,secret,serverTime);
    const result=await jsonFetch(`${BASE}${TEST_ORDER_PATH}`,{
      method:'POST',
      headers:{'X-MBX-APIKEY':apiKey,'Content-Type':'application/x-www-form-urlencoded'},
      body,
    });
    return send(res,200,{
      ok:true,
      mode:'BINANCE_TEST_ORDER_ONLY',
      matchingEngineSubmitted:false,
      tradingWriteAttempted:false,
      params:{...params,newClientOrderId:String(params.newClientOrderId)},
      result,
    });
  }catch(e){
    const retryAfter=binanceBackoffSecondsFromError(e);
    if(retryAfter>0){
      try{await registerBinanceWriteBackoff(redis,e)}catch{}
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{
        ok:false,code:Number(e?.status)===418?'BINANCE_IP_BANNED':'BINANCE_RATE_LIMITED',
        retryAfterSeconds:retryAfter,binanceStatus:Number(e?.status)||0,
        binanceCode:e?.binanceCode??null,matchingEngineSubmitted:false,tradingWriteAttempted:false,
      });
    }
    return send(res,502,{
      ok:false,code:'BINANCE_TEST_ORDER_FAILED',error:'Test order failed',
      binanceCode:e?.binanceCode??null,matchingEngineSubmitted:false,tradingWriteAttempted:false,
    });
  }
}

export { cleanParams, signedBody };
