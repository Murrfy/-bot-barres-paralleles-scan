import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPreparedEntryBundle } from '../lib/entry-bundle.mjs';
import { bundleMatchesTransition } from '../api/binance-entry-prepare.js';

const source=await readFile(new URL('../api/binance-entry-prepare.js',import.meta.url),'utf8');

test('entry prepare is engine-MASTER-only and retains all real-write locks',()=>{
  assert.match(source,/requireEngineMaster\(req\)/);
  assert.match(source,/device\.role!=='master'/);
  assert.match(source,/principal\|\|'\'\)!=='engine'/);
  assert.match(source,/enginePrincipalInstanceActive/);
  assert.match(source,/REAL_TRADING_ENABLED&&BINANCE_WRITE_ENABLED&&PAIRING_DISABLED&&/);
  assert.match(source,/REAL_ENTRY_WRITE_ENABLED&&VERCEL_PRODUCTION_WRITE_ALLOWED/);
  assert.match(source,/sameOriginMutation\(req\)/);
});

test('entry prepare atomically fences role, lease, RUNNING, PANIC, arm, revision and engine instance',()=>{
  for(const expected of [
    "registered ~= ARGV[1]",
    "lease ~= ARGV[1]",
    "mode ~= 'RUNNING'",
    "panic ~= '0'",
    "arm ~= ARGV[3]",
    "roleEpoch ~= ARGV[2]",
    "revision ~= ARGV[4]",
    "instance ~= ARGV[5]",
    "HLEN",
    "MAX_ENTRY_TRANSITIONS",
  ]) assert.ok(source.includes(expected),expected);
});

test('MAX-LOSS transition is committed before Binance protection write and non-ambiguous failures roll it back',()=>{
  const commit=source.indexOf('const committed=await commitPreparedTransition({');
  const write=source.indexOf('const result=await placeAlgoOrderIdempotent({');
  const rollback=source.indexOf('rollbackPreparedTransition(symbol,transitionRaw)');
  assert.ok(commit>=0);
  assert.ok(write>commit);
  assert.ok(rollback>write);
  assert.match(source,/ENTRY_LIMIT_NOT_RESTING/);
  assert.match(source,/fetchBinanceTradingApiPermissions/);
  assert.match(source,/binanceApiPermissionBlockers/);
  assert.match(source,/runLiveEntryPreflight/);
});

test('stored transition identity must exactly match deterministic bundle before protection write',()=>{
  const now=1000000;
  const risk={ready:true,observedAt:now-100,normalized:{
    symbol:'BTCUSDT',margin:1000,leverage:10,maxLoss:400,referencePrice:50000,quantity:0.2,
    positionMode:'ONE_WAY',marginType:'ISOLATED',priceTickSize:0.1,minPrice:0.1,maxPrice:1000000,
  }};
  const bundle=buildPreparedEntryBundle({
    command:{id:'entry-prepare-12345678',symbol:'BTCUSDT',side:'BUY',orderType:'LIMIT',limitPrice:50000,margin:1000,leverage:10,maxLoss:400,targetProfit:40},
    riskSnapshot:risk,validatedAt:900000,controllerRevision:14,
    masterDeviceId:'zenith-server-engine-v1',masterRoleEpoch:'123',engineInstanceId:'engine-instance-test',now,
  });
  assert.equal(bundleMatchesTransition(bundle,bundle.transition),true);
  assert.equal(bundleMatchesTransition(bundle,{...bundle.transition,protectionTriggerPrice:47999}),false);
  assert.equal(bundleMatchesTransition(bundle,{...bundle.transition,controllerRevision:15}),false);
});
