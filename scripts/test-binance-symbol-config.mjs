import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceRequestError } from '../lib/binance-order-writer.mjs';
import { ensureBinanceEntrySymbolConfig, entrySymbolConfigMatches } from '../lib/binance-symbol-config.mjs';

function fakeRequest(sequence,calls){
  return async args=>{
    calls.push({path:args.path,method:args.method,params:args.params});
    const next=sequence.shift();
    if(next instanceof Error)throw next;
    return next;
  };
}

test('already matching ISOLATED leverage performs no Binance write',async()=>{
  const calls=[];
  const out=await ensureBinanceEntrySymbolConfig({
    apiKey:'k',secret:'s',symbol:'BTCUSDT',leverage:7,timestamp:1000,
    requestImpl:fakeRequest([[{symbol:'BTCUSDT',marginType:'ISOLATED',leverage:7}]],calls),
  });
  assert.equal(out.writeAttempted,false);
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'GET');
});

test('cross margin and wrong leverage are changed then re-read from Binance',async()=>{
  const calls=[];
  const out=await ensureBinanceEntrySymbolConfig({
    apiKey:'k',secret:'s',symbol:'IBMUSDT',leverage:5,timestamp:1000,
    requestImpl:fakeRequest([
      [{symbol:'IBMUSDT',marginType:'CROSSED',leverage:10}],
      {code:200,msg:'success'},
      [{symbol:'IBMUSDT',marginType:'ISOLATED',leverage:10}],
      {symbol:'IBMUSDT',leverage:5,maxNotionalValue:'100000'},
      [{symbol:'IBMUSDT',marginType:'ISOLATED',leverage:5}],
    ],calls),
  });
  assert.equal(out.marginTypeChanged,true);
  assert.equal(out.leverageChanged,true);
  assert.equal(entrySymbolConfigMatches({symbol:'IBMUSDT',marginType:'ISOLATED',leverage:5},{symbol:'IBMUSDT',leverage:5}),true);
  assert.deepEqual(calls.map(x=>x.path),[
    '/fapi/v1/symbolConfig','/fapi/v1/marginType','/fapi/v1/symbolConfig','/fapi/v1/leverage','/fapi/v1/symbolConfig'
  ]);
});

test('ambiguous leverage response is accepted only after Binance re-read confirms it',async()=>{
  const calls=[];
  const ambiguous=new BinanceRequestError('timeout',{ambiguous:true});
  const out=await ensureBinanceEntrySymbolConfig({
    apiKey:'k',secret:'s',symbol:'ETHUSDT',leverage:4,timestamp:1000,
    requestImpl:fakeRequest([
      [{symbol:'ETHUSDT',marginType:'ISOLATED',leverage:10}],
      ambiguous,
      [{symbol:'ETHUSDT',marginType:'ISOLATED',leverage:4}],
    ],calls),
  });
  assert.equal(out.recoveredAfterAmbiguous,true);
  assert.equal(out.leverageChanged,true);
});

test('ambiguous leverage response fails closed when Binance does not confirm the setting',async()=>{
  const ambiguous=new BinanceRequestError('timeout',{ambiguous:true});
  await assert.rejects(
    ensureBinanceEntrySymbolConfig({
      apiKey:'k',secret:'s',symbol:'ETHUSDT',leverage:4,timestamp:1000,
      requestImpl:fakeRequest([
        [{symbol:'ETHUSDT',marginType:'ISOLATED',leverage:10}],
        ambiguous,
        [{symbol:'ETHUSDT',marginType:'ISOLATED',leverage:10}],
      ],[]),
    }),
    e=>e?.code==='BINANCE_LEVERAGE_RESULT_AMBIGUOUS'&&e?.writeAttempted===true&&e?.ambiguous===true
  );
});

test('Zenith hard cap prevents symbol-config leverage above 10x',async()=>{
  await assert.rejects(
    ensureBinanceEntrySymbolConfig({apiKey:'k',secret:'s',symbol:'BTCUSDT',leverage:11,requestImpl:async()=>{throw new Error('must not call')}}),
    /BINANCE_SYMBOL_CONFIG_REQUEST_INVALID/
  );
});
