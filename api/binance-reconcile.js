import crypto from 'node:crypto';
import { deviceTokenCandidates, deviceSessionRecordActive, roleAssignmentKey, deviceRoleAssignmentActive, sameOriginMutation, engineInstanceHeader, enginePrincipalInstanceActive } from '../lib/device-session.mjs';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';
import { evaluateEntryTransitionReconciliation, entryTransitionOrderIdentity, transitionEntryMatches, transitionProtectionMatches } from '../lib/entry-transition.mjs';

const BASE = 'https://fapi.binance.com';
const RECV_WINDOW = 5000;

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN;

const PREFIX = 'zenith:v1';
const KEY_STATE = `${PREFIX}:state`;
const KEY_RECONCILE_LAST = `${PREFIX}:reconcile:last`;
const KEY_AUDIT = `${PREFIX}:audit`;
const KEY_ENTRY_TRANSITIONS = `${PREFIX}:entry-transitions`;
const KEY_CONTROLLER_STATE = `${PREFIX}:controller-state`;
const KEY_PROCESSING = `${PREFIX}:commands:processing`;
const BINANCE_RECONCILE_RATE_LIMIT_PER_MINUTE = 30;
const VERCEL_CONTROL_MUTATION_ALLOWED = !process.env.VERCEL_ENV ||
  process.env.VERCEL_ENV === 'development' ||
  (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_GIT_COMMIT_REF === 'main');

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => item === undefined ? 'null' : stableStringify(item)).join(',') + ']';
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = stableStringify(value[key]);
    if (encoded !== undefined) parts.push(JSON.stringify(key) + ':' + encoded);
  }
  return '{' + parts.join(',') + '}';
}

async function redis(command) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const e = new Error('UPSTASH_NOT_CONFIGURED');
    e.code = 'UPSTASH_NOT_CONFIGURED';
    throw e;
  }

  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
  });

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!r.ok || data?.error) {
    const e = new Error(data?.error || `Redis HTTP ${r.status}`);
    e.code = 'REDIS_ERROR';
    throw e;
  }
  return data?.result;
}

async function requireCurrentMaster(req) {
  for (const token of deviceTokenCandidates(req)) {
    const tokenHash = sha256(token);
    const raw = await redis(['GET', `${PREFIX}:device:${tokenHash}`]);
    if (!raw) continue;

    let device = null;
    try { device = JSON.parse(raw); } catch {}
    if (!deviceSessionRecordActive(device) || !device?.deviceId || device.role !== 'master') continue;

    const [registered, lease] = await Promise.all([
      redis(['GET', `${PREFIX}:role-device:master`]),
      redis(['GET', `${PREFIX}:master`]),
    ]);

    if (!registered || String(registered) !== String(device.deviceId)) continue;
    const issuedAt=await redis(['GET',roleAssignmentKey(PREFIX,'master')]);
    if(!deviceRoleAssignmentActive(device,issuedAt))continue;
    if(String(device?.principal||'')==='engine'){
      const suppliedInstance=engineInstanceHeader(req);
      const currentInstance=String(await redis(['GET',`${PREFIX}:engine-instance`])||'');
      if(!enginePrincipalInstanceActive(device,suppliedInstance,currentInstance)){
        const e=new Error('ENGINE_INSTANCE_FENCED');e.code='ENGINE_INSTANCE_FENCED';throw e;
      }
    }
    if (String(lease || '') !== String(device.deviceId)) {
      const e = new Error('MASTER_LEASE_REQUIRED');
      e.code = 'MASTER_LEASE_REQUIRED';
      throw e;
    }
    return { ...device, roleIssuedAt: String(issuedAt || '0') };
  }
  return null;
}

async function reconciliationRateAllowed(deviceId) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${PREFIX}:rate:binance-reconcile:${sha256(deviceId)}:${bucket}`;
  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count = Number(await redis(['EVAL', script, '1', key, '120'])) || 0;
  return count <= BINANCE_RECONCILE_RATE_LIMIT_PER_MINUTE;
}

function retryAfterSeconds() {
  return Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
}

async function jsonFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!r.ok) {
      const e = new Error(data?.msg || `Binance HTTP ${r.status}`);
      e.status = r.status;
      e.binanceCode = data?.code;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function signedGet(path, apiKey, secret, serverTime, extra = {}) {
  const params = new URLSearchParams({
    timestamp: String(serverTime),
    recvWindow: String(RECV_WINDOW),
  });
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }

  const signature = crypto
    .createHmac('sha256', secret)
    .update(params.toString())
    .digest('hex');

  params.set('signature', signature);

  return jsonFetch(`${BASE}${path}?${params.toString()}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

function number(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function direction(position) {
  const ps = String(position?.positionSide || '').toUpperCase();
  const explicit = String(position?.direction || '').toUpperCase();
  if (explicit === 'LONG' || explicit === 'SHORT') return explicit;
  if (ps === 'LONG' || ps === 'SHORT') return ps;
  return number(position?.positionAmt ?? position?.quantity ?? position?.qty) < 0 ? 'SHORT' : 'LONG';
}

function positionKey(position) {
  return `${String(position?.symbol || '').toUpperCase()}:${direction(position)}`;
}

function positionQty(position) {
  return Math.abs(number(position?.positionAmt ?? position?.quantity ?? position?.qty));
}

function nearlyEqual(a, b) {
  const aa = Math.abs(number(a));
  const bb = Math.abs(number(b));
  return aa === bb;
}

function normalizeActualPosition(p) {
  return {
    symbol: String(p.symbol || '').toUpperCase(),
    direction: direction(p),
    positionSide: String(p.positionSide || ''),
    positionAmt: String(p.positionAmt ?? ''),
    quantity: positionQty(p),
    entryPrice: number(p.entryPrice),
    breakEvenPrice: number(p.breakEvenPrice),
    markPrice: number(p.markPrice),
    unrealizedProfit: number(p.unRealizedProfit ?? p.unrealizedProfit),
    liquidationPrice: number(p.liquidationPrice),
    leverage: number(p.leverage),
    marginType: String(p.marginType || ''),
    isAutoAddMargin:p.isAutoAddMargin===true||String(p.isAutoAddMargin||'').toLowerCase()==='true'
      ?true
      :p.isAutoAddMargin===false||String(p.isAutoAddMargin||'').toLowerCase()==='false'
        ?false
        :null,
    isolatedMargin: number(p.isolatedMargin),
    notional: number(p.notional),
    updateTime: number(p.updateTime),
  };
}

function normalizeActualOrder(o) {
  return {
    symbol: String(o.symbol || '').toUpperCase(),
    orderId: String(o.orderId ?? ''),
    clientOrderId: String(o.clientOrderId ?? ''),
    side: String(o.side || ''),
    positionSide: String(o.positionSide || ''),
    type: String(o.type || ''),
    status: String(o.status || ''),
    origQty: String(o.origQty ?? ''),
    executedQty: String(o.executedQty ?? ''),
    price: String(o.price ?? ''),
    stopPrice: String(o.stopPrice ?? ''),
    reduceOnly: o.reduceOnly === true || o.reduceOnly === 'true',
    closePosition: o.closePosition === true || o.closePosition === 'true',
    timeInForce: String(o.timeInForce || ''),
    workingType: String(o.workingType || ''),
    priceProtect: Boolean(o.priceProtect),
    updateTime: number(o.updateTime ?? o.time),
  };
}

function normalizeActualAlgoOrder(o) {
  return {
    orderClass: 'ALGO',
    symbol: String(o.symbol || '').toUpperCase(),
    algoId: String(o.algoId ?? ''),
    clientAlgoId: String(o.clientAlgoId ?? ''),
    side: String(o.side || ''),
    positionSide: String(o.positionSide || ''),
    type: String(o.orderType || o.type || ''),
    status: String(o.algoStatus || ''),
    origQty: String(o.quantity ?? ''),
    executedQty: String(o.executedQty ?? ''),
    actualOrderId: String(o.actualOrderId ?? ''),
    actualPrice: String(o.actualPrice ?? ''),
    price: String(o.price ?? ''),
    stopPrice: String(o.triggerPrice ?? ''),
    triggerPrice: String(o.triggerPrice ?? ''),
    reduceOnly: o.reduceOnly === true || o.reduceOnly === 'true',
    closePosition: o.closePosition === true || o.closePosition === 'true',
    timeInForce: String(o.timeInForce || ''),
    workingType: String(o.workingType || ''),
    priceMatch: String(o.priceMatch || ''),
    priceProtect: Boolean(o.priceProtect),
    createTime: number(o.createTime),
    triggerTime: number(o.triggerTime),
    updateTime: number(o.updateTime ?? o.createTime),
  };
}

function maxLossRemainderCommandId(algo) {
  const clientAlgoId=String(algo?.clientAlgoId||'');
  const actualOrderId=String(algo?.actualOrderId||'');
  const value=`maxloss-remainder:${clientAlgoId}:${actualOrderId}`;
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value)?value:'';
}

