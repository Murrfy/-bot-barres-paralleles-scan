import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation } from '../lib/device-session.mjs';
import { buildExitOrderPlan } from '../lib/order-intent.mjs';
import {
  placeStandardOrderIdempotent,
  modifyStandardLimitOrderIdempotent,
  BinanceRequestError,
} from '../lib/binance-order-writer.mjs';
import {
  placeAlgoOrderIdempotent,
  cancelAlgoOrderIdempotent,
  queryAlgoByClientId,
} from '../lib/binance-algo-order-writer.mjs';
import {
  runtimePositionQuantity,
  selectExactExitOrder,
  selectProtectionOrder,
  buildProtectionReplacementPlan,
  validateProtectionTrigger,
} from '../lib/protective-mutation-state.mjs';
import {
  validateExecutionArmRecord,
  protectiveModeReason,
  executionReadiness,
} from './binance-protective-execute.js';

const BASE='https://fapi.binance.com';
const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_STATE=`${PREFIX}:state`;
const KEY_RECONCILE_LAST=`${PREFIX}:reconcile:last`;
const KEY_AUDIT=`${PREFIX}:audit`;
const KEY_REAL_EXECUTION_ARMED=`${PREFIX}:safety:real-execution-armed`;

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
const PROTECTIVE_MUTATION_ENABLED=process.env.ZENITH_PROTECTIVE_MUTATION_ENABLED==='1';

