import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api=fs.readFileSync('api/binance-entry-execute.js','utf8');

function block(startText,endText){
  const start=api.indexOf(startText);
  const end=api.indexOf(endText,start+startText.length);
  assert.ok(start>=0,`missing start: ${startText}`);
  assert.ok(end>start,`missing end: ${endText}`);
  return api.slice(start,end);
}

test('real entry slots use one atomic Redis reservation set',()=>{
  assert.match(api,/KEY_ENTRY_SLOT_RESERVATIONS=.*entry-slot-reservations/);
  assert.match(api,/ENTRY_SLOT_RESERVATION_TTL_MS=30\*1000/);
  const reserve=block('async function reserveEntrySlot','async function releaseEntrySlotReservation');
  assert.match(reserve,/ZREMRANGEBYSCORE/);
  assert.match(reserve,/ZSCORE/);
  assert.match(reserve,/ZRANGE/);
  assert.match(reserve,/ZCARD/);
  assert.match(reserve,/ZADD/);
  assert.match(reserve,/occupied \+ reservations >= maxActive/);
  assert.match(reserve,/SYMBOL_ENTRY_SLOT_ALREADY_RESERVED/);
  assert.match(reserve,/MAX_ACTIVE_POSITIONS_REACHED/);
});

test('slot reservation is followed by a fresh Binance preflight before any entry write',()=>{
  const gate=block('async function reserveAndRecheckEntrySlot','async function finalEntryDispatchGate');
  const reserve=gate.indexOf('await reserveEntrySlot');
  const preflight=gate.indexOf('await runLiveEntryPreflight');
  assert.ok(reserve>=0&&preflight>reserve);
  assert.match(gate,/releaseEntrySlotReservation\(commandId,symbol\)/);
  assert.match(gate,/fresh\?\.evaluation\?\.ready!==true/);
});

test('MARKET entry reserves and rechecks before the Binance order POST',()=>{
  const market=block('if(marketEntry){',"if(phase==='PREPARE_PROTECTION')");
  const reserve=market.indexOf('reserveAndRecheckEntrySlot');
  const finalGate=market.indexOf('finalEntryDispatchGate',reserve);
  const post=market.indexOf('placeStandardOrderIdempotent',reserve);
  assert.ok(reserve>=0&&finalGate>reserve&&post>finalGate);
  assert.match(market,/orderType:'MARKET'/);
  assert.match(market,/ENTRY_SLOT_RESERVATION_BLOCKED/);
});

test('LIMIT protection preparation reserves a slot before creating the prepared MAX-LOSS',()=>{
  const prepare=block("if(phase==='PREPARE_PROTECTION')",'const rawTransition=await readEntryTransition');
  const reserve=prepare.indexOf('reserveAndRecheckEntrySlot');
  const finalGate=prepare.indexOf('finalEntryDispatchGate',reserve);
  const algoPost=prepare.indexOf('placeAlgoOrderIdempotent',reserve);
  assert.ok(reserve>=0&&finalGate>reserve&&algoPost>finalGate);
  assert.match(prepare,/orderType:'LIMIT'/);
});

test('LIMIT submit renews the same reservation before write-ahead and Binance POST',()=>{
  const submit=block('const rawTransition=await readEntryTransition','}catch(e){');
  const reserve=submit.indexOf('reserveAndRecheckEntrySlot');
  const finalGate=submit.indexOf('finalEntryDispatchGate',reserve);
  const writeAhead=submit.indexOf('writeEntryTransition(commandId,checkedSubmittedIntent.transition)',reserve);
  const post=submit.indexOf('placeStandardOrderIdempotent',reserve);
  assert.ok(reserve>=0&&finalGate>reserve&&writeAhead>finalGate&&post>writeAhead);
  assert.match(submit,/ENTRY_SLOT_RESERVATION_BLOCKED/);
});
