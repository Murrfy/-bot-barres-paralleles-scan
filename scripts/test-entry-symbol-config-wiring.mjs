import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/binance-entry-execute.js','utf8');
const handlerStart=source.indexOf('export default async function handler(req,res)');
assert.ok(handlerStart>=0,'entry handler missing');
const handler=source.slice(handlerStart);

test('real entry imports the verified Binance symbol-config writer',()=>{
  assert.ok(source.includes("import { ensureBinanceEntrySymbolConfig } from '../lib/binance-symbol-config.mjs';"));
});

test('symbol config writes are limited to isolated/leverage mismatches only',()=>{
  assert.ok(handler.includes("const configOnlyReasons=new Set(['MARGIN_TYPE_NOT_ISOLATED','ACCOUNT_LEVERAGE_MISMATCH'])"));
  const rejectOther=handler.indexOf("if(preflight.evaluation.ready!==true&&nonConfigReasons.length)");
  const ensureConfig=handler.indexOf('const configResult=await ensureBinanceEntrySymbolConfig({');
  assert.ok(rejectOther>=0&&ensureConfig>rejectOther);
});

test('symbol config cannot write while real-entry writes are locked',()=>{
  const writePolicy=handler.indexOf('const writesEnabled=Boolean(');
  const configLock=handler.indexOf("reason:'BINANCE_SYMBOL_CONFIG_CHANGE_REQUIRED'");
  const ensureConfig=handler.indexOf('const configResult=await ensureBinanceEntrySymbolConfig({');
  assert.ok(writePolicy>=0&&configLock>writePolicy&&ensureConfig>configLock);
  assert.ok(handler.includes('REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&REAL_ENTRY_WRITE_ENABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED'));
});

test('Binance symbol config may be prepared first, but entry dispatch requires confirmed prepared MAX-LOSS',()=>{
  const ensureConfig=handler.indexOf('const configResult=await ensureBinanceEntrySymbolConfig({');
  const preparePhase=handler.indexOf("if(phase==='PREPARE_PROTECTION')");
  const exactProtection=handler.indexOf('.find(order=>transitionProtectionMatches(order,storedTransition))');
  const protectionBlocked=handler.indexOf("code:'ENTRY_PROTECTION_NOT_STREAM_CONFIRMED'",exactProtection);
  const entryOrder=handler.indexOf('const result=await placeStandardOrderIdempotent({',exactProtection);
  assert.ok(ensureConfig>=0&&preparePhase>ensureConfig);
  assert.ok(exactProtection>preparePhase&&protectionBlocked>exactProtection&&entryOrder>protectionBlocked);
});

test('entry reruns live preflight after Binance confirms symbol config',()=>{
  const ensureConfig=handler.indexOf('const configResult=await ensureBinanceEntrySymbolConfig({');
  const secondPreflight=handler.indexOf('preflight=await runLiveEntryPreflight({',ensureConfig);
  const rejectAfter=handler.indexOf("'ENTRY_PREFLIGHT_REJECTED_AFTER_CONFIG'",secondPreflight);
  const plan=handler.indexOf('plan=buildEntryOrderPlan({',secondPreflight);
  assert.ok(ensureConfig>=0&&secondPreflight>ensureConfig&&rejectAfter>secondPreflight&&plan>rejectAfter);
});

test('final dispatch gate still precedes the actual Binance entry order',()=>{
  const gate=handler.indexOf('const dispatchGate=await finalEntryDispatchGate(');
  const order=handler.indexOf('const result=await placeStandardOrderIdempotent({');
  assert.ok(gate>=0&&order>gate);
});
