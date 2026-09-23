import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const execute=fs.readFileSync('api/binance-protective-execute.js','utf8');
const update=fs.readFileSync('api/binance-protective-update-execute.js','utf8');

function gateInvariant(source,label,expectedCalls){
  assert.ok(source.includes("return {...device,roleIssuedAt:String(issuedAt||'0')}"),label+' must retain authenticated MASTER role epoch');
  assert.ok(source.includes('async function finalProtectiveMasterGate(master)'),label+' final gate missing');
  assert.ok(source.includes("if lease ~= ARGV[1] or registered ~= ARGV[1] then return -1 end"),label+' lease fence missing');
  assert.ok(source.includes("if roleEpoch ~= ARGV[2] then return -2 end"),label+' role epoch fence missing');
  assert.ok(source.includes("if mode == 'PAUSED' then return -3 end"),label+' PAUSED fence missing');
  assert.ok(source.includes("'PROTECTIVE_FINAL_GATE_UNAVAILABLE'"),label+' must fail closed if final gate backend is unavailable');
  const helperStart=source.indexOf('async function finalProtectiveMasterGate(master)');
  const helperEnd=source.indexOf('async function requireFinalProtectiveMaster',helperStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart,label+' final gate helper range missing');
  const helper=source.slice(helperStart,helperEnd);
  assert.equal(/EMERGENCY_STOP|panic/i.test(helper),false,label+' final gate must not disable protective writes merely because PANIC is active');
  assert.equal((source.match(/await requireFinalProtectiveMaster\(res,master\)/g)||[]).length,expectedCalls,label+' unexpected final gate call count');
}

test('protective close and entry-cancel writes revalidate current MASTER immediately before Binance',()=>{
  gateInvariant(execute,'protective execute',2);
  for(const writer of ['cancelEntryOrderIdempotent({','placeStandardOrderIdempotent({']){
    const at=execute.indexOf(writer);
    assert.ok(at>=0,writer+' missing');
    const before=execute.slice(Math.max(0,at-300),at);
    assert.ok(before.includes('await requireFinalProtectiveMaster(res,master)'),writer+' must be preceded by final MASTER gate');
  }
});

test('every protective update mutation revalidates current MASTER immediately before Binance',()=>{
  gateInvariant(update,'protective update',6);
  const writers=[
    'cancelReduceOnlyOrderIdempotent({',
    'cancelAlgoOrderIdempotent({',
    'placeStandardOrderIdempotent({',
    'placeAlgoOrderIdempotent({',
  ];
  let total=0;
  for(const writer of writers){
    let from=0;
    while(true){
      const at=update.indexOf(writer,from);
      if(at<0)break;
      total++;
      const before=update.slice(Math.max(0,at-300),at);
      assert.ok(before.includes('await requireFinalProtectiveMaster(res,master)'),writer+' mutation must be preceded by final MASTER gate');
      from=at+writer.length;
    }
  }
  assert.equal(total,6,'protective update writer count changed; review final MASTER gating');
});
