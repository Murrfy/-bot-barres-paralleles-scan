import crypto from 'node:crypto';
import {
  deviceTokenCandidates,deviceSessionRecordActive,roleAssignmentKey,deviceRoleAssignmentActive,
  engineInstanceHeader,enginePrincipalInstanceActive
} from '../lib/device-session.mjs';
import { buildZenithClosedTradeHistory, mergeTradeHistory } from '../lib/real-trade-history.mjs';

const BASE='https://fapi.binance.com';
const RECV_WINDOW=5000;
const PREFIX='zenith:v1';
const KEY_ARCHIVE=`${PREFIX}:real-history:archive`;
const KEY_CACHE=`${PREFIX}:real-history:cache`;
const HISTORY_CACHE_MS=60000;
const HISTORY_LOOKBACK_MS=30*24*60*60*1000;
const HISTORY_WINDOW_MS=(7*24*60*60*1000)-1;
const HISTORY_SYMBOL_LIMIT=100;
const BINANCE_HISTORY_RATE_LIMIT_PER_MINUTE=6;

const REDIS_URL=
  process.env.UPSTASH_REDIS_REST_URL||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL||
  process.env.KV_REST_API_URL||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;
const REDIS_TOKEN=
  process.env.UPSTASH_REDIS_REST_TOKEN||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN||
  process.env.KV_REST_API_TOKEN;