function send(res,status,body){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  return res.status(status).json(body);
}
function sha256(value){return crypto.createHash('sha256').update(String(value)).digest('hex')}
function n(value,fallback=0){const x=Number(value);return Number.isFinite(x)?x:fallback}
function bool(value){return value===true||value==='true'}
function nearly(a,b){const aa=n(a,NaN),bb=n(b,NaN);return Number.isFinite(aa)&&Number.isFinite(bb)&&Math.abs(aa-bb)<=Math.max(1e-12,Math.abs(bb)*1e-10)}
function parseJson(raw){try{return raw?JSON.parse(raw):null}catch{return null}}

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
    const device=parseJson(raw);
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
async function jsonFetch(url){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(url,{cache:'no-store',signal:controller.signal});
    const text=await r.text();
    let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    if(!r.ok){
      const e=new Error(data?.msg||`Binance HTTP ${r.status}`);
      e.status=r.status;e.binanceCode=data?.code;throw e;
    }
    return data;
  }finally{clearTimeout(timer)}
}
async function liveContext(masterDeviceId){
  const [runtimeRaw,reportRaw,armRaw]=await Promise.all([
    redis(['GET',KEY_STATE]),
    redis(['GET',KEY_RECONCILE_LAST]),
    redis(['GET',KEY_REAL_EXECUTION_ARMED]),
  ]);
  const runtimeState=parseJson(runtimeRaw);
  const report=parseJson(reportRaw);
  const armRecord=parseJson(armRaw);
  const armReason=validateExecutionArmRecord(armRecord,masterDeviceId);
  if(armReason)return {ok:false,reason:armReason,runtimeState,report};
  const modeRaw=await redis(['GET',`${PREFIX}:master-mode`]);
  const modeReason=protectiveModeReason(modeRaw);
  if(modeReason)return {ok:false,reason:modeReason,runtimeState,report};
  const readinessReason=executionReadiness(runtimeState,report,masterDeviceId);
  if(readinessReason)return {ok:false,reason:readinessReason,runtimeState,report};
  return {ok:true,runtimeState,report};
}
function priceFilter(symbolInfo){
  return (Array.isArray(symbolInfo?.filters)?symbolInfo.filters:[]).find(f=>f?.filterType==='PRICE_FILTER')||{};
}
function aligned(price,tick){
  const p=n(price,NaN),t=n(tick,NaN);
  if(!Number.isFinite(p)||!Number.isFinite(t)||!(t>0))return true;
  const units=p/t;
  return Math.abs(units-Math.round(units))<=1e-8;
}
function validateExchangePrice(symbolInfo,price){
  const p=n(price,NaN),f=priceFilter(symbolInfo),tick=n(f.tickSize),min=n(f.minPrice),max=n(f.maxPrice);
  if(!(p>0))return {ok:false,reason:'PRICE_INVALID'};
  if(min>0&&p<min)return {ok:false,reason:'PRICE_BELOW_EXCHANGE_MIN'};
  if(max>0&&p>max)return {ok:false,reason:'PRICE_ABOVE_EXCHANGE_MAX'};
  if(tick>0&&!aligned(p,tick))return {ok:false,reason:'PRICE_NOT_TICK_ALIGNED'};
  return {ok:true,tickSize:tick};
}
function validateProtectionIdentity(order,{symbol,direction,triggerPrice,clientAlgoId}={}){
  const side=String(direction||'').toUpperCase()==='LONG'?'SELL':'BUY';
  return Boolean(
    order&&
    String(order.clientAlgoId||'')===String(clientAlgoId||'')&&
    String(order.symbol||'').toUpperCase()===String(symbol||'').toUpperCase()&&
    String(order.side||'').toUpperCase()===side&&
    String(order.positionSide||'BOTH').toUpperCase()==='BOTH'&&
    String(order.orderType||order.type||'').toUpperCase()==='STOP_MARKET'&&
    bool(order.closePosition)&&!bool(order.reduceOnly)&&
    nearly(order.triggerPrice,triggerPrice)
  );
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

  const type=String(req.body?.type||'').toUpperCase();
  if(!['EXEC_UPDATE_EXIT','EXEC_UPDATE_PROTECTION'].includes(type)){
    return send(res,400,{ok:false,code:'PROTECTIVE_MUTATION_UNSUPPORTED',writeAttempted:false});
  }

  const symbol=String(req.body?.symbol||'').trim().toUpperCase();
  const direction=String(req.body?.direction||'').toUpperCase();
  const requestedQty=n(req.body?.quantity,NaN);
  const commandId=String(req.body?.commandId||'');
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!['LONG','SHORT'].includes(direction)||
     !/^[A-Za-z0-9._:-]{8,128}$/.test(commandId)||!(requestedQty>0)){
    return send(res,400,{ok:false,code:'PROTECTIVE_MUTATION_REQUEST_INVALID',writeAttempted:false});
  }

  const apiKey=process.env.BINANCE_API_KEY,secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV',writeAttempted:false});

  let context;
  try{context=await liveContext(master.deviceId)}
  catch(e){return send(res,503,{ok:false,code:'EXECUTION_STATE_UNAVAILABLE',error:e?.message,writeAttempted:false})}
  if(!context.ok)return send(res,423,{ok:false,code:'EXECUTION_NOT_READY',reason:context.reason,writeAttempted:false});

  const liveQty=runtimePositionQuantity(context.runtimeState,symbol,direction);
  if(!(liveQty>0))return send(res,409,{ok:false,code:'POSITION_NOT_FOUND',writeAttempted:false});
  if(Math.abs(liveQty-requestedQty)>1e-12){
    return send(res,409,{ok:false,code:'LIVE_POSITION_QUANTITY_MISMATCH',liveQuantity:liveQty,writeAttempted:false});
  }

  let market;
  try{
    const [exchangeInfo,premiumIndex,time]=await Promise.all([
      jsonFetch(`${BASE}/fapi/v1/exchangeInfo`),
      jsonFetch(`${BASE}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`),
      jsonFetch(`${BASE}/fapi/v1/time`),
    ]);
    const symbolInfo=(Array.isArray(exchangeInfo?.symbols)?exchangeInfo.symbols:[])
      .find(x=>String(x?.symbol||'').toUpperCase()===symbol)||null;
    if(!symbolInfo||String(symbolInfo.status||'')!=='TRADING')throw new Error('SYMBOL_NOT_TRADING');
    market={symbolInfo,markPrice:n(premiumIndex?.markPrice,NaN),serverTime:n(time?.serverTime,NaN)};
    if(!(market.markPrice>0)||!(market.serverTime>0))throw new Error('BINANCE_MARKET_STATE_INVALID');
  }catch(e){
    return send(res,502,{ok:false,code:'BINANCE_MARKET_STATE_UNAVAILABLE',error:e?.message,writeAttempted:false});
  }

  const writesEnabled=Boolean(
    REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&PROTECTIVE_MUTATION_ENABLED
  );

  if(type==='EXEC_UPDATE_EXIT'){
    const targetPrice=n(req.body?.targetPrice,NaN);
    const requestedClientOrderId=String(req.body?.clientOrderId||'');
    const priceStatus=validateExchangePrice(market.symbolInfo,targetPrice);
    if(!priceStatus.ok)return send(res,409,{ok:false,code:priceStatus.reason,writeAttempted:false});

    const selected=selectExactExitOrder(context.runtimeState,{
      symbol,direction,clientOrderId:requestedClientOrderId
    });
    if(selected.reason==='EXIT_ORDER_AMBIGUOUS'){
      return send(res,409,{ok:false,code:selected.reason,writeAttempted:false});
    }
    if(requestedClientOrderId&&!selected.order){
      return send(res,409,{ok:false,code:'EXIT_ORDER_NOT_FOUND',writeAttempted:false});
    }

    let plan,result,clientOrderId;
    try{
      if(selected.order){
        if(n(selected.order.executedQty)>1e-12){
          return send(res,409,{ok:false,code:'EXIT_ORDER_PARTIALLY_FILLED',writeAttempted:false});
        }
        clientOrderId=String(selected.order.clientOrderId||'');
        plan={
          mode:'MODIFY_EXISTING',
          symbol,direction,quantity:liveQty,targetPrice,clientOrderId,
        };
        if(!writesEnabled){
          return send(res,423,{ok:false,code:'PROTECTIVE_MUTATION_WRITE_LOCKED',writeAttempted:false,plan});
        }
        result=await modifyStandardLimitOrderIdempotent({
          apiKey,secret,symbol,clientOrderId,
          side:direction==='LONG'?'SELL':'BUY',
          quantity:liveQty,price:targetPrice,
          writesEnabled:true,timestamp:market.serverTime,
        });
      }else{
        plan=buildExitOrderPlan({
          commandId,symbol,direction,quantity:liveQty,
          exitMode:'NORMAL_LIMIT',targetPrice,
        });
        clientOrderId=String(plan.params.newClientOrderId||'');
        if(!writesEnabled){
          return send(res,423,{ok:false,code:'PROTECTIVE_MUTATION_WRITE_LOCKED',writeAttempted:false,plan});
        }
        result=await placeStandardOrderIdempotent({
          apiKey,secret,orderParams:plan.params,writesEnabled:true,timestamp:market.serverTime,
        });
      }
      await audit({
        at:Date.now(),kind:'BINANCE_EXIT_UPDATE_DISPATCH',deviceId:master.deviceId,
        commandId,symbol,direction,quantity:liveQty,targetPrice,clientOrderId,
        disposition:result?.disposition,writeAttempted:result?.writeAttempted===true,
      });
      return send(res,200,{
        ok:true,confirmationRequired:true,clientOrderId,plan,result,
      });
    }catch(e){
      return send(res,502,{
        ok:false,
        code:['ORDER_MODIFY_RESULT_AMBIGUOUS','ORDER_RESULT_AMBIGUOUS'].includes(e?.message)
          ?e.message:'BINANCE_EXIT_UPDATE_FAILED',
        error:e?.message||'Exit update failed.',
        binanceCode:e?.code??null,
        ambiguous:e?.ambiguous===true,
        writeAttempted:true,
      });
    }
  }

  const triggerPrice=n(req.body?.triggerPrice,NaN);
  const requestedPrevious=String(req.body?.previousClientAlgoId||'');
  const priceStatus=validateExchangePrice(market.symbolInfo,triggerPrice);
  if(!priceStatus.ok)return send(res,409,{ok:false,code:priceStatus.reason,writeAttempted:false});
  const triggerStatus=validateProtectionTrigger({direction,triggerPrice,markPrice:market.markPrice});
  if(!triggerStatus.ok)return send(res,409,{ok:false,code:triggerStatus.reason,markPrice:market.markPrice,writeAttempted:false});

  const replacementPlan=buildProtectionReplacementPlan({commandId,symbol,direction,triggerPrice});
  const replacementClientAlgoId=replacementPlan.clientAlgoId;
  let selected=selectProtectionOrder(context.runtimeState,{
    symbol,direction,clientAlgoId:requestedPrevious
  });
  if(!requestedPrevious&&selected.reason==='PROTECTION_ORDER_AMBIGUOUS'){
    return send(res,409,{ok:false,code:selected.reason,writeAttempted:false});
  }
  const previous=selected.order;
  if(requestedPrevious&&!previous){
    // Recovery is allowed only if the deterministic replacement already exists and is exact.
    try{
      const recovered=await queryAlgoByClientId({
        apiKey,secret,clientAlgoId:replacementClientAlgoId,timestamp:market.serverTime,
      });
      if(!validateProtectionIdentity(recovered,{symbol,direction,triggerPrice,clientAlgoId:replacementClientAlgoId})){
        return send(res,409,{ok:false,code:'PREVIOUS_PROTECTION_NOT_FOUND',writeAttempted:false});
      }
    }catch(e){
      return send(res,409,{ok:false,code:'PREVIOUS_PROTECTION_NOT_FOUND',writeAttempted:false});
    }
  }
  if(previous&&nearly(previous.triggerPrice??previous.stopPrice,triggerPrice)){
    return send(res,200,{
      ok:true,confirmationRequired:true,noChange:true,
      replacementClientAlgoId:String(previous.clientAlgoId||''),
      previousClientAlgoId:String(previous.clientAlgoId||''),
      result:{ok:true,disposition:'EXISTING_MATCH',writeAttempted:false,order:previous},
    });
  }

  if(!writesEnabled){
    return send(res,423,{
      ok:false,code:'PROTECTIVE_MUTATION_WRITE_LOCKED',writeAttempted:false,
      replacementPlan,
      previousClientAlgoId:String(previous?.clientAlgoId||requestedPrevious||''),
      markPrice:market.markPrice,
    });
  }

  try{
    const placed=await placeAlgoOrderIdempotent({
      apiKey,secret,algoParams:replacementPlan.params,writesEnabled:true,timestamp:market.serverTime,
    });
    const verified=await queryAlgoByClientId({
      apiKey,secret,clientAlgoId:replacementClientAlgoId,timestamp:market.serverTime+1,
    });
    if(!validateProtectionIdentity(verified,{symbol,direction,triggerPrice,clientAlgoId:replacementClientAlgoId})){
      throw new BinanceRequestError('PROTECTION_REPLACEMENT_IDENTITY_MISMATCH',{
        data:verified,ambiguous:true,
      });
    }

    const previousClientAlgoId=String(previous?.clientAlgoId||requestedPrevious||'');
    let canceled=null;
    if(previousClientAlgoId&&previousClientAlgoId!==replacementClientAlgoId){
      canceled=await cancelAlgoOrderIdempotent({
        apiKey,secret,clientAlgoId:previousClientAlgoId,writesEnabled:true,timestamp:market.serverTime+2,
      });
      if(canceled?.disposition==='ALREADY_TRIGGERED'){
        let cleanup=null;
        try{
          cleanup=await cancelAlgoOrderIdempotent({
            apiKey,secret,clientAlgoId:replacementClientAlgoId,writesEnabled:true,timestamp:market.serverTime+3,
          });
        }catch(cleanupError){
          throw new BinanceRequestError('PROTECTION_RACE_CLEANUP_AMBIGUOUS',{
            data:{previousClientAlgoId,replacementClientAlgoId,cleanupError:cleanupError?.message},
            ambiguous:true,
          });
        }
        await audit({
          at:Date.now(),kind:'PROTECTION_REPLACE_OLD_TRIGGERED',deviceId:master.deviceId,
          commandId,symbol,direction,previousClientAlgoId,replacementClientAlgoId,
          cleanupDisposition:cleanup?.disposition,
        });
        return send(res,409,{
          ok:false,code:'PROTECTION_RACE_OLD_TRIGGERED',
          reconciliationRequired:true,writeAttempted:true,
          previousClientAlgoId,replacementClientAlgoId,
          cleanup,
        });
      }
    }

    await audit({
      at:Date.now(),kind:'BINANCE_PROTECTION_REPLACE_DISPATCH',deviceId:master.deviceId,
      commandId,symbol,direction,quantity:liveQty,triggerPrice,markPrice:market.markPrice,
      previousClientAlgoId,replacementClientAlgoId,
      placementDisposition:placed?.disposition,
      cancellationDisposition:canceled?.disposition||'NO_PREVIOUS',
      writeAttempted:true,
    });
    return send(res,200,{
      ok:true,confirmationRequired:true,
      replacementClientAlgoId,previousClientAlgoId,
      replacementPlan,placed,canceled,
    });
  }catch(e){
    return send(res,502,{
      ok:false,
      code:['ALGO_ORDER_RESULT_AMBIGUOUS','ALGO_CANCEL_RESULT_AMBIGUOUS','PROTECTION_RACE_CLEANUP_AMBIGUOUS']
        .includes(e?.message)?e.message:'BINANCE_PROTECTION_UPDATE_FAILED',
      error:e?.message||'Protection update failed.',
      binanceCode:e?.code??null,
      ambiguous:e?.ambiguous===true,
      writeAttempted:true,
      replacementClientAlgoId,
      previousClientAlgoId:String(previous?.clientAlgoId||requestedPrevious||''),
    });
  }
}

export { validateExchangePrice, validateProtectionIdentity };