function recoveryClientOrderId(commandId,symbol,attempt){
  const id=String(commandId||'');
  const sym=String(symbol||'').toUpperCase();
  const n=Math.max(0,Math.floor(number(attempt,0)));
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(id)||!/^[A-Z0-9]{3,30}$/.test(sym))return '';
  const digest=crypto.createHash('sha256')
    .update(`zenith:v1|${id}|${sym}|EXIT_PROTECT|${n}`)
    .digest('hex').slice(0,24);
  return `zth-EXI-${digest}`;
}

function evaluateTriggeredMaxLossRemainder({
  position,algo,actualOrder,recoveryOrders=[],configuredMaxLossUsd
}) {
  if(!position||!algo||!actualOrder)return null;
  const symbol=String(position?.symbol||'').toUpperCase();
  const dir=direction(position);
  const side=dir==='LONG'?'SELL':'BUY';
  const positionSide=String(position?.positionSide||'BOTH').toUpperCase();
  const currentQty=positionQty(position);
  const entryPrice=number(position?.entryPrice,NaN);
  const configured=number(configuredMaxLossUsd,NaN);
  const clientAlgoId=String(algo?.clientAlgoId||'');
  const algoStatus=String(algo?.status||algo?.algoStatus||'').toUpperCase();
  const actualOrderId=String(algo?.actualOrderId||'');
  const originalQty=number(algo?.origQty??algo?.quantity,NaN);
  const triggerPrice=number(algo?.triggerPrice??algo?.stopPrice,NaN);
  const triggerTime=number(algo?.triggerTime,0);
  const positionUpdateTime=number(position?.updateTime,0);
  if(!symbol||!['LONG','SHORT'].includes(dir)||!(currentQty>0)||!(entryPrice>0)||!(configured>0))return null;
  if(String(algo?.symbol||'').toUpperCase()!==symbol||
     String(algo?.side||'').toUpperCase()!==side||
     String(algo?.positionSide||'BOTH').toUpperCase()!==positionSide||
     String(algo?.type||algo?.orderType||'').toUpperCase()!=='STOP'||
     String(algo?.timeInForce||'').toUpperCase()!=='IOC'||
     !(algo?.reduceOnly===true||algo?.reduceOnly==='true')||
     algo?.closePosition===true||algo?.closePosition==='true'||
     String(algo?.priceMatch||'').toUpperCase()!=='OPPONENT'||
     !['TRIGGERED','FINISHED'].includes(algoStatus)||
     !/^zth-MAX-[A-Za-z0-9._:-]+$/.test(clientAlgoId)||clientAlgoId.length>36||
     !actualOrderId||!(originalQty>0)||!(triggerPrice>0))return null;
  if(positionUpdateTime>0&&triggerTime>0&&triggerTime<positionUpdateTime-120000)return null;
  const impliedLossUsd=dir==='LONG'
    ?(entryPrice-triggerPrice)*originalQty
    :(triggerPrice-entryPrice)*originalQty;
  if(!(impliedLossUsd>=0)||impliedLossUsd>configured+1e-8||impliedLossUsd>REAL_RISK_LIMITS.maxLossUsd+1e-8)return null;

  const actualStatus=String(actualOrder?.status||'').toUpperCase();
  const initialExecuted=number(actualOrder?.executedQty,NaN);
  const actualOrigQty=number(actualOrder?.origQty,NaN);
  if(String(actualOrder?.symbol||'').toUpperCase()!==symbol||
     String(actualOrder?.orderId||'')!==actualOrderId||
     String(actualOrder?.side||'').toUpperCase()!==side||
     String(actualOrder?.positionSide||'BOTH').toUpperCase()!==positionSide||
     String(actualOrder?.type||'').toUpperCase()!=='LIMIT'||
     String(actualOrder?.timeInForce||'').toUpperCase()!=='IOC'||
     !(actualOrder?.reduceOnly===true||actualOrder?.reduceOnly==='true')||
     actualOrder?.closePosition===true||actualOrder?.closePosition==='true'||
     !(actualOrigQty>0)||Math.abs(actualOrigQty-originalQty)>Math.max(1e-12,originalQty*1e-10)||
     !(initialExecuted>=0)||initialExecuted>originalQty+1e-12)return null;

  const recoveryCommandId=maxLossRemainderCommandId(algo);
  if(!recoveryCommandId)return null;
  const retryableTerminal=new Set(['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED']);
  if(actualStatus==='FILLED'&&currentQty>1e-12){
    return {
      kind:'INCONSISTENT',symbol,direction:dir,remainingQuantity:currentQty,
      originalQuantity:originalQty,executedQuantity:initialExecuted,
      clientAlgoId,algoId:String(algo?.algoId||''),actualOrderId,
      actualOrderStatus:actualStatus,recoveryCommandId,triggerPrice,triggerTime,
      reason:'ORIGINAL_IOC_FILLED_BUT_POSITION_REMAINS',
    };
  }
  if(!retryableTerminal.has(actualStatus))return null;

  let cumulativeExecuted=initialExecuted;
  let nextAttempt=1;
  let pendingAttempt=0;
  const seenAttempts=new Set();
  for(const item of Array.isArray(recoveryOrders)?recoveryOrders:[]){
    const attempt=Math.floor(number(item?.attempt,0));
    if(attempt<1||attempt>3||seenAttempts.has(attempt))return {
      kind:'INCONSISTENT',symbol,direction:dir,remainingQuantity:currentQty,
      originalQuantity:originalQty,executedQuantity:cumulativeExecuted,
      clientAlgoId,algoId:String(algo?.algoId||''),actualOrderId,
      actualOrderStatus:actualStatus,recoveryCommandId,triggerPrice,triggerTime,
      reason:'RECOVERY_ATTEMPT_IDENTITY_INVALID',
    };
    seenAttempts.add(attempt);
  }
  for(let attempt=1;attempt<=3;attempt++){
    const item=(Array.isArray(recoveryOrders)?recoveryOrders:[]).find(row=>Math.floor(number(row?.attempt,0))===attempt);
    if(!item)break;
    if(attempt!==nextAttempt) {
      return {
        kind:'INCONSISTENT',symbol,direction:dir,remainingQuantity:currentQty,
        originalQuantity:originalQty,executedQuantity:cumulativeExecuted,
        clientAlgoId,algoId:String(algo?.algoId||''),actualOrderId,
        actualOrderStatus:actualStatus,recoveryCommandId,triggerPrice,triggerTime,
        reason:'RECOVERY_ATTEMPT_GAP',
      };
    }
    const order=item.order||{};
    const expectedClientId=recoveryClientOrderId(recoveryCommandId,symbol,attempt);
    const beforeAttempt=Math.max(0,originalQty-cumulativeExecuted);
    const orderQty=number(order?.origQty,NaN);
    const orderExecuted=number(order?.executedQty,NaN);
    const status=String(order?.status||'').toUpperCase();
    if(String(order?.symbol||'').toUpperCase()!==symbol||
       String(order?.clientOrderId||'')!==expectedClientId||
       String(order?.side||'').toUpperCase()!==side||
       String(order?.positionSide||'BOTH').toUpperCase()!==positionSide||
       String(order?.type||'').toUpperCase()!=='LIMIT'||
       String(order?.timeInForce||'').toUpperCase()!=='IOC'||
       !(order?.reduceOnly===true||order?.reduceOnly==='true')||
       order?.closePosition===true||order?.closePosition==='true'||
       !(orderQty>0)||Math.abs(orderQty-beforeAttempt)>Math.max(1e-12,beforeAttempt*1e-10)||
       !(orderExecuted>=0)||orderExecuted>orderQty+1e-12){
      return {
        kind:'INCONSISTENT',symbol,direction:dir,remainingQuantity:currentQty,
        originalQuantity:originalQty,executedQuantity:cumulativeExecuted,
        clientAlgoId,algoId:String(algo?.algoId||''),actualOrderId,
        actualOrderStatus:actualStatus,recoveryCommandId,triggerPrice,triggerTime,
        reason:'RECOVERY_ORDER_IDENTITY_MISMATCH',
      };
    }
    if(!retryableTerminal.has(status)&&status!=='FILLED'){
      pendingAttempt=attempt;
      break;
    }
    cumulativeExecuted+=orderExecuted;
    nextAttempt=attempt+1;
  }

  const expectedRemaining=Math.max(0,originalQty-cumulativeExecuted);
  if(Math.abs(expectedRemaining-currentQty)>Math.max(1e-12,originalQty*1e-10)){
    return null;
  }
  if(pendingAttempt){
    return {
      kind:'PENDING',symbol,direction:dir,remainingQuantity:currentQty,
      originalQuantity:originalQty,executedQuantity:cumulativeExecuted,
      clientAlgoId,algoId:String(algo?.algoId||''),actualOrderId,
      actualOrderStatus:actualStatus,recoveryCommandId,triggerPrice,triggerTime,
      pendingAttempt,
    };
  }
  if(!(expectedRemaining>1e-12))return null;
  if(nextAttempt>3){
    return {
      kind:'EXHAUSTED',symbol,direction:dir,remainingQuantity:currentQty,
      originalQuantity:originalQty,executedQuantity:cumulativeExecuted,
      clientAlgoId,algoId:String(algo?.algoId||''),actualOrderId,
      actualOrderStatus:actualStatus,recoveryCommandId,triggerPrice,triggerTime,
    };
  }
  const priceMatch=nextAttempt===1?'OPPONENT_5':nextAttempt===2?'OPPONENT_10':'OPPONENT_20';
  return {
    kind:'REMAINDER',symbol,direction:dir,remainingQuantity:currentQty,
    originalQuantity:originalQty,executedQuantity:cumulativeExecuted,
    clientAlgoId,algoId:String(algo?.algoId||''),actualOrderId,
    actualOrderStatus:actualStatus,recoveryCommandId,triggerPrice,triggerTime,
    nextAttempt,priceMatch,
  };
}

