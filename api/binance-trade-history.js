import crypto from 'node:crypto';
import { deviceTokenCandidates, deviceSessionRecordActive, roleAssignmentKey, deviceRoleAssignmentActive, engineInstanceHeader, enginePrincipalInstanceActive } from '../lib/device-session.mjs';
import { signedBinanceRequest } from '../lib/binance-order-writer.mjs';
import { managedOrderIndex, buildClosedZenithTradeHistory } from '../lib/binance-trade-history.mjs';

const BASE='https://fapi.binance.com';
const PREFIX='zenith:v1';
const CACHE_KEY=`${PREFIX}:binance-real-history:v1`;
const CACHE_TTL_SECONDS=60;
const RATE_LIMIT_WINDOW_SECONDS=300;
const RATE_LIMIT_MAX=3;
const LOOKBACK_DAYS=30;
const WINDOW_MS=7*24*60*60*1000;
const MAX_SYMBOLS=12;

const REDIS_URL=
  process.env.UPSTASH_REDIS_REST_URL||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL||
  process.env.KV_REST_API_URL||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;
const REDIS_TOKEN=
  process.env.UPSTASH_REDIS_REST_TOKEN||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN||
  process.env.KV_REST_API_TOKEN;

function send(res,status,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex')}
function parseJson(raw){try{return raw?JSON.parse(raw):null}catch{return null}}

async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN)throw new Error('UPSTASH_NOT_CONFIGURED');
  const r=await fetch(REDIS_URL,{
    method:'POST',
    headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify(command),
  });
  if(!r.ok)throw new Error('UPSTASH_HTTP_'+r.status);
  const data=await r.json();
  if(data?.error)throw new Error('UPSTASH_COMMAND_FAILED');
  return data?.result;
}

async function requireZenithDevice(req){
  for(const token of deviceTokenCandidates(req)){
    const tokenHash=sha256(token);
    const raw=await redis(['GET',`${PREFIX}:device:${tokenHash}`]);
    if(!raw)continue;
    try{
      const device=JSON.parse(raw);
      if(!deviceSessionRecordActive(device)||!device?.deviceId||!['controller','master'].includes(device?.role))continue;
      const owner=await redis(['GET',device.role==='master'?`${PREFIX}:role-device:master`:`${PREFIX}:role-device:controller`]);
      if(!owner||String(owner)!==String(device.deviceId))continue;
      const issuedAt=await redis(['GET',roleAssignmentKey(PREFIX,device.role)]);
      if(!deviceRoleAssignmentActive(device,issuedAt))continue;
      if(String(device?.principal||'')==='engine'){
        const suppliedInstance=engineInstanceHeader(req);
        const [currentInstance,currentLease]=await Promise.all([
          redis(['GET',`${PREFIX}:engine-instance`]),
          redis(['GET',`${PREFIX}:master-lease`]),
        ]);
        if(!enginePrincipalInstanceActive(device,{suppliedInstance,currentInstance,currentLease})){
          const error=new Error('ENGINE_INSTANCE_FENCED');error.code='ENGINE_INSTANCE_FENCED';throw error;
        }
      }
      return {...device,tokenHash};
    }catch(e){
      if(e?.code)throw e;
    }
  }
  return null;
}

