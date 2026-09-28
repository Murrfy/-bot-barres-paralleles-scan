/*
================================================================================
BLOC 7 VERROUILLE — ACCES BINANCE / PERMISSIONS

NE TOUCHEZ PAS A CE PUTAIN DE BLOC SANS L'ACCORD EXPLICITE DE WALTER.

Permissions de la cle Binance de trading et separation lecture/trading.
AUCUNE MODIFICATION SANS L'ACCORD EXPLICITE DE WALTER ET SANS REPASSER LES TESTS DU BLOC 7.
================================================================================
*/
import crypto from 'node:crypto';

const BINANCE_API_BASE='https://api.binance.com';
const BINANCE_API_RESTRICTIONS_PATH='/sapi/v1/account/apiRestrictions';
const BINANCE_API_TIME_PATH='/api/v3/time';
const BINANCE_PERMISSION_RECV_WINDOW=5000;

export function binanceApiPermissionBlockers(permission){
  if(!permission||typeof permission!=='object')return ['BINANCE_API_PERMISSIONS_UNAVAILABLE'];
  const blockers=[];
  if(permission.ipRestrict!==true)blockers.push('BINANCE_API_IP_RESTRICTION_REQUIRED');
  if(permission.enableReading!==true)blockers.push('BINANCE_API_READING_REQUIRED');
  if(permission.enableFutures!==true)blockers.push('BINANCE_API_FUTURES_REQUIRED');
  const forbidden=[
    ['enableWithdrawals','BINANCE_API_WITHDRAWALS_MUST_BE_DISABLED'],
    ['enableInternalTransfer','BINANCE_API_INTERNAL_TRANSFER_MUST_BE_DISABLED'],
    ['enableMargin','BINANCE_API_MARGIN_MUST_BE_DISABLED'],
    ['permitsUniversalTransfer','BINANCE_API_UNIVERSAL_TRANSFER_MUST_BE_DISABLED'],
    ['enableVanillaOptions','BINANCE_API_OPTIONS_MUST_BE_DISABLED'],
    ['enableFixApiTrade','BINANCE_API_FIX_TRADE_MUST_BE_DISABLED'],
    ['enableSpotAndMarginTrading','BINANCE_API_SPOT_MARGIN_TRADING_MUST_BE_DISABLED'],
    ['enablePortfolioMarginTrading','BINANCE_API_PORTFOLIO_MARGIN_MUST_BE_DISABLED'],
  ];
  for(const [field,code] of forbidden){
    if(permission[field]===true)blockers.push(code);
  }
  return blockers;
}

async function binancePermissionJson(url,init={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(url,{...init,cache:'no-store',signal:controller.signal});
    const text=await response.text();
    let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
    if(!response.ok||data?.code){
      const e=new Error('BINANCE_API_PERMISSION_CHECK_FAILED');
      e.code='BINANCE_API_PERMISSION_CHECK_FAILED';
      e.status=response.status;
      e.binanceCode=data?.code??null;
      throw e;
    }
    return data;
  }finally{
    clearTimeout(timer);
  }
}

export async function fetchBinanceTradingApiPermissions(apiKey,secret){
  if(!apiKey||!secret){
    const e=new Error('BINANCE_TRADING_CREDENTIALS_MISSING');
    e.code='BINANCE_TRADING_CREDENTIALS_MISSING';
    throw e;
  }
  const time=await binancePermissionJson(`${BINANCE_API_BASE}${BINANCE_API_TIME_PATH}`);
  const serverTime=Number(time?.serverTime);
  if(!Number.isFinite(serverTime)){
    const e=new Error('BINANCE_API_PERMISSION_CHECK_FAILED');
    e.code='BINANCE_API_PERMISSION_CHECK_FAILED';
    throw e;
  }
  const query=new URLSearchParams({
    timestamp:String(serverTime),
    recvWindow:String(BINANCE_PERMISSION_RECV_WINDOW),
  });
  const signature=crypto.createHmac('sha256',secret).update(query.toString()).digest('hex');
  query.set('signature',signature);
  return binancePermissionJson(`${BINANCE_API_BASE}${BINANCE_API_RESTRICTIONS_PATH}?${query.toString()}`,{
    method:'GET',
    headers:{'X-MBX-APIKEY':apiKey},
  });
}

export async function revalidateBinanceTradingApiPermissions(apiKey,secret){
  let permission;
  try{
    permission=await fetchBinanceTradingApiPermissions(apiKey,secret);
  }catch(error){
    return {
      ok:false,
      code:'BINANCE_API_PERMISSION_REVALIDATION_FAILED',
      blockers:[],
      errorCode:String(error?.code||'BINANCE_API_PERMISSION_CHECK_FAILED'),
    };
  }
  const blockers=binanceApiPermissionBlockers(permission);
  return blockers.length
    ?{ok:false,code:'BINANCE_API_PERMISSION_REVALIDATION_BLOCKED',blockers}
    :{ok:true,code:'',blockers:[]};
}