async function queryRecoveryOrderByClientId({serverTime,apiKey,secret,symbol,clientOrderId}){
  try{
    const raw=await signedGet('/fapi/v1/order',apiKey,secret,serverTime,{symbol,origClientOrderId:clientOrderId});
    return {orderClass:'STANDARD',...normalizeActualOrder(raw)};
  }catch(error){
    if(Number(error?.binanceCode)===-2013)return null;
    throw error;
  }
}

async function detectTriggeredMaxLossRemainders({
  serverTime,apiKey,secret,positions,missingTargets,controllerState,
}={}){
  const missing=new Set(Array.isArray(missingTargets)?missingTargets.map(x=>String(x||'').toUpperCase()):[]);
  const remainders=[],ambiguous=[],inconsistent=[],pending=[],exhausted=[];
  for(const position of Array.isArray(positions)?positions:[]){
    const key=positionKey(position);
    if(!missing.has(key))continue;
    const symbol=String(position?.symbol||'').toUpperCase();
    const configured=configuredMaxLossUsd(controllerState,symbol);
    if(!(configured>0))continue;
    const historyRaw=await signedGet('/fapi/v1/allAlgoOrders',apiKey,secret,serverTime,{
      symbol,
      startTime:Math.max(0,Number(serverTime)-7*24*60*60*1000),
      endTime:Number(serverTime),
      limit:1000,
    });
    if(!Array.isArray(historyRaw))throw new Error('BINANCE_ALGO_HISTORY_INVALID');
    const history=historyRaw
      .map(normalizeActualAlgoOrder)
      .filter(algo=>
        String(algo?.symbol||'').toUpperCase()===symbol&&
        /^zth-MAX-[A-Za-z0-9._:-]+$/.test(String(algo?.clientAlgoId||''))&&
        ['TRIGGERED','FINISHED'].includes(String(algo?.status||'').toUpperCase())&&
        Boolean(String(algo?.actualOrderId||''))
      )
      .sort((a,b)=>number(b.triggerTime,b.updateTime)-number(a.triggerTime,a.updateTime))
      .slice(0,4);
    const matches=[];
    for(const algo of history){
      const actualRaw=await signedGet('/fapi/v1/order',apiKey,secret,serverTime,{
        symbol,
        orderId:String(algo.actualOrderId),
      });
      const actualOrder={orderClass:'STANDARD',...normalizeActualOrder(actualRaw)};
      const recoveryCommandId=maxLossRemainderCommandId(algo);
      const recoveryOrders=[];
      if(recoveryCommandId){
        for(let attempt=1;attempt<=3;attempt++){
          const clientOrderId=recoveryClientOrderId(recoveryCommandId,symbol,attempt);
          const order=await queryRecoveryOrderByClientId({
            serverTime,apiKey,secret,symbol,clientOrderId,
          });
          if(order)recoveryOrders.push({attempt,clientOrderId,order});
        }
      }
      const evidence=evaluateTriggeredMaxLossRemainder({
        position,algo,actualOrder,recoveryOrders,configuredMaxLossUsd:configured,
      });
      if(evidence?.kind==='INCONSISTENT')inconsistent.push(evidence);
      else if(evidence?.kind==='PENDING')pending.push(evidence);
      else if(evidence?.kind==='EXHAUSTED')exhausted.push(evidence);
      else if(evidence?.kind==='REMAINDER')matches.push(evidence);
    }
    if(matches.length===1)remainders.push(matches[0]);
    else if(matches.length>1)ambiguous.push(key);
  }
  return {remainders,ambiguous,inconsistent,pending,exhausted};
}

function expectedPositions(runtimeState) {
  const data = runtimeState?.data || {};
  const list = Array.isArray(data.binancePositions) ? data.binancePositions : [];
  return list
    .filter(x => x && typeof x === 'object' && String(x.symbol || '').trim())
    .map(x => ({
      symbol: String(x.symbol || '').toUpperCase(),
      direction: direction(x),
      positionSide: String(x.positionSide || ''),
      positionAmt: String(x.positionAmt ?? x.quantity ?? x.qty ?? ''),
      quantity: positionQty(x),
      entryPrice: number(x.entryPrice),
    }));
}

function expectedOrders(runtimeState) {
  const data = runtimeState?.data || {};
  const source = Array.isArray(data.binanceOrders)
    ? data.binanceOrders
    : Array.isArray(data.protectiveOrders)
      ? data.protectiveOrders
      : [];

  return source
    .filter(x => x && typeof x === 'object')
    .map(x => ({
      symbol: String(x.symbol || '').toUpperCase(),
      orderId: String(x.orderId ?? ''),
      clientOrderId: String(x.clientOrderId ?? ''),
      algoId: String(x.algoId ?? ''),
      clientAlgoId: String(x.clientAlgoId ?? ''),
      type: String(x.type || ''),
      side: String(x.side || ''),
      positionSide: String(x.positionSide || ''),
      reduceOnly: x.reduceOnly === true || x.reduceOnly === 'true',
      closePosition: x.closePosition === true || x.closePosition === 'true',
    }));
}

function orderKey(order) {
  if (String(order?.algoId || '')) return `${order.symbol}:algo:${String(order.algoId)}`;
  if (String(order?.clientAlgoId || '')) return `${order.symbol}:algo-client:${String(order.clientAlgoId)}`;
  if (String(order?.orderId || '')) return `${order.symbol}:id:${String(order.orderId)}`;
  if (String(order?.clientOrderId || '')) return `${order.symbol}:client:${String(order.clientOrderId)}`;
  return '';
}

