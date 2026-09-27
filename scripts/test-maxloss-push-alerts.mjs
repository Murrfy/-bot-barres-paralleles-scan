import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  maxLossAlertSymbolsFromReport,
  evaluateMaxLossAlertTransitions,
  createVapidRecord,
  validVapidRecord,
  pushEndpointAllowed,
  vapidAuthorizationForEndpoint,
} from '../api/zenith-sync.js';

test('only MAX-LOSS differences become persistent-red alert symbols',()=>{
  const symbols=maxLossAlertSymbolsFromReport({
    reasons:['OTHER_RUNTIME_REASON'],
    differences:{
      missingMaxLossProtections:['BTCUSDT:LONG'],
      ambiguousMaxLossProtections:['ETHUSDT:LONG'],
      configuredMaxLossUnavailable:['SOLUSDT:LONG'],
      unsafeMaxLossProtections:[{symbol:'XRPUSDT'}],
      untrackedPositions:[{symbol:'MANUALUSDT'}],
      missingOrders:[{symbol:'OTHERUSDT'}],
    },
  });
  assert.deepEqual(symbols,['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']);
});

test('red alert waits 60 seconds, sends once, and recovers only after a sent alert',()=>{
  const t0=1_000_000;
  let r=evaluateMaxLossAlertTransitions({currentSymbols:['BTCUSDT'],storedStates:{},now:t0});
  assert.deepEqual(r.duePersistent,[]);
  assert.equal(r.nextStates.BTCUSDT.since,t0);

  r=evaluateMaxLossAlertTransitions({
    currentSymbols:['BTCUSDT'],storedStates:r.nextStates,now:t0+59_999
  });
  assert.deepEqual(r.duePersistent,[]);

  r=evaluateMaxLossAlertTransitions({
    currentSymbols:['BTCUSDT'],storedStates:r.nextStates,now:t0+60_000
  });
  assert.deepEqual(r.duePersistent,['BTCUSDT']);

  const notified={BTCUSDT:{...r.nextStates.BTCUSDT,notifiedAt:t0+60_000}};
  r=evaluateMaxLossAlertTransitions({
    currentSymbols:['BTCUSDT'],storedStates:notified,now:t0+120_000
  });
  assert.deepEqual(r.duePersistent,[]);

  r=evaluateMaxLossAlertTransitions({
    currentSymbols:[],storedStates:notified,now:t0+121_000
  });
  assert.deepEqual(r.recovered,['BTCUSDT']);

  const neverNotified={BTCUSDT:{since:t0,notifiedAt:0}};
  r=evaluateMaxLossAlertTransitions({
    currentSymbols:[],storedStates:neverNotified,now:t0+30_000
  });
  assert.deepEqual(r.recovered,[]);
});

test('VAPID uses a P-256 key and only Apple HTTPS push endpoints',()=>{
  const record=createVapidRecord(1_000);
  assert.equal(validVapidRecord(record),true);
  assert.equal(pushEndpointAllowed('https://web.push.apple.com/Q123'),true);
  assert.equal(pushEndpointAllowed('https://example.com/push'),false);
  assert.equal(pushEndpointAllowed('http://web.push.apple.com/Q123'),false);

  const signed=vapidAuthorizationForEndpoint('https://web.push.apple.com/Q123',record,10_000);
  assert.match(signed.authorization,/^vapid t=[A-Za-z0-9_.-]+, k=[A-Za-z0-9_-]+$/);
  assert.equal(signed.publicKey,record.publicKey);
  const parts=signed.token.split('.');
  assert.equal(parts.length,3);
  const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  assert.equal(claims.aud,'https://web.push.apple.com');
  assert.equal(claims.sub,'https://zenithfinal3-ahle.vercel.app');
});

test('push delivery is isolated from trading and service worker always shows a notification',()=>{
  const sync=fs.readFileSync('api/zenith-sync.js','utf8');
  const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  const sw=fs.readFileSync('sw.js','utf8');
  const notifications=fs.readFileSync('notifications.js','utf8');
  const manifest=JSON.parse(fs.readFileSync('manifest.webmanifest','utf8'));
  const vercel=fs.readFileSync('vercel.json','utf8');
  const admin=fs.readFileSync('master-admin.html','utf8');

  const start=sync.indexOf("if (action === 'engine-maxloss-alert-sync'");
  const end=sync.indexOf("if (action === 'engine-reenable'",start);
  assert.ok(start>=0&&end>start);
  const alertBlock=sync.slice(start,end);
  assert.match(alertBlock,/device\.principal !== 'engine'/);
  assert.match(alertBlock,/hasMasterLease\(device\.deviceId\)/);
  assert.doesNotMatch(alertBlock,/EXEC_|BINANCE_|command-|emergency-stop|master-pause|master-resume/);

  const reconcileStart=worker.indexOf('async function reconcile');
  const reconcileEnd=worker.indexOf('async function awaitReconciliation',reconcileStart);
  const reconcile=worker.slice(reconcileStart,reconcileEnd);
  assert.match(reconcile,/void syncPersistentMaxLossAlerts\(data\.report\)/);
  const helperStart=worker.indexOf('async function syncPersistentMaxLossAlerts');
  const helperEnd=worker.indexOf('function runtimeSnapshot',helperStart);
  const helper=worker.slice(helperStart,helperEnd);
  assert.match(helper,/catch\(error\)/);
  assert.doesNotMatch(helper,/throw error|invalidateStream|EXEC_/);

  assert.match(sw,/addEventListener\('push'/);
  assert.match(sw,/showNotification/);
  assert.match(sw,/zenith-maxloss-fallback/);
  assert.match(notifications,/Notification\.requestPermission\(\)/);
  assert.match(notifications,/pushManager\.subscribe/);
  assert.equal(manifest.display,'standalone');
  assert.equal(manifest.start_url,'/');
  assert.match(vercel,/worker-src 'self'/);
  assert.doesNotMatch(vercel,/worker-src 'none'/);
  assert.match(admin,/id="maxLossNotificationsBtn"/);
  assert.match(admin,/src="\/notifications\.js"/);
});
