import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation, deviceSessionRecordActive } from '../lib/device-session.mjs';
import { buildExitOrderPlan } from '../lib/order-intent.mjs';
import { buildProtectiveAlgoPlan } from '../lib/protective-update-intent.mjs';
import { normalizeProtectiveUpdatePayload, validateUpdateAgainstLivePosition, protectiveRepairTarget, orphanZenithCleanupOrders } from '../lib/protective-command.mjs';
import { validateMaxLossTrigger } from '../lib/real-protection-levels.mjs';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';
import {
  placeStandardOrderIdempotent,
  cancelReduceOnlyOrderIdempotent,
  signedBinanceRequest,
} from '../lib/binance-order-writer.mjs';
import {
  placeAlgoOrderIdempotent,
  cancelAlgoOrderIdempotent,
} from '../lib/binance-algo-writer.mjs';
import { validateExecutionArmRecord, protectiveModeReason, executionReadiness } from './binance-protective-execute.js';

const BASE='https://fapi.binance.com';
const PREFIX='zenith:v1';
const KEY_MASTER=`${PREFIX}:master`;
const KEY_MASTER_DEVICE=`${PREFIX}:role-device:master`;
const KEY_STATE=`${PREFIX}:state`;
const KEY_RECONCILE_LAST=`${PREFIX}:reconcile:last`;
const KEY_AUDIT=`${PREFIX}:audit`;
const KEY_REAL_EXECUTION_ARMED=`${PREFIX}:safety:real-execution-armed`;
const KEY_MASTER_MODE=`${PREFIX}:master-mode`;

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
function sha256(v){return crypto.createHash('sha256').update(String(v)).digest('hex')}
function parseJson(raw){try{return raw?JSON.parse(raw):null}catch{return null}}
function n(v,fallback=NaN){const x=Number(v);return Number.isFinite(x)?x:fallback}
function bool(v){return v===true||v==='true'}
function terminalStandard(status){
  return ['FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(String(status||'').toUpperCase());
}
function terminalAlgo(status){
  return ['CANCELED','TRIGGERED','FINISHED','REJECTED','EXPIRED'].includes(String(status||'').toUpperCase());
}
function sideForDirection(direction){return String(direction).toUpperCase()==='LONG'?'SELL':'BUY'}
function managedExitId(value){
  const id=String(value||'');
  return /^zth-EXI-[A-Za-z0-9._:-]+$/.test(id)&&id.length<=36;
}

async function redis(command){
  if(!REDIS_URL||!REDIS_TOKEN)throw new Error('UPSTASH_NOT_CONFIGURED');
  const r=await fetch(REDIS_URL,{
    method:'POST',headers:{Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify(command),cache:'no-store',
  });
  const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok||data?.error)throw new Error(data?.error||`Redis HTTP ${r.status}`);
  return data?.result;
}
async function requireCurrentMaster(req){
  for(const token of deviceTokenCandidates(req)){
    const tokenHash=sha256(token),raw=await redis(['GET',`${PREFIX}:device:${tokenHash}`]);
    if(!raw)continue;
    const device=parseJson(raw);
    if(!deviceSessionRecordActive(device)||!device?.deviceId||device.role!=='master')continue;
    const [registered,lease]=await Promise.all([redis(['GET',KEY_MASTER_DEVICE]),redis(['GET',KEY_MASTER])]);
    if(String(registered||'')!==String(device.deviceId))continue;
    if(String(lease||'')!==String(device.deviceId)){
      const e=new Error('MASTER_LEASE_REQUIRED');e.code='MASTER_LEASE_REQUIRED';throw e;
    }
    return device;
  }
  return null;
}
async function readState(){
  const [runtimeRaw,reportRaw,armRaw,modeRaw]=await Promise.all([
    redis(['GET',KEY_STATE]),redis(['GET',KEY_RECONCILE_LAST]),
    redis(['GET',KEY_REAL_EXECUTION_ARMED]),redis(['GET',KEY_MASTER_MODE]),
  ]);
  return {
    runtimeState:parseJson(runtimeRaw),report:parseJson(reportRaw),
    armRecord:parseJson(armRaw),masterMode:String(modeRaw||'PAUSED').toUpperCase(),
  };
}
function runtimePosition(runtimeState,symbol,direction){
  const list=Array.isArray(runtimeState?.data?.binancePositions)?runtimeState.data.binancePositions:[];
  const sym=String(symbol||'').toUpperCase(),dir=String(direction||'').toUpperCase();
  return list.find(p=>{
    if(String(p?.symbol||'').toUpperCase()!==sym)return false;
    const amount=n(p?.positionAmt??p?.quantity,0);
    const actual=amount<0?'SHORT':'LONG';
    return actual===dir&&Math.abs(amount)>0;
  })||null;
}
function runtimeOrders(runtimeState){
  return Array.isArray(runtimeState?.data?.binanceOrders)?runtimeState.data.binanceOrders:[];
}
function findStandard(runtimeState,symbol,clientOrderId){
  return runtimeOrders(runtimeState).find(o=>
    String(o?.orderClass||'STANDARD').toUpperCase()==='STANDARD' &&
    String(o?.symbol||'').toUpperCase()===String(symbol||'').toUpperCase() &&
    String(o?.clientOrderId||'')===String(clientOrderId||'')
  )||null;
}
function findAlgo(runtimeState,symbol,clientAlgoId){
  return runtimeOrders(runtimeState).find(o=>
    String(o?.orderClass||'').toUpperCase()==='ALGO' &&
    String(o?.symbol||'').toUpperCase()===String(symbol||'').toUpperCase() &&
    String(o?.clientAlgoId||'')===String(clientAlgoId||'')
  )||null;
}
export function emergencyProtection(runtimeState,update,entryPrice,excludeClientAlgoId=''){
  const side=sideForDirection(update.direction);
  const quantity=n(update?.quantity,NaN);
  return runtimeOrders(runtimeState).find(o=>{
    if(String(o?.orderClass||'').toUpperCase()!=='ALGO')return false;
    if(String(o?.symbol||'').toUpperCase()!==update.symbol)return false;
    if(String(o?.side||'').toUpperCase()!==side)return false;
    if(String(o?.positionSide||'BOTH').toUpperCase()!=='BOTH')return false;
    if(String(o?.type||'').toUpperCase()!=='STOP_MARKET')return false;
    if(!bool(o?.closePosition))return false;
    const clientAlgoId=String(o?.clientAlgoId||'');
    if(!/^zth-[A-Za-z0-9._:-]+$/.test(clientAlgoId)||clientAlgoId.length>36)return false;
    if(clientAlgoId===String(excludeClientAlgoId||''))return false;
    const trigger=n(o?.triggerPrice??o?.stopPrice);
    if(!(trigger>0)||!(entryPrice>0)||!(quantity>0))return false;
    const lossSide=update.direction==='LONG'?trigger<entryPrice:trigger>entryPrice;
    if(!lossSide)return false;
    const impliedLossUsd=update.direction==='LONG'
      ?(entryPrice-trigger)*quantity
      :(trigger-entryPrice)*quantity;
    return impliedLossUsd<=REAL_RISK_LIMITS.maxLossUsd+1e-8;
  })||null;
}

export function conflictingProtectiveOrders(runtimeState, update, kind, allowedIds = []) {
  const allowed = new Set((Array.isArray(allowedIds) ? allowedIds : []).filter(Boolean).map(String));
  const side = sideForDirection(update.direction);
  const sym = String(update.symbol || '').toUpperCase();
  const wanted = String(kind || '').toUpperCase();

  return runtimeOrders(runtimeState).filter(order => {
    if (String(order?.symbol || '').toUpperCase() !== sym) return false;
    if (String(order?.side || '').toUpperCase() !== side) return false;
    if (String(order?.positionSide || 'BOTH').toUpperCase() !== 'BOTH') return false;

    const orderClass = String(order?.orderClass || 'STANDARD').toUpperCase();
    const type = String(order?.type || '').toUpperCase();
    let samePurpose = false;
    let id = '';

    if (wanted === 'EXIT') {
      samePurpose =
        orderClass === 'STANDARD' &&
        type === 'LIMIT' &&
        String(order?.timeInForce || '').toUpperCase() === 'GTC' &&
        bool(order?.reduceOnly);
      id = String(order?.clientOrderId || '');
    } else if (wanted === 'PROGRESSIVE') {
      if(
        orderClass === 'STANDARD' &&
        type === 'LIMIT' &&
        String(order?.timeInForce || '').toUpperCase() === 'GTC' &&
        bool(order?.reduceOnly)
      ){
        id = String(order?.clientOrderId || '');
        samePurpose = !managedExitId(id);
      }else{
        samePurpose =
          orderClass === 'ALGO' &&
          type === 'STOP' &&
          bool(order?.reduceOnly);
        id = String(order?.clientAlgoId || '');
      }
    } else if (wanted === 'MAX_LOSS') {
      samePurpose =
        orderClass === 'ALGO' &&
        type === 'STOP_MARKET' &&
        bool(order?.closePosition);
      id = String(order?.clientAlgoId || '');
    }

    return samePurpose && !allowed.has(id);
  });
}
function decimals(step){
  const t=String(step||'');if(!t.includes('.'))return 0;
  return Math.min(12,t.split('.')[1].replace(/0+$/,'').length);
}
function priceFilterReason(symbolInfo,price){
  const p=n(price),filter=(Array.isArray(symbolInfo?.filters)?symbolInfo.filters:[])
    .find(f=>f?.filterType==='PRICE_FILTER')||{};
  const tick=n(filter.tickSize),min=n(filter.minPrice),max=n(filter.maxPrice);
  if(!(p>0))return 'PRICE_INVALID';
  if(min>0&&p<min)return 'PRICE_BELOW_EXCHANGE_MIN';
  if(max>0&&p>max)return 'PRICE_ABOVE_EXCHANGE_MAX';
  if(tick>0){
    const units=p/tick;
    if(Math.abs(units-Math.round(units))>1e-8)return 'PRICE_NOT_TICK_ALIGNED';
    Number((Math.round(units)*tick).toFixed(decimals(tick)));
  }
  return '';
}
async function directSymbolFlat(symbol,apiKey,secret){
  const rows=await signedBinanceRequest({
    baseUrl:BASE,path:'/fapi/v3/positionRisk',method:'GET',
    apiKey,secret,params:{symbol},timestamp:Date.now()
  });
  if(!Array.isArray(rows)||!rows.length)throw new Error('DIRECT_POSITION_PROOF_MISSING');
  const same=rows.filter(p=>String(p?.symbol||'').toUpperCase()===symbol);
  if(!same.length)throw new Error('DIRECT_POSITION_PROOF_MISSING');
  for(const p of same){
    const amount=n(p?.positionAmt,NaN);
    if(!Number.isFinite(amount))throw new Error('DIRECT_POSITION_PROOF_INVALID');
    if(Math.abs(amount)>0)return false;
  }
  return true;
}

async function symbolInfo(symbol){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(`${BASE}/fapi/v1/exchangeInfo`,{cache:'no-store',signal:controller.signal});
    const data=await r.json();
    if(!r.ok)throw new Error(data?.msg||`BINANCE_HTTP_${r.status}`);
    return (Array.isArray(data?.symbols)?data.symbols:[])
      .find(x=>String(x?.symbol||'').toUpperCase()===symbol)||null;
  }finally{clearTimeout(timer)}
}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!sameOriginMutation(req))return send(res,403,{ok:false,code:'ORIGIN_FORBIDDEN'});

  let master=null;
  try{master=await requireCurrentMaster(req)}
  catch(e){return send(res,e?.code==='MASTER_LEASE_REQUIRED'?409:503,{ok:false,code:e?.code||'AUTH_BACKEND_ERROR',writeAttempted:false})}
  if(!master)return send(res,401,{ok:false,code:'MASTER_REQUIRED',writeAttempted:false});

  const type=String(req.body?.type||'').toUpperCase(),phase=String(req.body?.phase||'').toUpperCase();
  const orphanCleanup=type==='EXEC_CLEAN_ORPHAN_PROTECTION'&&phase==='CANCEL_ORPHAN';
  if(!orphanCleanup&&
     (!['EXEC_UPDATE_EXIT','EXEC_UPDATE_PROTECTION'].includes(type)||!['CANCEL_OLD','PLACE_NEW'].includes(phase))){
    return send(res,400,{ok:false,code:'PROTECTIVE_UPDATE_OPERATION_INVALID',writeAttempted:false});
  }

  const apiKey=process.env.BINANCE_API_KEY,secret=process.env.BINANCE_API_SECRET;
  if(!apiKey||!secret)return send(res,503,{ok:false,code:'MISSING_ENV',writeAttempted:false});

  if(orphanCleanup){
    try{
      const state=await readState();
      const targets=orphanZenithCleanupOrders(state.report);
      const symbol=String(req.body?.symbol||'').toUpperCase();
      const orderClass=String(req.body?.orderClass||'').toUpperCase();
      const clientOrderId=String(req.body?.clientOrderId||'');
      const clientAlgoId=String(req.body?.clientAlgoId||'');
      const target=targets.find(row=>
        row.symbol===symbol&&row.orderClass===orderClass&&
        (orderClass==='ALGO'?row.clientAlgoId===clientAlgoId:row.clientOrderId===clientOrderId)
      );
      if(!target)return send(res,409,{ok:false,code:'ORPHAN_CLEANUP_TARGET_NOT_CONFIRMED',writeAttempted:false});

      const writesEnabled=Boolean(REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED);
      if(!writesEnabled)return send(res,423,{
        ok:false,code:'BINANCE_WRITE_LOCKED',realTradingEnabled:REAL_TRADING_ENABLED,
        binanceWriteEnabled:BINANCE_WRITE_ENABLED,pairingDisabled:PAIRING_DISABLED,writeAttempted:false
      });

      const flat=await directSymbolFlat(symbol,apiKey,secret);
      if(!flat)return send(res,409,{ok:false,code:'ORPHAN_CLEANUP_POSITION_NOT_FLAT',writeAttempted:false});

      let result;
      if(orderClass==='STANDARD'){
        result=await cancelReduceOnlyOrderIdempotent({
          apiKey,secret,symbol,clientOrderId:target.clientOrderId,
          expectedSide:target.side,writesEnabled:true,timestamp:Date.now()
        });
      }else{
        const expected={
          symbol,clientAlgoId:target.clientAlgoId,side:target.side,
          positionSide:'BOTH',type:target.type,
          ...(target.closePosition?{closePosition:'true'}:{}),
          ...(target.reduceOnly?{reduceOnly:'true'}:{}),
          ...(target.triggerPrice?{triggerPrice:target.triggerPrice}:{}),
          ...(target.price?{price:target.price}:{}),
        };
        result=await cancelAlgoOrderIdempotent({
          apiKey,secret,symbol,clientAlgoId:target.clientAlgoId,
          expected,writesEnabled:true,timestamp:Date.now()
        });
      }

      await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
        at:Date.now(),kind:'BINANCE_ORPHAN_PROTECTION_CLEANUP',deviceId:master.deviceId,
        symbol,orderClass,clientOrderId:target.clientOrderId||'',
        clientAlgoId:target.clientAlgoId||'',disposition:String(result?.disposition||''),
        writeAttempted:result?.writeAttempted===true,
      })]);
      await redis(['LTRIM',KEY_AUDIT,'0','199']);
      return send(res,200,{ok:true,type,phase,target,result,flatProof:true});
    }catch(e){
      const ambiguous=e?.ambiguous===true;
      return send(res,502,{
        ok:false,code:ambiguous?'ORPHAN_CLEANUP_RESULT_AMBIGUOUS':'BINANCE_ORPHAN_CLEANUP_FAILED',
        error:'Nettoyage de protection Binance indisponible.',binanceCode:e?.code??null,
        ambiguous,writeAttempted:ambiguous,
      });
    }
  }

  let update;
  try{update=normalizeProtectiveUpdatePayload(type,req.body)}
  catch(e){return send(res,400,{ok:false,code:e?.message||'PROTECTIVE_UPDATE_PAYLOAD_INVALID',writeAttempted:false})}

  try{
    const state=await readState();
    const armReason=validateExecutionArmRecord(state.armRecord,master.deviceId);
    if(armReason)return send(res,423,{ok:false,code:'EXECUTION_NOT_ARMED',reason:armReason,writeAttempted:false});
    const modeReason=protectiveModeReason(state.masterMode);
    if(modeReason)return send(res,423,{ok:false,code:'EXECUTION_NOT_READY',reason:modeReason,writeAttempted:false});
    const repairTarget=(
      phase==='PLACE_NEW'||
      (phase==='CANCEL_OLD'&&update.protectionKind==='MAX_LOSS'&&String(req.body?.newClientAlgoId||''))
    )?protectiveRepairTarget(type,update):'';
    const readyReason=executionReadiness(state.runtimeState,state.report,master.deviceId,repairTarget);
    if(readyReason)return send(res,423,{ok:false,code:'EXECUTION_NOT_READY',reason:readyReason,writeAttempted:false});

    const position=runtimePosition(state.runtimeState,update.symbol,update.direction);
    const live=validateUpdateAgainstLivePosition(update,position);
    if(type==='EXEC_UPDATE_PROTECTION'&&update.protectionKind==='MAX_LOSS'){
      try{
        validateMaxLossTrigger({
          position,
          triggerPrice:update.triggerPrice,
          hardMaxLossUsd:REAL_RISK_LIMITS.maxLossUsd,
        });
      }catch(e){
        return send(res,409,{
          ok:false,
          code:e?.message||'MAX_LOSS_TRIGGER_INVALID',
          impliedLossUsd:Number.isFinite(Number(e?.impliedLossUsd))?Number(e.impliedLossUsd):null,
          hardMaxLossUsd:REAL_RISK_LIMITS.maxLossUsd,
          writeAttempted:false,
        });
      }
    }
    const emergency=emergencyProtection(state.runtimeState,update,live.entryPrice,
      type==='EXEC_UPDATE_PROTECTION'&&update.protectionKind==='MAX_LOSS'&&phase==='CANCEL_OLD'
        ?update.previousClientAlgoId:''
    );

    if(type==='EXEC_UPDATE_EXIT'||(type==='EXEC_UPDATE_PROTECTION'&&update.protectionKind==='PROGRESSIVE')){
      if(!emergency)return send(res,423,{ok:false,code:'EMERGENCY_MAX_LOSS_PROTECTION_REQUIRED',writeAttempted:false});
    }

    const writesEnabled=Boolean(REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED);
    if(!writesEnabled)return send(res,423,{
      ok:false,code:'BINANCE_WRITE_LOCKED',realTradingEnabled:REAL_TRADING_ENABLED,
      binanceWriteEnabled:BINANCE_WRITE_ENABLED,pairingDisabled:PAIRING_DISABLED,writeAttempted:false
    });

    const info=await symbolInfo(update.symbol);
    if(!info)return send(res,409,{ok:false,code:'SYMBOL_INFO_MISSING',writeAttempted:false});
    const checkedPrice=type==='EXEC_UPDATE_EXIT'?update.targetPrice:update.triggerPrice;
    const filterReason=priceFilterReason(info,checkedPrice);
    if(filterReason)return send(res,409,{ok:false,code:filterReason,writeAttempted:false});

    let result=null,plan=null;
    if(type==='EXEC_UPDATE_EXIT'){
      const expectedSide=sideForDirection(update.direction);
      if(phase==='CANCEL_OLD'){
        if(!update.previousClientOrderId)return send(res,400,{ok:false,code:'PREVIOUS_EXIT_ID_REQUIRED',writeAttempted:false});
        const old=findStandard(state.runtimeState,update.symbol,update.previousClientOrderId);
        if(!old)return send(res,409,{ok:false,code:'PREVIOUS_EXIT_NOT_OPEN',writeAttempted:false});
        if(String(old.type||'').toUpperCase()!=='LIMIT'||String(old.timeInForce||'').toUpperCase()!=='GTC'||
           !bool(old.reduceOnly)||String(old.side||'').toUpperCase()!==expectedSide){
          return send(res,409,{ok:false,code:'PREVIOUS_EXIT_IDENTITY_MISMATCH',writeAttempted:false});
        }
        result=await cancelReduceOnlyOrderIdempotent({
          apiKey,secret,symbol:update.symbol,clientOrderId:update.previousClientOrderId,
          expectedSide,writesEnabled:true,timestamp:Date.now()
        });
      }else{
        plan=buildExitOrderPlan({
          commandId:String(req.body?.commandId||''),symbol:update.symbol,direction:update.direction,
          quantity:update.quantity,exitMode:'NORMAL_LIMIT',targetPrice:update.targetPrice,attempt:0
        });
        const conflicts=conflictingProtectiveOrders(
          state.runtimeState,update,'EXIT',[plan.params.newClientOrderId]
        );
        if(conflicts.length){
          return send(res,409,{
            ok:false,code:'CONFLICTING_EXIT_ORDER_OPEN',
            conflictingIds:conflicts.map(o=>String(o?.clientOrderId||'')),
            writeAttempted:false
          });
        }
        result=await placeStandardOrderIdempotent({
          apiKey,secret,orderParams:plan.params,writesEnabled:true,timestamp:Date.now()
        });
      }
    }else{
      plan=buildProtectiveAlgoPlan({
        commandId:String(req.body?.commandId||''),symbol:update.symbol,direction:update.direction,
        quantity:update.quantity,triggerPrice:update.triggerPrice,limitPrice:update.limitPrice,
        protectionKind:update.protectionKind,attempt:0
      });
      if(phase==='CANCEL_OLD'){
        if(!update.previousClientAlgoId)return send(res,400,{ok:false,code:'PREVIOUS_PROTECTION_ID_REQUIRED',writeAttempted:false});
        const old=findAlgo(state.runtimeState,update.symbol,update.previousClientAlgoId);
        if(!old)return send(res,409,{ok:false,code:'PREVIOUS_PROTECTION_NOT_OPEN',writeAttempted:false});

        const newId=String(req.body?.newClientAlgoId||'');
        const confirmedNew=findAlgo(state.runtimeState,update.symbol,newId);
        if(update.protectionKind==='MAX_LOSS'){
          if(!newId||!confirmedNew||String(confirmedNew.type||'').toUpperCase()!=='STOP_MARKET'||!bool(confirmedNew.closePosition)){
            return send(res,423,{ok:false,code:'NEW_MAX_LOSS_PROTECTION_NOT_CONFIRMED',writeAttempted:false});
          }
        }else{
          const newPrice=n(confirmedNew?.price);
          const newTrigger=n(confirmedNew?.triggerPrice??confirmedNew?.stopPrice);
          if(!newId||!confirmedNew||
             String(confirmedNew.type||'').toUpperCase()!=='STOP'||
             String(confirmedNew.timeInForce||'').toUpperCase()!=='GTC'||
             !bool(confirmedNew.reduceOnly)||
             String(confirmedNew.side||'').toUpperCase()!==sideForDirection(update.direction)||
             Math.abs(n(confirmedNew.origQty)-update.quantity)>1e-12||
             !(newPrice>0)||!(newTrigger>0)||
             Math.abs(newPrice-newTrigger)>Math.max(1e-9,Math.abs(newTrigger)*1e-10)||
             Math.abs(newTrigger-update.triggerPrice)>Math.max(1e-9,Math.abs(update.triggerPrice)*1e-10)||
             Math.abs(newPrice-update.limitPrice)>Math.max(1e-9,Math.abs(update.limitPrice)*1e-10)||
             (confirmedNew.priceMatch&&String(confirmedNew.priceMatch).toUpperCase()!=='NONE')){
            return send(res,423,{ok:false,code:'NEW_PROGRESSIVE_PROTECTION_NOT_CONFIRMED',writeAttempted:false});
          }
        }

        const expected={
          symbol:update.symbol,side:sideForDirection(update.direction),positionSide:'BOTH',
          clientAlgoId:update.previousClientAlgoId,
          type:update.protectionKind==='MAX_LOSS'?'STOP_MARKET':'STOP',
        };
        if(update.protectionKind==='MAX_LOSS'){
          expected.closePosition='true';
        }else{
          const oldPrice=n(old?.price);
          const oldTrigger=n(old?.triggerPrice??old?.stopPrice);
          if(!(oldPrice>0)||!(oldTrigger>0)||
             Math.abs(oldPrice-oldTrigger)>Math.max(1e-9,Math.abs(oldTrigger)*1e-10)||
             String(old?.timeInForce||'').toUpperCase()!=='GTC'||
             (old?.priceMatch&&String(old.priceMatch).toUpperCase()!=='NONE')){
            return send(res,409,{ok:false,code:'PREVIOUS_PROGRESSIVE_NOT_EXACT_LIMIT',writeAttempted:false});
          }
          expected.reduceOnly='true';
          expected.quantity=String(update.quantity);
          expected.price=String(oldPrice);
          expected.triggerPrice=String(oldTrigger);
        }
        result=await cancelAlgoOrderIdempotent({
          apiKey,secret,symbol:update.symbol,clientAlgoId:update.previousClientAlgoId,
          expected,writesEnabled:true,timestamp:Date.now()
        });
      }else{
        const allowedIds=[plan.params.clientAlgoId];
        if(update.previousClientAlgoId){
          const old=findAlgo(state.runtimeState,update.symbol,update.previousClientAlgoId);
          if(!old)return send(res,409,{ok:false,code:'PREVIOUS_PROTECTION_NOT_OPEN',writeAttempted:false});
          if(update.protectionKind==='PROGRESSIVE'){
            const oldPrice=n(old?.price);
            const oldTrigger=n(old?.triggerPrice??old?.stopPrice);
            if(String(old.type||'').toUpperCase()!=='STOP'||
               String(old.timeInForce||'').toUpperCase()!=='GTC'||
               !bool(old.reduceOnly)||
               String(old.side||'').toUpperCase()!==sideForDirection(update.direction)||
               !(oldPrice>0)||!(oldTrigger>0)||
               Math.abs(oldPrice-oldTrigger)>Math.max(1e-9,Math.abs(oldTrigger)*1e-10)||
               (old.priceMatch&&String(old.priceMatch).toUpperCase()!=='NONE')){
              return send(res,409,{ok:false,code:'PREVIOUS_PROGRESSIVE_NOT_EXACT_LIMIT',writeAttempted:false});
            }
          }
          allowedIds.push(update.previousClientAlgoId);
        }
        const conflicts=conflictingProtectiveOrders(
          state.runtimeState,update,update.protectionKind,allowedIds
        );
        if(conflicts.length){
          return send(res,409,{
            ok:false,
            code:update.protectionKind==='MAX_LOSS'
              ?'CONFLICTING_MAX_LOSS_PROTECTION_OPEN'
              :'CONFLICTING_PROGRESSIVE_PROTECTION_OPEN',
            conflictingIds:conflicts.map(o=>String(o?.clientAlgoId||o?.clientOrderId||o?.orderId||'')),
            writeAttempted:false
          });
        }
        result=await placeAlgoOrderIdempotent({
          apiKey,secret,algoParams:plan.params,writesEnabled:true,timestamp:Date.now()
        });
      }
    }

    await redis(['LPUSH',KEY_AUDIT,JSON.stringify({
      at:Date.now(),kind:'BINANCE_PROTECTIVE_UPDATE_DISPATCH',deviceId:master.deviceId,
      commandId:String(req.body?.commandId||''),type,phase,symbol:update.symbol,
      protectionKind:update.protectionKind||'',disposition:String(result?.disposition||''),
      writeAttempted:result?.writeAttempted===true,
      newClientId:String(plan?.params?.newClientOrderId||plan?.params?.clientAlgoId||''),
    })]);
    await redis(['LTRIM',KEY_AUDIT,'0','199']);
    return send(res,200,{ok:true,type,phase,plan,result,emergencyProtection:emergency||null});
  }catch(e){
    const ambiguous=e?.ambiguous===true;
    return send(res,502,{
      ok:false,code:ambiguous?'PROTECTIVE_UPDATE_RESULT_AMBIGUOUS':'BINANCE_PROTECTIVE_UPDATE_FAILED',
      error:'Mise à jour de protection Binance indisponible.',binanceCode:e?.code??null,
      ambiguous,writeAttempted:ambiguous,
    });
  }
}