function zenithManagedOrderId(order) {
  const id = String(order?.clientAlgoId || order?.clientOrderId || '');
  return /^zth-[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

function orderProtectsPosition(order, position) {
  if (String(order?.symbol || '').toUpperCase() !== String(position?.symbol || '').toUpperCase()) return false;
  if (String(order?.positionSide || '').toUpperCase() !== String(position?.positionSide || '').toUpperCase()) return false;
  const expectedSide = direction(position) === 'LONG' ? 'SELL' : 'BUY';
  if (String(order?.side || '').toUpperCase() !== expectedSide) return false;
  return order?.reduceOnly === true || order?.closePosition === true;
}

function configuredMaxLossUsd(controllerState, symbol) {
  const data = controllerState?.data && typeof controllerState.data === 'object' ? controllerState.data : null;
  if (!data) return NaN;
  const sym = String(symbol || '').toUpperCase();
  const tokenSettings = data.tokenSettings && typeof data.tokenSettings === 'object' ? data.tokenSettings : {};
  const globalSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const token = tokenSettings[sym] && typeof tokenSettings[sym] === 'object' ? tokenSettings[sym] : {};
  const value = number(token.maxLoss, number(globalSettings.maxLoss, NaN));
  return value > 0 ? Math.min(value, REAL_RISK_LIMITS.maxLossUsd) : NaN;
}

function configuredMarginUsd(controllerState, symbol) {
  const data = controllerState?.data && typeof controllerState.data === 'object' ? controllerState.data : null;
  if (!data) return NaN;
  const sym = String(symbol || '').toUpperCase();
  const tokenSettings = data.tokenSettings && typeof data.tokenSettings === 'object' ? data.tokenSettings : {};
  const globalSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const token = tokenSettings[sym] && typeof tokenSettings[sym] === 'object' ? tokenSettings[sym] : {};
  const value = number(token.margin, number(globalSettings.margin, NaN));
  return value > 0 ? value : NaN;
}


function parseProcessingCommands(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    try {
      const parsed = typeof row === 'string' ? JSON.parse(row) : row;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
    } catch {}
  }
  return out;
}

function authorizedPendingMaxLossEdit(position, actualOrders, processingCommands, controllerState, masterDeviceId) {
  const symbol = String(position?.symbol || '').toUpperCase();
  const direction = String(position?.direction || '').toUpperCase();
  const quantity = positionQty(position);
  const controllerDeviceId = String(controllerState?.controllerDeviceId || '');
  const now = Date.now();
  const candidates = [];

  for (const command of Array.isArray(processingCommands) ? processingCommands : []) {
    if (String(command?.type || '').toUpperCase() !== 'EXEC_UPDATE_PROTECTION') continue;
    if (String(command?.deviceId || '') !== controllerDeviceId || !controllerDeviceId) continue;
    if (String(command?.claimedBy || '') !== String(masterDeviceId || '') || !masterDeviceId) continue;
    const expiresAt = number(command?.expiresAt, NaN);
    if (!(expiresAt > now)) continue;
    const payload = command?.payload && typeof command.payload === 'object' ? command.payload : null;
    if (!payload || String(payload.protectionKind || '').toUpperCase() !== 'MAX_LOSS') continue;
    if (String(payload.symbol || '').toUpperCase() !== symbol) continue;
    if (String(payload.direction || '').toUpperCase() !== direction) continue;
    const requestedMaxLossUsd = number(payload.maxLossUsd, NaN);
    const triggerPrice = number(payload.triggerPrice, NaN);
    const commandQuantity = number(payload.quantity, NaN);
    if (!(requestedMaxLossUsd >= 2 && requestedMaxLossUsd <= REAL_RISK_LIMITS.maxLossUsd)) continue;
    const configuredMargin = configuredMarginUsd(controllerState, symbol);
    if (!(configuredMargin > 0) || requestedMaxLossUsd > configuredMargin + 1e-8) continue;
    if (!(triggerPrice > 0) || !(commandQuantity > 0) || Math.abs(commandQuantity - quantity) > 1e-12) continue;
    const previousClientAlgoId = String(payload.previousClientAlgoId || '');
    const expectedSide = direction === 'LONG' ? 'SELL' : 'BUY';
    const matchingNew = (Array.isArray(actualOrders) ? actualOrders : []).find(order =>
      String(order?.orderClass || '').toUpperCase() === 'ALGO' &&
      String(order?.symbol || '').toUpperCase() === symbol &&
      String(order?.positionSide || '').toUpperCase() === String(position?.positionSide || '').toUpperCase() &&
      String(order?.side || '').toUpperCase() === expectedSide &&
      String(order?.type || '').toUpperCase() === 'STOP' &&
      String(order?.timeInForce || '').toUpperCase() === 'IOC' &&
      order?.reduceOnly === true &&
      order?.closePosition !== true &&
      Math.abs(number(order?.origQty, NaN) - quantity) <= 1e-12 &&
      String(order?.priceMatch || '').toUpperCase() === 'OPPONENT' &&
      Boolean(zenithManagedOrderId(order)) &&
      Math.abs(number(order?.triggerPrice ?? order?.stopPrice, NaN) - triggerPrice) <= Math.max(1e-9, Math.abs(triggerPrice) * 1e-10)
    );
    if (!matchingNew) continue;
    candidates.push({
      commandId:String(command?.id || ''),
      symbol,
      direction,
      requestedMaxLossUsd,
      triggerPrice,
      previousClientAlgoId,
      newClientAlgoId:String(matchingNew?.clientAlgoId || ''),
    });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function enforceConfiguredMaxLossSafety(result, controllerState, actualPositions, actualOrders, processingCommands = [], masterDeviceId = '') {
  const unavailable = [];
  const exceeds = [];
  const missingConfiguredProtection = [];

  for (const position of Array.isArray(actualPositions) ? actualPositions : []) {
    const key = positionKey(position);
    const configuredMaxLoss = configuredMaxLossUsd(controllerState, position.symbol);
    const pendingEdit = authorizedPendingMaxLossEdit(
      position, actualOrders, processingCommands, controllerState, masterDeviceId
    );
    const effectiveMaxLoss = pendingEdit?.requestedMaxLossUsd || configuredMaxLoss;
    if (!(effectiveMaxLoss > 0)) {
      unavailable.push(key);
      missingConfiguredProtection.push(key);
      continue;
    }

    const entryPrice = number(position.entryPrice, NaN);
    const quantity = positionQty(position);
    const expectedSide = position.direction === 'LONG' ? 'SELL' : 'BUY';
    let validConfiguredProtection = false;

    for (const order of Array.isArray(actualOrders) ? actualOrders : []) {
      if (String(order?.orderClass || '').toUpperCase() !== 'ALGO') continue;
      if (String(order?.symbol || '').toUpperCase() !== position.symbol) continue;
      if (String(order?.positionSide || '').toUpperCase() !== String(position.positionSide || '').toUpperCase()) continue;
      if (String(order?.side || '').toUpperCase() !== expectedSide) continue;
      if (String(order?.type || '').toUpperCase() !== 'STOP') continue;
      if (String(order?.timeInForce || '').toUpperCase() !== 'IOC') continue;
      if (order?.reduceOnly !== true || order?.closePosition === true) continue;
      if (Math.abs(number(order?.origQty, NaN) - quantity) > 1e-12) continue;
      if (String(order?.priceMatch || '').toUpperCase() !== 'OPPONENT') continue;
      if (!zenithManagedOrderId(order)) continue;

      const trigger = number(order?.triggerPrice ?? order?.stopPrice, NaN);
      if (!(entryPrice > 0) || !(trigger > 0) || !(quantity > 0)) continue;
      const lossSide = position.direction === 'LONG' ? trigger < entryPrice : trigger > entryPrice;
      if (!lossSide) continue;

      const impliedLossUsd = position.direction === 'LONG'
        ? (entryPrice - trigger) * quantity
        : (trigger - entryPrice) * quantity;

      const clientAlgoId = String(order?.clientAlgoId || '');
      const isPreviousPendingProtection = Boolean(
        pendingEdit?.previousClientAlgoId && clientAlgoId === pendingEdit.previousClientAlgoId
      );
      const allowedForOrder = isPreviousPendingProtection && configuredMaxLoss > 0
        ? configuredMaxLoss
        : effectiveMaxLoss;
      if (impliedLossUsd > allowedForOrder + 1e-8) {
        exceeds.push({
          key,
          symbol: position.symbol,
          direction: position.direction,
          triggerPrice: trigger,
          impliedLossUsd,
          configuredMaxLossUsd: configuredMaxLoss,
          pendingRequestedMaxLossUsd: pendingEdit?.requestedMaxLossUsd || null,
          hardMaxLossUsd: REAL_RISK_LIMITS.maxLossUsd,
          clientAlgoId,
          algoId: String(order?.algoId || ''),
        });
        continue;
      }
      validConfiguredProtection = true;
    }

    if (!validConfiguredProtection) missingConfiguredProtection.push(key);
  }

  if (!result?.differences || typeof result.differences !== 'object') result.differences = {};
  result.differences.configuredMaxLossUnavailable = [...new Set(unavailable)];
  result.differences.authorizedPendingMaxLossEdits = (Array.isArray(actualPositions) ? actualPositions : [])
    .map(position => authorizedPendingMaxLossEdit(
      position, actualOrders, processingCommands, controllerState, masterDeviceId
    ))
    .filter(Boolean);
  if (exceeds.length) {
    const existingUnsafe = Array.isArray(result.differences.unsafeMaxLossProtections)
      ? result.differences.unsafeMaxLossProtections : [];
    const seen = new Set(existingUnsafe.map(row => `${row?.key}:${row?.clientAlgoId}:${row?.algoId}`));
    for (const row of exceeds) {
      const id = `${row.key}:${row.clientAlgoId}:${row.algoId}`;
      if (!seen.has(id)) {
        existingUnsafe.push(row);
        seen.add(id);
      }
    }
    result.differences.unsafeMaxLossProtections = existingUnsafe;
  }

  const missing = new Set(Array.isArray(result.differences.missingMaxLossProtections)
    ? result.differences.missingMaxLossProtections : []);
  for (const key of missingConfiguredProtection) missing.add(key);
  result.differences.missingMaxLossProtections = [...missing];

  const reasons = Array.isArray(result.reasons) ? result.reasons : [];
  if (unavailable.length && !reasons.includes('CONFIGURED_MAX_LOSS_UNAVAILABLE')) {
    reasons.push('CONFIGURED_MAX_LOSS_UNAVAILABLE');
  }
  if (exceeds.length && !reasons.includes('MAX_LOSS_EXCEEDS_CONFIGURED_LIMIT')) {
    reasons.push('MAX_LOSS_EXCEEDS_CONFIGURED_LIMIT');
  }
  if (missingConfiguredProtection.length && !reasons.includes('MISSING_BINANCE_MAX_LOSS_PROTECTION')) {
    reasons.push('MISSING_BINANCE_MAX_LOSS_PROTECTION');
  }

  if (unavailable.length || exceeds.length || missingConfiguredProtection.length) {
    result.failClosed = true;
    result.status = 'MISMATCH';
  }
  result.reasons = reasons;
  return result;
}

function reconcile(runtimeState, actualPositions, actualOrders, entryTransitions = []) {
  const runtimeMode = String(runtimeState?.data?.executionMode || runtimeState?.data?.mode || '').toUpperCase();
  const runtimeIsReal = runtimeMode === 'REAL';
  const expectedPos = runtimeIsReal ? expectedPositions(runtimeState) : [];
  const expectedOrd = runtimeIsReal ? expectedOrders(runtimeState) : [];
  const transitionState = evaluateEntryTransitionReconciliation({
    transitions: entryTransitions,
    actualOrders,
    actualPositions,
  });
  const transitionAllowedOrders = transitionState.allowedOrderIdentities;

  const actualPosMap = new Map(actualPositions.map(p => [positionKey(p), p]));
  const expectedPosMap = new Map(expectedPos.map(p => [positionKey(p), p]));

  const untrackedPositions = [];
  const missingPositions = [];
  const quantityMismatches = [];

  for (const [key, actual] of actualPosMap) {
    const expected = expectedPosMap.get(key);
    if (!expected) {
      untrackedPositions.push(actual);
      continue;
    }
    if (!nearlyEqual(actual.quantity, expected.quantity)) {
      quantityMismatches.push({
        key,
        symbol: actual.symbol,
        direction: actual.direction,
        expectedQuantity: expected.quantity,
        actualQuantity: actual.quantity,
      });
    }
  }

  for (const [key, expected] of expectedPosMap) {
    if (!actualPosMap.has(key)) missingPositions.push(expected);
  }

  const actualOrderMap = new Map(
    actualOrders.map(o => [orderKey(o), o]).filter(([key]) => key)
  );
  const expectedOrderMap = new Map(
    expectedOrd.map(o => [orderKey(o), o]).filter(([key]) => key)
  );

  const untrackedOrders = [];
  const missingOrders = [];

  for (const [key, actual] of actualOrderMap) {
    if (!expectedOrderMap.has(key) && !transitionAllowedOrders.has(key)) untrackedOrders.push(actual);
  }
  for (const [key, expected] of expectedOrderMap) {
    if (!actualOrderMap.has(key)) missingOrders.push(expected);
  }

  const reasons = [];
  if (!runtimeIsReal && actualPositions.length) reasons.push('BINANCE_POSITION_WHILE_RUNTIME_NOT_REAL');
  if (!runtimeIsReal && actualOrders.length) reasons.push('BINANCE_ORDER_WHILE_RUNTIME_NOT_REAL');
  if (!runtimeIsReal && transitionState.active.length) reasons.push('ENTRY_TRANSITION_RUNTIME_NOT_REAL');
  if (transitionState.invalid.length) reasons.push('ENTRY_TRANSITION_STATE_INVALID');
  if (transitionState.missingProtections.length) reasons.push('ENTRY_TRANSITION_PROTECTION_MISSING');
  if (transitionState.missingEntries.length) reasons.push('ENTRY_TRANSITION_ENTRY_MISSING');
  if (untrackedPositions.length) reasons.push('UNTRACKED_BINANCE_POSITION');
  if (missingPositions.length) reasons.push('MISSING_BINANCE_POSITION');
  if (quantityMismatches.length) reasons.push('BINANCE_POSITION_QUANTITY_MISMATCH');
  if (untrackedOrders.length) reasons.push('UNTRACKED_BINANCE_ORDER');
  if (missingOrders.length) reasons.push('MISSING_BINANCE_ORDER');

  const orphanZenithProtectiveOrders = actualOrders.filter(order =>
    Boolean(zenithManagedOrderId(order)) &&
    (order?.reduceOnly === true || order?.closePosition === true) &&
    !transitionAllowedOrders.has(entryTransitionOrderIdentity(order)) &&
    !actualPositions.some(position => orderProtectsPosition(order, position))
  );
  if (orphanZenithProtectiveOrders.length) reasons.push('ORPHAN_ZENITH_PROTECTIVE_ORDER');

  if (!runtimeState || !runtimeState.data || typeof runtimeState.data !== 'object') reasons.push('RUNTIME_STATE_UNAVAILABLE');
  const runtimeAge = Date.now() - Number(runtimeState?.updatedAt);
  if (!Number.isFinite(runtimeAge) || runtimeAge < 0 || runtimeAge > 30000) reasons.push('RUNTIME_STATE_STALE');
  if (runtimeIsReal && (!Array.isArray(runtimeState.data.binancePositions) || !Array.isArray(runtimeState.data.binanceOrders))) reasons.push('RUNTIME_INVENTORY_INCOMPLETE');
  if (runtimeIsReal && Array.isArray(runtimeState.data.binancePositions) && runtimeState.data.binancePositions.some(p =>
    !p || !p.symbol || (p.positionAmt ?? p.quantity ?? p.qty) == null ||
    !Number.isFinite(Number(p.positionAmt ?? p.quantity ?? p.qty)) || positionQty(p) <= 0
  )) reasons.push('EXPECTED_POSITION_INVALID');
  if (runtimeIsReal && Array.isArray(runtimeState.data.binanceOrders) && runtimeState.data.binanceOrders.some(o =>
    !o || !o.symbol || !orderKey(o) || !['BUY', 'SELL'].includes(o.side) || !o.type
  )) reasons.push('EXPECTED_ORDER_INVALID');
  if (actualOrderMap.size !== actualOrders.length || expectedOrderMap.size !== expectedOrd.length) reasons.push('ORDER_IDENTITIES_INVALID');
  if (actualPosMap.size !== actualPositions.length || expectedPosMap.size !== expectedPos.length) reasons.push('POSITION_IDENTITIES_INVALID');
  // An order ID alone never proves that a protective order is safe.
  const orderMismatches = [];
  for (const [key, expected] of expectedOrderMap) {
    const actual = actualOrderMap.get(key);
    if (actual && ['symbol', 'side', 'positionSide', 'type', 'reduceOnly', 'closePosition'].some(field => actual[field] !== expected[field])) orderMismatches.push(key);
  }
  if (orderMismatches.length) reasons.push('BINANCE_ORDER_MISMATCH');

  const forbiddenMarketProtectiveOrders = actualOrders.filter(order => {
    const type = String(order?.type || '').toUpperCase();
    if (!['MARKET','STOP_MARKET','TAKE_PROFIT_MARKET','TRAILING_STOP_MARKET'].includes(type)) return false;
    if (!(order?.reduceOnly === true || order?.closePosition === true)) return false;
    return actualPositions.some(position => orderProtectsPosition(order, position));
  });
  if (forbiddenMarketProtectiveOrders.length) reasons.push('FORBIDDEN_MARKET_PROTECTIVE_ORDER');

  const missingProtections = actualPositions.filter(position => !actualOrders.some(order =>
    order.symbol === position.symbol && order.positionSide === position.positionSide &&
    order.side === (position.direction === 'LONG' ? 'SELL' : 'BUY') &&
    String(order.type || '').toUpperCase() === 'STOP' &&
    order.reduceOnly === true && order.closePosition !== true &&
    number(order.origQty) - number(order.executedQty) >= position.quantity
  )).map(positionKey);
  if (missingProtections.length) reasons.push('MISSING_BINANCE_PROTECTION');

  const maxLossProtectionCounts = new Map();
  const unsafeMaxLossProtections = [];
  for (const position of actualPositions) {
    const key = positionKey(position);
    const entryPrice = number(position.entryPrice, NaN);
    const quantity = positionQty(position);
    const expectedSide = position.direction === 'LONG' ? 'SELL' : 'BUY';
    const valid = [];
    for (const order of actualOrders) {
      if (String(order?.orderClass || '').toUpperCase() !== 'ALGO') continue;
      if (String(order?.symbol || '').toUpperCase() !== position.symbol) continue;
      if (String(order?.positionSide || '').toUpperCase() !== String(position.positionSide || '').toUpperCase()) continue;
      if (String(order?.side || '').toUpperCase() !== expectedSide) continue;
      if (String(order?.type || '').toUpperCase() !== 'STOP') continue;
      if (String(order?.timeInForce || '').toUpperCase() !== 'IOC') continue;
      if (order?.reduceOnly !== true || order?.closePosition === true) continue;
      if (Math.abs(number(order?.origQty, NaN) - quantity) > 1e-12) continue;
      if (String(order?.priceMatch || '').toUpperCase() !== 'OPPONENT') continue;
      if (!zenithManagedOrderId(order)) continue;
      const trigger = number(order?.triggerPrice ?? order?.stopPrice, NaN);
      if (!(entryPrice > 0) || !(trigger > 0) || !(quantity > 0)) continue;
      const lossSide = position.direction === 'LONG' ? trigger < entryPrice : trigger > entryPrice;
      if (!lossSide) continue;
      const impliedLossUsd = position.direction === 'LONG'
        ? (entryPrice - trigger) * quantity
        : (trigger - entryPrice) * quantity;
      if (impliedLossUsd > REAL_RISK_LIMITS.maxLossUsd + 1e-8) {
        unsafeMaxLossProtections.push({
          key,
          symbol: position.symbol,
          direction: position.direction,
          triggerPrice: trigger,
          impliedLossUsd,
          hardMaxLossUsd: REAL_RISK_LIMITS.maxLossUsd,
          clientAlgoId: String(order?.clientAlgoId || ''),
          algoId: String(order?.algoId || ''),
        });
        continue;
      }
      valid.push(order);
    }
    maxLossProtectionCounts.set(key, valid.length);
  }
  const missingMaxLossProtections = actualPositions
    .filter(position => (maxLossProtectionCounts.get(positionKey(position)) || 0) === 0)
    .map(positionKey);
  const ambiguousMaxLossProtections = actualPositions
    .filter(position => (maxLossProtectionCounts.get(positionKey(position)) || 0) > 1)
    .map(positionKey);
  if (missingMaxLossProtections.length) reasons.push('MISSING_BINANCE_MAX_LOSS_PROTECTION');
  if (ambiguousMaxLossProtections.length) reasons.push('AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION');

  const transitionMissingProtectionPendingEntries = transitionState.active
    .filter(transition => {
      if (transition.state !== 'ENTRY_SUBMITTED') return false;
      const key = transition.symbol + ':' + transition.direction;
      if (!transitionState.missingProtections.includes(key)) return false;
      const live = actualPositions.some(position =>
        String(position?.symbol || '').toUpperCase() === transition.symbol &&
        positionQty(position) > 0 &&
        direction(position) === transition.direction
      );
      if (live) return false;
      return actualOrders.some(order => transitionEntryMatches(order, transition));
    })
    .map(transition => ({
      commandId: transition.commandId,
      symbol: transition.symbol,
      direction: transition.direction,
      quantity: transition.quantity,
      limitPrice: transition.limitPrice,
      entryClientOrderId: transition.entryClientOrderId,
      protectionClientAlgoId: transition.protectionClientAlgoId,
      expiresAt: transition.expiresAt,
    }));

  const transitionEntryMissingPreparedProtections = transitionState.active
    .filter(transition => {
      if (transition.state !== 'ENTRY_SUBMITTED') return false;
      const key = transition.symbol + ':' + transition.direction;
      if (!transitionState.missingEntries.includes(key)) return false;
      const live = actualPositions.some(position =>
        String(position?.symbol || '').toUpperCase() === transition.symbol &&
        positionQty(position) > 0 &&
        direction(position) === transition.direction
      );
      if (live) return false;
      return actualOrders.some(order => transitionProtectionMatches(order, transition));
    })
    .map(transition => {
      const order = actualOrders.find(row => transitionProtectionMatches(row, transition)) || {};
      return {
        commandId: transition.commandId,
        symbol: transition.symbol,
        entrySide: transition.side,
        direction: transition.direction,
        quantity: transition.quantity,
        limitPrice: transition.limitPrice,
        maxLossUsd: transition.maxLossUsd,
        entryClientOrderId: transition.entryClientOrderId,
        protectionClientAlgoId: transition.protectionClientAlgoId,
        orderClass: 'ALGO',
        clientAlgoId: transition.protectionClientAlgoId,
        side: String(order.side || (transition.direction === 'LONG' ? 'SELL' : 'BUY')).toUpperCase(),
        positionSide: String(order.positionSide || 'BOTH').toUpperCase(),
        type: String(order.type || 'STOP').toUpperCase(),
        reduceOnly: order.reduceOnly === true || order.reduceOnly === 'true',
        closePosition: order.closePosition === true || order.closePosition === 'true',
        triggerPrice: String(order.triggerPrice ?? order.stopPrice ?? transition.protectionTriggerPrice),
        price: String(order.price ?? ''),
        priceMatch: String(order.priceMatch || ''),
        origQty: String(order.origQty ?? ''),
        timeInForce: String(order.timeInForce || ''),
        expiresAt: transition.expiresAt,
      };
    });

  const failClosed = reasons.length > 0;

  return {
    status: failClosed ? 'MISMATCH' : (runtimeIsReal ? 'CLEAN_REAL' : 'CLEAN_IDLE'),
    failClosed,
    reasons,
    runtimeStatePresent: Boolean(runtimeState),
    runtimeMode: runtimeMode || 'NONE',
    expected: {
      positions: expectedPos.length,
      orders: expectedOrd.length,
    },
    actual: {
      positions: actualPositions.length,
      orders: actualOrders.length,
    },
    differences: {
      untrackedPositions,
      missingPositions,
      quantityMismatches,
      untrackedOrders,
      missingOrders,
      orderMismatches,
      orphanZenithProtectiveOrders,
      forbiddenMarketProtectiveOrders: forbiddenMarketProtectiveOrders.map(order => ({
        symbol: String(order?.symbol || '').toUpperCase(),
        side: String(order?.side || '').toUpperCase(),
        positionSide: String(order?.positionSide || '').toUpperCase(),
        type: String(order?.type || '').toUpperCase(),
        clientOrderId: String(order?.clientOrderId || ''),
        clientAlgoId: String(order?.clientAlgoId || ''),
        orderId: String(order?.orderId || ''),
        algoId: String(order?.algoId || ''),
      })),
      missingProtections,
      missingMaxLossProtections,
      ambiguousMaxLossProtections,
      unsafeMaxLossProtections,
      entryTransitions: {
        active: transitionState.active.map(row => ({
          state: row.state,
          symbol: row.symbol,
          direction: row.direction,
          commandId: row.commandId,
          quantity: row.quantity,
          limitPrice: row.limitPrice,
          entryClientOrderId: row.entryClientOrderId,
          protectionClientAlgoId: row.protectionClientAlgoId,
          expiresAt: row.expiresAt,
        })),
        missingProtectionPendingEntries: transitionMissingProtectionPendingEntries,
        entryMissingPreparedProtections: transitionEntryMissingPreparedProtections,
        invalidReasons: transitionState.invalid.map(row => String(row.reason || 'ENTRY_TRANSITION_INVALID')),
        expired: transitionState.expired.length,
        missingProtections: transitionState.missingProtections,
        missingEntries: transitionState.missingEntries,
      },
    },
  };
}

function parseEntryTransitionStore(raw) {
  if (raw == null) return [];
  const records = [];
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      const field = String(raw[i] ?? '');
      const value = raw[i + 1];
      if (!field) continue;
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        records.push(parsed && typeof parsed === 'object' ? parsed : { __invalidEntryTransition:true });
      } catch {
        records.push({ __invalidEntryTransition:true });
      }
    }
    return records;
  }
  if (raw && typeof raw === 'object') {
    for (const value of Object.values(raw)) {
      try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        records.push(parsed && typeof parsed === 'object' ? parsed : { __invalidEntryTransition:true });
      } catch {
        records.push({ __invalidEntryTransition:true });
      }
    }
    return records;
  }
  return [{ __invalidEntryTransition:true }];
}