async function rateAllowed(deviceId){
  const bucket=Math.floor(Date.now()/(RATE_LIMIT_WINDOW_SECONDS*1000));
  const key=`${PREFIX}:rate:real-history:${sha256(deviceId)}:${bucket}`;
  const script=[
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count=Number(await redis(['EVAL',script,'1',key,String(RATE_LIMIT_WINDOW_SECONDS+30)]))||0;
  return count<=RATE_LIMIT_MAX;
}

function windows(now){
  const start=now-LOOKBACK_DAYS*24*60*60*1000;
  const out=[];
  for(let from=start;from<now;from+=WINDOW_MS){
    out.push({startTime:from,endTime:Math.min(now,from+WINDOW_MS-1)});
  }
  return out;
}
function uniqueRecentManagedSymbols(orders){
  const seen=new Set(),out=[];
  const sorted=(Array.isArray(orders)?orders:[])
    .filter(o=>/^zth-[A-Za-z0-9._:-]{6,36}$/.test(String(o?.clientOrderId||'')))
    .sort((a,b)=>Number(b?.updateTime??b?.time??0)-Number(a?.updateTime??a?.time??0));
  for(const row of sorted){
    const symbol=String(row?.symbol||'').toUpperCase();
    if(!symbol||seen.has(symbol))continue;
    seen.add(symbol);out.push(symbol);
    if(out.length>=MAX_SYMBOLS)break;
  }
  return out;
}

export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});

  let device;
  try{device=await requireZenithDevice(req)}
  catch(e){return send(res,503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR'})}
  if(!device)return send(res,401,{ok:false,code:'UNAUTHORIZED_DEVICE'});

  const cached=parseJson(await redis(['GET',CACHE_KEY]).catch(()=>null));
  if(cached&&Number(cached.generatedAt)>Date.now()-CACHE_TTL_SECONDS*1000){
    return send(res,200,{ok:true,cached:true,...cached});
  }

  try{
    if(!(await rateAllowed(device.deviceId))){
      return send(res,429,{ok:false,code:'REAL_HISTORY_RATE_LIMITED',retryAfterSeconds:60});
    }
  }catch(e){
    return send(res,503,{ok:false,code:e?.code||'RATE_LIMIT_BACKEND_ERROR'});
  }

  const apiKey=process.env.BINANCE_API_KEY;
  const secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV'});

  try{
    const time=await fetch(BASE+'/fapi/v1/time').then(r=>r.ok?r.json():Promise.reject(new Error('BINANCE_TIME_FAILED')));
    const offset=Number(time?.serverTime)-Date.now();
    if(!Number.isFinite(offset))throw new Error('BINANCE_TIME_INVALID');
    const timestamp=()=>Date.now()+offset;
    const periods=windows(Date.now());

    const orders=[];
    for(const period of periods){
      const rows=await signedBinanceRequest({
        apiKey,secret,path:'/fapi/v1/allOrders',method:'GET',timestamp:timestamp(),
        params:{startTime:period.startTime,endTime:period.endTime,limit:1000},
      });
      if(Array.isArray(rows))orders.push(...rows);
    }

    const symbols=uniqueRecentManagedSymbols(orders);
    const trades=[];
    for(const symbol of symbols){
      for(const period of periods){
        const rows=await signedBinanceRequest({
          apiKey,secret,path:'/fapi/v1/userTrades',method:'GET',timestamp:timestamp(),
          params:{symbol,startTime:period.startTime,endTime:period.endTime,limit:1000},
        });
        if(Array.isArray(rows))trades.push(...rows);
      }
    }

    const incomes=[];
    for(const incomeType of ['FUNDING_FEE','COMMISSION_REBATE']){
      for(const period of periods){
        const rows=await signedBinanceRequest({
          apiKey,secret,path:'/fapi/v1/income',method:'GET',timestamp:timestamp(),
          params:{incomeType,startTime:period.startTime,endTime:period.endTime,limit:1000},
        });
        if(Array.isArray(rows))incomes.push(...rows);
      }
    }

    const orderIndex=managedOrderIndex(orders);
    const history=buildClosedZenithTradeHistory({orders,trades,incomes,maxRows:80});
    const payload={
      generatedAt:Date.now(),
      lookbackDays:LOOKBACK_DAYS,
      symbols,
      managedOrders:orderIndex.ids.size,
      exactRows:history.filter(row=>row.exactNet===true).length,
      history,
    };
    await redis(['SET',CACHE_KEY,JSON.stringify(payload),'EX',String(CACHE_TTL_SECONDS)]).catch(()=>{});
    return send(res,200,{ok:true,cached:false,...payload});
  }catch(e){
    return send(res,502,{
      ok:false,
      code:'BINANCE_REAL_HISTORY_FAILED',
      error:'Historique Binance indisponible.',
      binanceCode:e?.binanceCode??(typeof e?.code==='number'?e.code:null),
    });
  }
}
