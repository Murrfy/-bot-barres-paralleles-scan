import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { revalidateBinanceTradingApiPermissions } from '../lib/binance-api-permissions.mjs';

function safe(overrides={}){
  return {
    ipRestrict:true,enableReading:true,enableWithdrawals:false,enableInternalTransfer:false,
    enableMargin:false,enableFutures:true,permitsUniversalTransfer:false,
    enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,
    enablePortfolioMarginTrading:false,...overrides,
  };
}

test('shared Binance permission revalidation fails closed on dangerous permissions',async()=>{
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async(url)=>{
    calls++;
    const u=new URL(url);
    if(u.pathname==='/api/v3/time')return new Response(JSON.stringify({serverTime:Date.now()}));
    if(u.pathname==='/sapi/v1/account/apiRestrictions'){
      return new Response(JSON.stringify(safe({enableWithdrawals:true})));
    }
    throw new Error('unexpected '+url);
  };
  try{
    const r=await revalidateBinanceTradingApiPermissions('api-key','secret');
    assert.equal(r.ok,false);
    assert.equal(r.code,'BINANCE_API_PERMISSION_REVALIDATION_BLOCKED');
    assert.ok(r.blockers.includes('BINANCE_API_WITHDRAWALS_MUST_BE_DISABLED'));
    assert.equal(calls,2);
  }finally{globalThis.fetch=original}
});

test('shared Binance permission revalidation fails closed when Binance cannot be queried',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({code:-1000,msg:'failed'}),{status:503});
  try{
    const r=await revalidateBinanceTradingApiPermissions('api-key','secret');
    assert.equal(r.ok,false);
    assert.equal(r.code,'BINANCE_API_PERMISSION_REVALIDATION_FAILED');
  }finally{globalThis.fetch=original}
});

test('every real matching-engine write API revalidates permissions before write paths',()=>{
  const files=[
    'api/binance-entry-execute.js',
    'api/binance-protective-execute.js',
    'api/binance-protective-update-execute.js',
  ];
  for(const file of files){
    const src=fs.readFileSync(file,'utf8');
    assert.match(src,/revalidateBinanceTradingApiPermissions/);
    const check=src.indexOf('await revalidateBinanceTradingApiPermissions(apiKey,secret)');
    assert.ok(check>=0,file+' missing permission check');

    const writeNeedles=file.includes('entry-execute')
      ?['placeStandardOrderIdempotent({','placeAlgoOrderIdempotent({','ensureBinanceEntrySymbolConfig({']
      :file.includes('protective-update')
        ?['placeStandardOrderIdempotent({','placeAlgoOrderIdempotent({','cancelReduceOnlyOrderIdempotent({','cancelAlgoOrderIdempotent({']
        :['placeStandardOrderIdempotent({','cancelEntryOrderIdempotent({'];
    for(const needle of writeNeedles){
      let pos=src.indexOf(needle);
      assert.ok(pos>=0,file+' missing '+needle);
      while(pos>=0){
        assert.ok(pos>check,file+' can write before permission revalidation: '+needle);
        pos=src.indexOf(needle,pos+needle.length);
      }
    }
  }
});