async function beginReconciliationAttempt(marker, device) {
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registered ~= ARGV[3] then return -1 end",
    "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
    "if lease ~= ARGV[3] then return -2 end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[4]) or '0')",
    "if roleEpoch ~= ARGV[4] then return -3 end",
    "local previous = redis.call('GET', KEYS[1])",
    "if previous then",
    "  local ok, value = pcall(cjson.decode, previous)",
    "  if ok and tonumber(value.observedAt or 0) >= tonumber(ARGV[1]) then return 0 end",
    "end",
    "redis.call('SET', KEYS[1], ARGV[2], 'EX', '30')",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '4',
    KEY_RECONCILE_LAST,
    `${PREFIX}:role-device:master`,
    `${PREFIX}:master`,
    roleAssignmentKey(PREFIX, 'master'),
    String(marker.observedAt),
    JSON.stringify(marker),
    String(device?.deviceId || ''),
    String(device?.roleIssuedAt || '0'),
  ]));
}

async function commitReconciliationAttempt(report, runtimeRaw, attemptId, device) {
  const script = [
    "local current = redis.call('GET', KEYS[1])",
    "if not current then return 0 end",
    "local ok, value = pcall(cjson.decode, current)",
    "if not ok or tostring(value.attemptId or '') ~= ARGV[1] then return 0 end",
    "local registered = tostring(redis.call('GET', KEYS[3]) or '')",
    "if registered ~= ARGV[4] then return -2 end",
    "local lease = tostring(redis.call('GET', KEYS[4]) or '')",
    "if lease ~= ARGV[4] then return -3 end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[5]) or '0')",
    "if roleEpoch ~= ARGV[5] then return -4 end",
    "if (redis.call('GET', KEYS[2]) or '') ~= ARGV[2] then return -1 end",
    "redis.call('SET', KEYS[1], ARGV[3], 'EX', '30')",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '5',
    KEY_RECONCILE_LAST,
    KEY_STATE,
    `${PREFIX}:role-device:master`,
    `${PREFIX}:master`,
    roleAssignmentKey(PREFIX, 'master'),
    String(attemptId || ''),
    runtimeRaw || '',
    JSON.stringify(report),
    String(device?.deviceId || ''),
    String(device?.roleIssuedAt || '0'),
  ]));
}

