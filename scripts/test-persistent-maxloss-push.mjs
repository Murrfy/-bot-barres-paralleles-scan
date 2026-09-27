import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api=fs.readFileSync('api/zenith-push.js','utf8');
const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const html=fs.readFileSync('index.html','utf8');
const ui=fs.readFileSync('zenith-notifications.js','utf8');
const sw=fs.readFileSync('zenith-sw.js','utf8');
const manifest=JSON.parse(fs.readFileSync('manifest.webmanifest','utf8'));
const vercel=JSON.parse(fs.readFileSync('vercel.json','utf8'));

function block(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,'missing block '+start);
  return source.slice(a,b);
}

test('persistent MAX-LOSS push threshold is exactly 60 seconds and state is server-persistent',()=>{
  assert.match(api,/const MAXLOSS_PERSIST_MS=60\*1000/);
  assert.match(api,/KEY_MAXLOSS_ALERTS/);
  assert.match(api,/redSince/);
  assert.match(api,/notifiedAt/);
  assert.match(api,/now-redSince<MAXLOSS_PERSIST_MS/);
  assert.match(api,/HSET.*KEY_MAXLOSS_ALERTS/s);
  assert.match(api,/HDEL.*KEY_MAXLOSS_ALERTS/s);
});

test('push subscription is bound to current controller and Apple endpoints only',()=>{
  assert.match(api,/KEY_CONTROLLER_DEVICE/);
  assert.match(api,/subscriptionsForDevice\(device\.deviceId\)/);
  assert.match(api,/String\(record\.deviceId\|\|''\)!==owner/);
  assert.match(api,/host==='push\.apple\.com'\|\|host\.endsWith\('\.push\.apple\.com'\)/);
  assert.match(api,/CONTROLLER_REQUIRED/);
});

test('MAX-LOSS state updates are engine-only and notification failures never enter trading gates',()=>{
  assert.match(api,/action==='maxloss-sync'/);
  assert.match(api,/String\(device\.principal\|\|''\)!=='engine'/);
  const sync=block(worker,'async function syncPersistentMaxLossPushAlerts','async function refreshRealHistoryArchive');
  assert.match(sync,/pushApi\('maxloss-sync'/);
  assert.match(sync,/log\('MAX_LOSS_PUSH_SYNC_FAILED'/);
  assert.match(sync,/logError\('MAX_LOSS_PUSH_SYNC_FAILED'/);
  for(const forbidden of [
    'runtime.error=','invalidateStream(','EXEC_CLOSE_POSITION','EXEC_UPDATE_PROTECTION',
    'emergency-stop','commandDisposition(','callProtectiveUpdateExecute(','callProtectiveExecute('
  ])assert.equal(sync.includes(forbidden),false,forbidden);
  const reconcile=block(worker,'async function reconcile','async function awaitReconciliation');
  assert.match(reconcile,/stream\.symbolQuarantines=maxLossSymbolQuarantines\(data\.report\);\s*void syncPersistentMaxLossPushAlerts\(\);/);
});

test('iPhone permission request is user-gesture driven and no automatic permission prompt exists',()=>{
  assert.ok(html.includes('id="pushAlertBtn"'));
  assert.ok(html.includes('src="/zenith-notifications.js"'));
  assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
  assert.match(ui,/button\(\).*addEventListener\('click',toggle\)/s);
  const toggle=block(ui,'async function toggle()','function init()');
  assert.match(toggle,/Notification\.requestPermission\(\)/);
  const refresh=block(ui,'async function refresh()','async function toggle()');
  assert.equal(refresh.includes('Notification.requestPermission'),false);
  assert.match(ui,/navigator\.serviceWorker\.register\('\/zenith-sw\.js'/);
});

test('service worker always displays received push and notification opens Zenith',()=>{
  assert.match(sw,/addEventListener\('push'/);
  assert.match(sw,/showNotification\(title,options\)/);
  assert.match(sw,/addEventListener\('notificationclick'/);
  assert.match(sw,/clients\.openWindow/);
});

test('manifest is standalone and CSP allows only same-origin workers',()=>{
  assert.equal(manifest.display,'standalone');
  assert.equal(manifest.start_url,'/');
  const csp=vercel.headers.flatMap(row=>row.headers||[]).find(h=>h.key==='Content-Security-Policy')?.value||'';
  assert.match(csp,/worker-src 'self'/);
  assert.equal(csp.includes("worker-src 'none'"),false);
  assert.equal(vercel.functions['api/zenith-push.js']?.maxDuration,30);
});