function sha256(v){return crypto.createHash('sha256').update(String(v)).digest('hex')}
function parseJson(raw){try{return raw?JSON.parse(raw):null}catch{return null}}
function send(res,status,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
}
async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN){
    const e=new Error('UPSTASH_NOT_CONFIGURED');e.code='UPSTASH_NOT_CONFIGURED';throw e;
  }
  const r=await fetch(REDIS_URL,{
    method:'POST',
    headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify(command),
    signal:AbortSignal.timeout(8000),
    cache:'no-store',
  });
  const text=await r.text();let data={};
  try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok||data?.error){
    const e=new Error(data?.error||`Redis HTTP ${r.status}`);e.code='REDIS_ERROR';throw e;
  }
  return data?.result;
}
async function requireZenithDevice(req){
  for(const token of deviceTokenCandidates(req)){
    const tokenHash=sha256(token);
    const raw=await redis(['GET',`${PREFIX}:device:${tokenHash}`]);
    if(!raw)continue;
    let device=null;try{device=JSON.parse(raw)}catch{}
    if(!deviceSessionRecordActive(device)||!device?.deviceId||!['controller','master'].includes(device?.role))continue;
    const roleKey=device.role==='master'?`${PREFIX}:role-device:master`:`${PREFIX}:role-device:controller`;
    const owner=await redis(['GET',roleKey]);
    if(String(owner||'')!==String(device.deviceId))continue;
    const issuedAt=await redis(['GET',roleAssignmentKey(PREFIX,device.role)]);
    if(!deviceRoleAssignmentActive(device,issuedAt))continue;
    if(String(device?.principal||'')==='engine'){
      const suppliedInstance=engineInstanceHeader(req);
      const [currentInstance,currentLease]=await Promise.all([
        redis(['GET',`${PREFIX}:engine-instance`]),
        redis(['GET',`${PREFIX}:master`]),
      ]);
      if(!enginePrincipalInstanceActive(device,suppliedInstance,String(currentInstance||''))){
        const e=new Error('ENGINE_INSTANCE_FENCED');e.code='ENGINE_INSTANCE_FENCED';throw e;
      }
      if(String(currentLease||'')!==String(device.deviceId||'')){
        const e=new Error('MASTER_LEASE_REQUIRED');e.code='MASTER_LEASE_REQUIRED';throw e;
      }
    }
    return device;
  }
  return null;
}
async function historyRateAllowed(deviceId){
  const bucket=Math.floor(Date.now()/60000);
  const key=`${PREFIX}:rate:binance-history:${sha256(deviceId)}:${bucket}`;
  const script=[
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count=Number(await redis(['EVAL',script,'1',key,'120']))||0;
  return count<=BINANCE_HISTORY_RATE_LIMIT_PER_MINUTE;
}
function retryAfterSeconds(){return Math.max(1,60-(Math.floor(Date.now()/1000)%60))}
async function jsonFetch(url,init={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(url,{...init,cache:'no-store',signal:controller.signal});
    const text=await r.text();let data={};
    try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    if(!r.ok){
      const e=new Error(data?.msg||`Binance HTTP ${r.status}`);
      e.status=r.status;e.binanceCode=data?.code;throw e;
    }
    return data;
  }finally{clearTimeout(timer)}
}
async function signedGet(path,apiKey,secret,timestamp,extra={}){
  const params=new URLSearchParams({timestamp:String(Math.floor(timestamp)),recvWindow:String(RECV_WINDOW)});
  for(const [key,value] of Object.entries(extra||{})){
    if(value!==undefined&&value!==null&&value!=='')params.set(key,String(value));
  }
  const signature=crypto.createHmac('sha256',secret).update(params.toString()).digest('hex');
  params.set('signature',signature);
  return jsonFetch(`${BASE}${path}?${params.toString()}`,{headers:{'X-MBX-APIKEY':apiKey}});
}
function windowsFor(now){
  const endNow=Math.max(0,Math.floor(Number(now)||0));
  const start=Math.max(0,endNow-HISTORY_LOOKBACK_MS);
  const out=[];
  let from=start;
  while(from<=endNow){
    const endTime=Math.min(endNow,from+HISTORY_WINDOW_MS);
    out.push({startTime:from,endTime});
    if(endTime>=endNow)break;
    from=endTime+1;
  }
  return out;
}
function zenithOrder(order){
  return /^zth-[A-Za-z0-9]{3}-[A-Za-z0-9._:-]+$/.test(String(order?.clientOrderId||''));
}
async function mapLimit(items,limit,fn){
  const list=Array.isArray(items)?items:[];
  if(!list.length)return [];
  const results=new Array(list.length);
  let cursor=0;
  async function worker(){
    while(true){
      const index=cursor++;
      if(index>=list.length)return;
      results[index]=await fn(list[index],index);
    }
  }
  const workers=Array.from({length:Math.min(Math.max(1,limit),list.length)},()=>worker());
  await Promise.all(workers);
  return results;
}
function assertHistoryArray(rows,kind){
  if(!Array.isArray(rows)){
    const e=new Error('BINANCE_HISTORY_RESPONSE_INVALID');e.code='BINANCE_HISTORY_RESPONSE_INVALID';throw e;
  }
  if(rows.length>=1000){
    const e=new Error('BINANCE_HISTORY_WINDOW_TRUNCATED');e.code='BINANCE_HISTORY_WINDOW_TRUNCATED';e.kind=kind;throw e;
  }
  return rows;
}
function uniqueRows(rows,keyFn){
  const map=new Map();
  for(const row of rows){
    const key=keyFn(row);
    if(key)map.set(key,row);
  }
  return [...map.values()];
}
async function fetchRecentHistory(apiKey,secret,serverTime){
  const windows=windowsFor(serverTime);
  const offset=serverTime-Date.now();
  const signedNow=()=>Date.now()+offset;

  const orderChunks=await mapLimit(windows,3,async window=>{
    const rows=await signedGet('/fapi/v1/allOrders',apiKey,secret,signedNow(),{...window,limit:1000});
    return assertHistoryArray(rows,'orders');
  });
  const orders=uniqueRows(orderChunks.flat(),row=>String(row?.symbol||'')+':'+String(row?.orderId??''));
  const symbols=[...new Set(
    orders.filter(zenithOrder).map(row=>String(row?.symbol||'').toUpperCase()).filter(Boolean)
  )].sort();
  if(symbols.length>HISTORY_SYMBOL_LIMIT){
    const e=new Error('BINANCE_HISTORY_SYMBOL_LIMIT');e.code='BINANCE_HISTORY_SYMBOL_LIMIT';throw e;
  }
  if(!symbols.length)return {trades:[],orders,funding:[],symbols:[]};

  const jobs=[];
  for(const window of windows){
    for(const symbol of symbols)jobs.push({window,symbol});
  }
  const tradeChunks=await mapLimit(jobs,4,async job=>{
    const rows=await signedGet('/fapi/v1/userTrades',apiKey,secret,signedNow(),{
      symbol:job.symbol,...job.window,limit:1000
    });
    return assertHistoryArray(rows,'trades');
  });
  const fundingChunks=await mapLimit(windows,3,async window=>{
    const rows=await signedGet('/fapi/v1/income',apiKey,secret,signedNow(),{
      ...window,incomeType:'FUNDING_FEE',limit:1000
    });
    return assertHistoryArray(rows,'funding');
  });

  const trades=uniqueRows(
    tradeChunks.flat(),
    row=>String(row?.symbol||'')+':'+String(row?.id??row?.tradeId??'')+':'+String(row?.orderId??'')
  );
  const funding=uniqueRows(
    fundingChunks.flat(),
    row=>String(row?.incomeType||'')+':'+String(row?.tranId??row?.tradeId??'')+':'+String(row?.symbol||'')+':'+String(row?.time??'')
  );
  return {trades,orders,funding,symbols};
}

export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  let device=null;
  try{device=await requireZenithDevice(req)}
  catch(e){
    if(e?.code==='ENGINE_INSTANCE_FENCED'||e?.code==='MASTER_LEASE_REQUIRED'){
      return send(res,409,{ok:false,code:e.code,error:'Autorité moteur Zenith invalide.'});
    }
    return send(res,503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR',error:'Authentification Zenith indisponible.'});
  }
  if(!device)return send(res,401,{ok:false,code:'UNAUTHORIZED_DEVICE',error:'Appareil Zenith autorisé requis.'});

  try{
    const cached=parseJson(await redis(['GET',KEY_CACHE]));
    if(cached?.ok===true&&Date.now()-Number(cached.generatedAt||0)<HISTORY_CACHE_MS){
      return send(res,200,{...cached,cached:true});
    }
  }catch{}

  try{
    if(!(await historyRateAllowed(device.deviceId))){
      const retryAfter=retryAfterSeconds();
      res.setHeader('Retry-After',String(retryAfter));
      return send(res,429,{ok:false,code:'BINANCE_HISTORY_RATE_LIMIT',retryAfterSeconds:retryAfter});
    }
  }catch{
    return send(res,503,{ok:false,code:'RATE_LIMIT_BACKEND_ERROR',error:'Protection anti-abus indisponible.'});
  }

  const apiKey=process.env.BINANCE_API_KEY;
  const secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV',error:'Variables Binance lecture absentes.'});

  try{
    const time=await jsonFetch(`${BASE}/fapi/v1/time`);
    const serverTime=Number(time?.serverTime);
    if(!Number.isFinite(serverTime)){
      const e=new Error('BINANCE_TIME_INVALID');e.code='BINANCE_TIME_INVALID';throw e;
    }
    const raw=await fetchRecentHistory(apiKey,secret,serverTime);
    const fresh=buildZenithClosedTradeHistory(raw);
    const archived=parseJson(await redis(['GET',KEY_ARCHIVE]));
    const history=mergeTradeHistory(Array.isArray(archived)?archived:[],fresh,500);
    const totals=history.reduce((acc,row)=>{
      if(Number.isFinite(Number(row?.netUsdt))){
        const value=Number(row.netUsdt);
        if(value>=0)acc.gain+=value;else acc.loss+=Math.abs(value);
        acc.net+=value;
      }
      return acc;
    },{gain:0,loss:0,net:0});
    const payload={
      ok:true,
      source:'BINANCE_REAL',
      generatedAt:Date.now(),
      lookbackDays:30,
      symbols:raw.symbols,
      history,
      totals,
    };
    await redis(['SET',KEY_ARCHIVE,JSON.stringify(history)]);
    await redis(['SET',KEY_CACHE,JSON.stringify(payload),'EX','60']);
    return send(res,200,{...payload,cached:false});
  }catch(e){
    const code=String(e?.code||'BINANCE_HISTORY_FAILED');
    const conflict=['BINANCE_HISTORY_WINDOW_TRUNCATED','BINANCE_HISTORY_SYMBOL_LIMIT'].includes(code);
    return send(res,conflict?409:502,{
      ok:false,
      code,
      error:code==='BINANCE_HISTORY_WINDOW_TRUNCATED'
        ?'Historique Binance trop dense pour être certifié sans pagination supplémentaire.'
        :code==='BINANCE_HISTORY_SYMBOL_LIMIT'
          ?'Trop de symboles Zenith distincts pour une lecture certifiée en une seule requête.'
          :'Historique Binance indisponible.',
      binanceCode:e?.binanceCode??null,
    });
  }
}

export { windowsFor, fetchRecentHistory, zenithOrder };