async function failReconciliationAttempt(report, attemptId) {
  const script = [
    "local current = redis.call('GET', KEYS[1])",
    "if not current then return 0 end",
    "local ok, value = pcall(cjson.decode, current)",
    "if not ok or tostring(value.attemptId or '') ~= ARGV[1] then return 0 end",
    "redis.call('SET', KEYS[1], ARGV[2], 'EX', '30')",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '1',
    KEY_RECONCILE_LAST,
    String(attemptId || ''),
    JSON.stringify(report),
  ]));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
  }
  if (!sameOriginMutation(req)) {
    return send(res, 403, { ok: false, code: 'ORIGIN_FORBIDDEN' });
  }
  const bodyStatus = requestBodyStatus(req, 4096);
  if (!bodyStatus.ok) {
    return send(res, 413, { ok: false, code: 'REQUEST_BODY_TOO_LARGE', maxBytes: bodyStatus.maxBytes });
  }
  if (!VERCEL_CONTROL_MUTATION_ALLOWED) {
    return send(res, 423, { ok: false, code: 'NON_PRODUCTION_CONTROL_MUTATION' });
  }

  let device = null;
  try {
    device = await requireCurrentMaster(req);
  } catch (e) {
    if (e?.code === 'MASTER_LEASE_REQUIRED' || e?.code === 'ENGINE_INSTANCE_FENCED') {
      return send(res, 409, {
        ok: false,
        code: e.code,
        error: e.code === 'ENGINE_INSTANCE_FENCED'
          ? 'Instance moteur Zenith remplacée ou expirée.'
          : 'Le MASTER Zenith ne détient pas le lease actif.',
      });
    }
    return send(res, 503, {
      ok: false,
      code: e?.code || 'AUTH_BACKEND_ERROR',
      error: 'Authentification Zenith indisponible.',
    });
  }

  if (!device) {
    return send(res, 401, {
      ok: false,
      code: 'MASTER_REQUIRED',
      error: 'MASTER Zenith autorisé requis.',
    });
  }

  try {
    if (!(await reconciliationRateAllowed(device.deviceId))) {
      const retryAfter = retryAfterSeconds();
      res.setHeader('Retry-After', String(retryAfter));
      return send(res, 429, {
        ok: false,
        code: 'BINANCE_RECONCILE_RATE_LIMIT',
        retryAfterSeconds: retryAfter,
      });
    }
  } catch (e) {
    return send(res, 503, {
      ok: false,
      code: e?.code || 'RATE_LIMIT_BACKEND_ERROR',
      error: 'Protection anti-abus indisponible.',
    });
  }

  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) {
    return send(res, 503, {
      ok: false,
      code: 'MISSING_ENV',
      error: 'Variables Binance serveur absentes.',
    });
  }

  const started = Date.now();
  const attemptId = crypto.randomUUID();
  const attemptMarker = {
    version: 2,
    observedAt: started,
    completedAt: 0,
    status: 'IN_PROGRESS',
    failClosed: true,
    reasons: ['BINANCE_RECONCILIATION_IN_PROGRESS'],
    attemptId,
    deviceRole: device.role,
  };

  try {
    const begun = await beginReconciliationAttempt(attemptMarker, device);
    if (begun !== 1) {
      const code = begun === -1
        ? 'MASTER_ROLE_CHANGED_DURING_RECONCILE'
        : begun === -2
          ? 'MASTER_LEASE_CHANGED_DURING_RECONCILE'
          : begun === -3
            ? 'MASTER_ROLE_EPOCH_CHANGED_DURING_RECONCILE'
            : 'BINANCE_RECONCILIATION_SUPERSEDED';
      return send(res, 409, {
        ok: false,
        code,
        error: code === 'BINANCE_RECONCILIATION_SUPERSEDED'
          ? 'Une réconciliation Binance plus récente est déjà active.'
          : 'Autorité MASTER modifiée pendant la réconciliation Binance.',
      });
    }
  } catch (e) {
    return send(res, 503, {
      ok: false,
      code: e?.code || 'RECONCILIATION_STATE_UNAVAILABLE',
      error: 'État de réconciliation indisponible.',
    });
  }

  try {
    const [time, runtimeRaw, entryTransitionRaw, controllerRaw, processingRaw] = await Promise.all([
      jsonFetch(`${BASE}/fapi/v1/time`),
      redis(['GET', KEY_STATE]),
      redis(['HGETALL', KEY_ENTRY_TRANSITIONS]),
      redis(['GET', KEY_CONTROLLER_STATE]),
      redis(['LRANGE', KEY_PROCESSING, '0', '-1']),
    ]);

    const serverTime = number(time?.serverTime, NaN);
    if (!Number.isFinite(serverTime)) throw new Error('Heure Binance indisponible.');

    const [positions, openOrders, openAlgoOrders] = await Promise.all([
      signedGet('/fapi/v3/positionRisk', apiKey, secret, serverTime),
      signedGet('/fapi/v1/openOrders', apiKey, secret, serverTime),
      signedGet('/fapi/v1/openAlgoOrders', apiKey, secret, serverTime, { algoType: 'CONDITIONAL' }),
    ]);

    if (![positions, openOrders, openAlgoOrders].every(Array.isArray)) throw new Error('BINANCE_RESPONSE_INVALID');
    for (const p of positions) {
      if (!p || !p.symbol || !['BOTH', 'LONG', 'SHORT'].includes(p.positionSide) ||
          p.positionAmt === '' || p.positionAmt == null || !Number.isFinite(Number(p.positionAmt))) throw new Error('BINANCE_POSITION_INVALID');
    }
    for (const order of [...openOrders, ...openAlgoOrders]) {
      if (!order || !order.symbol || !['BUY', 'SELL'].includes(order.side) ||
          !['BOTH', 'LONG', 'SHORT'].includes(order.positionSide) ||
          !(order.orderId || order.clientOrderId || order.algoId || order.clientAlgoId)) throw new Error('BINANCE_ORDER_INVALID');
    }
    let runtimeState = null;
    try { runtimeState = runtimeRaw ? JSON.parse(runtimeRaw) : null; } catch {}

    const activePositionRows = (Array.isArray(positions) ? positions : [])
      .filter(p => Math.abs(number(p.positionAmt)) > 0);
    const activeSymbols = [...new Set(activePositionRows.map(p => String(p?.symbol || '').toUpperCase()).filter(Boolean))];
    const symbolConfigRows = await Promise.all(activeSymbols.map(async symbol => {
      const raw = await signedGet('/fapi/v1/symbolConfig', apiKey, secret, serverTime, { symbol });
      const rows = Array.isArray(raw) ? raw : [raw];
      const config = rows.find(row => String(row?.symbol || '').toUpperCase() === symbol) || null;
      if (!config) throw new Error('BINANCE_SYMBOL_CONFIG_MISSING');
      return config;
    }));
    const symbolConfigBySymbol = new Map(
      symbolConfigRows.map(config => [String(config?.symbol || '').toUpperCase(), config])
    );
    const actualPositions = activePositionRows.map(position => {
      const symbol = String(position?.symbol || '').toUpperCase();
      const config = symbolConfigBySymbol.get(symbol) || {};
      return normalizeActualPosition({
        ...position,
        marginType: config.marginType ?? position.marginType,
        leverage: config.leverage ?? position.leverage,
        isAutoAddMargin: config.isAutoAddMargin,
      });
    });

    const standardOrders = (Array.isArray(openOrders) ? openOrders : [])
      .map(o => ({ orderClass: 'STANDARD', ...normalizeActualOrder(o) }));

    const algoOrders = (Array.isArray(openAlgoOrders) ? openAlgoOrders : [])
      .map(normalizeActualAlgoOrder);

    const actualOrders = [...standardOrders, ...algoOrders];

    const entryTransitions = parseEntryTransitionStore(entryTransitionRaw);
    let controllerState = null;
    try { controllerState = controllerRaw ? JSON.parse(controllerRaw) : null; } catch {}
    const processingCommands = parseProcessingCommands(processingRaw);
    const result = enforceConfiguredMaxLossSafety(
      reconcile(runtimeState, actualPositions, actualOrders, entryTransitions),
      controllerState,
      actualPositions,
      actualOrders,
      processingCommands,
      device.deviceId
    );
    const triggeredRecovery=await detectTriggeredMaxLossRemainders({
      serverTime,apiKey,secret,positions:actualPositions,
      missingTargets:result?.differences?.missingMaxLossProtections,
      controllerState,
    });
    result.differences.triggeredMaxLossRemainders=triggeredRecovery.remainders;
    result.differences.ambiguousTriggeredMaxLossRemainders=triggeredRecovery.ambiguous;
    result.differences.inconsistentTriggeredMaxLossRemainders=triggeredRecovery.inconsistent;
    result.differences.pendingTriggeredMaxLossRemainders=triggeredRecovery.pending;
    result.differences.exhaustedTriggeredMaxLossRemainders=triggeredRecovery.exhausted;
    if(triggeredRecovery.remainders.length&&!result.reasons.includes('TRIGGERED_MAX_LOSS_REMAINDER')){
      result.reasons.push('TRIGGERED_MAX_LOSS_REMAINDER');
    }
    if(triggeredRecovery.ambiguous.length&&!result.reasons.includes('AMBIGUOUS_TRIGGERED_MAX_LOSS_REMAINDER')){
      result.reasons.push('AMBIGUOUS_TRIGGERED_MAX_LOSS_REMAINDER');
    }
    if(triggeredRecovery.inconsistent.length&&!result.reasons.includes('INCONSISTENT_TRIGGERED_MAX_LOSS_RESULT')){
      result.reasons.push('INCONSISTENT_TRIGGERED_MAX_LOSS_RESULT');
    }
    if(triggeredRecovery.pending.length&&!result.reasons.includes('TRIGGERED_MAX_LOSS_RECOVERY_PENDING')){
      result.reasons.push('TRIGGERED_MAX_LOSS_RECOVERY_PENDING');
    }
    if(triggeredRecovery.exhausted.length&&!result.reasons.includes('TRIGGERED_MAX_LOSS_RECOVERY_EXHAUSTED')){
      result.reasons.push('TRIGGERED_MAX_LOSS_RECOVERY_EXHAUSTED');
    }
    if(triggeredRecovery.remainders.length||triggeredRecovery.ambiguous.length||
       triggeredRecovery.inconsistent.length||triggeredRecovery.pending.length||
       triggeredRecovery.exhausted.length){
      result.failClosed=true;
      result.status='MISMATCH';
    }

    const unsafePositionConfigs = actualPositions
      .filter(position =>
        String(position?.marginType || '').toUpperCase() !== 'ISOLATED' ||
        position?.isAutoAddMargin !== false
      )
      .map(position => ({
        symbol:position.symbol,
        direction:position.direction,
        marginType:String(position.marginType || '').toUpperCase(),
        isAutoAddMargin:position.isAutoAddMargin,
      }));
    if (unsafePositionConfigs.length) {
      if (!result.reasons.includes('BINANCE_POSITION_CONFIG_UNSAFE')) {
        result.reasons.push('BINANCE_POSITION_CONFIG_UNSAFE');
      }
      result.failClosed = true;
      result.status = 'MISMATCH';
      result.differences.unsafePositionConfigs = unsafePositionConfigs;
    }
    result.actual.standardOrders = standardOrders.length;
    result.actual.algoOrders = algoOrders.length;
    const observedAt = started;

    const report = {
      version: 2,
      observedAt,
      completedAt: Date.now(),
      runtimeHash: sha256(runtimeRaw || ''),
      runtimeDataHash: sha256(stableStringify(runtimeState?.data ?? null)),
      serverTime,
      latencyMs: Date.now() - started,
      deviceRole: device.role,
      attemptId,
      certifiedPositions:actualPositions.map(position=>({
        symbol:position.symbol,
        direction:position.direction,
        positionSide:position.positionSide,
        positionAmt:position.positionAmt,
        quantity:position.quantity,
        entryPrice:position.entryPrice,
        marginType:position.marginType,
        isAutoAddMargin:position.isAutoAddMargin,
        leverage:position.leverage,
        updateTime:position.updateTime,
      })),
      ...result,
    };

    const reportHash = sha256(JSON.stringify(report));
    const stored = { ...report, reportHash };

    const committed = await commitReconciliationAttempt(stored, runtimeRaw || '', attemptId, device);
    if (committed !== 1) {
      const error = new Error(
        committed === -1
          ? 'RECONCILIATION_RUNTIME_CHANGED'
          : committed === -2
            ? 'MASTER_ROLE_CHANGED_DURING_RECONCILE'
            : committed === -3
              ? 'MASTER_LEASE_CHANGED_DURING_RECONCILE'
              : committed === -4
                ? 'MASTER_ROLE_EPOCH_CHANGED_DURING_RECONCILE'
                : 'RECONCILIATION_SUPERSEDED'
      );
      error.code = error.message;
      throw error;
    }
    await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
      at: observedAt,
      kind: 'BINANCE_RECONCILIATION',
      deviceId: device.deviceId,
      role: device.role,
      status: report.status,
      failClosed: report.failClosed,
      reasons: report.reasons,
      reportHash,
    })]);
    await redis(['LTRIM', KEY_AUDIT, '0', '199']);

    return send(res, 200, { ok: true, report: stored });
  } catch (e) {
    // The IN_PROGRESS marker already invalidated older CLEAN reports. Replace it
    // with UNAVAILABLE only if this request still owns the same reconciliation attempt.
    try {
      await failReconciliationAttempt({
        version: 2,
        observedAt: started,
        completedAt: Date.now(),
        status: 'UNAVAILABLE',
        failClosed: true,
        reasons: ['BINANCE_RECONCILE_FAILED'],
        attemptId,
        deviceRole: device.role,
      }, attemptId);
    } catch {}
    const authorityChanged = [
      'MASTER_ROLE_CHANGED_DURING_RECONCILE',
      'MASTER_LEASE_CHANGED_DURING_RECONCILE',
      'MASTER_ROLE_EPOCH_CHANGED_DURING_RECONCILE',
      'RECONCILIATION_SUPERSEDED',
      'RECONCILIATION_RUNTIME_CHANGED',
    ].includes(String(e?.code || ''));
    return send(res, authorityChanged ? 409 : 502, {
      ok: false,
      code: authorityChanged ? String(e.code) : 'BINANCE_RECONCILE_FAILED',
      error: authorityChanged
        ? 'Réconciliation Binance annulée car son autorité ou son état a changé.'
        : 'Réconciliation Binance impossible.',
      binanceCode: e?.binanceCode ?? null,
    });
  }
}
