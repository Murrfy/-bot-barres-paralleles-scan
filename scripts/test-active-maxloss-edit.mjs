import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
function block(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a, start+' block missing');
  return html.slice(a,b);
}

test('active real max-loss is editable but margin and leverage remain locked',()=>{
  const locks=block('function setTokenFieldsEnabled()','function updateTokenPreview()');
  assert.match(locks,/const maxLossPending=realActive&&realProtectiveUpdatePending\.has/);
  assert.match(locks,/\$\('tMaxLoss'\)\.disabled=!realActive\|\|maxLossPending/);
  assert.match(locks,/\$\('fMargin'\)\.disabled=true;\$\('fLev'\)\.disabled=true/);
  assert.match(locks,/protections et perte MAX modifiables/);
});

test('active real max-loss stays bounded by hard cap and configured margin',()=>{
  const save=block('async function saveRealActiveTokenSettings','async function saveToken()');
  assert.match(save,/requestedMaxLoss>=2&&requestedMaxLoss<=400/);
  assert.match(save,/requestedMaxLoss>configuredMargin/);
  assert.match(save,/maxLossUsd:requestedMaxLoss/);
  assert.match(save,/wantedMaxLoss=n\(levels\.maxLossTriggerPrice,0\)/);
});

test('dollar max-loss is not committed before Binance confirms the exact replacement trigger',()=>{
  const reconcile=block('function reconcileRealProtectiveUpdatePending()','async function queueRealProtectiveUpdate');
  assert.match(reconcile,/if\(binanceAccount\.connected!==true\)return/);
  const matched=reconcile.indexOf("if(Number.isFinite(wanted)&&realNumberMatches(current,wanted))");
  const commit=reconcile.indexOf("tokenSettings[symbol]={...old,maxLoss:confirmedLoss");
  assert.ok(matched>=0&&commit>matched,'max-loss setting must commit only after exact Binance trigger match');
  assert.match(reconcile,/syncControllerCloudStateNow\(\)\.then/);
  assert.match(reconcile,/nouvelle perte MAX non confirmée sur Binance — ancien réglage conservé/);
});

test('pending active max-loss displays the requested dollar amount and locks repeat edits',()=>{
  const fill=block('function fillToken()','async function saveFutures()');
  assert.match(fill,/pendingMaxLoss=realActive\?realProtectiveUpdatePending\.get/);
  assert.match(fill,/pendingMaxLoss\?\.maxLossUsd/);
  const locks=block('function setTokenFieldsEnabled()','function updateTokenPreview()');
  assert.match(locks,/maxLossPending/);
});

test('MAX-LOSS replacement remains new-before-old in the real worker',()=>{
  const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  const start=worker.indexOf('async function runProtectiveUpdate');
  const end=worker.indexOf('async function waitForFullCloseState',start);
  assert.ok(start>=0&&end>start);
  const fn=worker.slice(start,end);
  assert.match(fn,/if\(maxLoss\|\|progressive\)/);
  const place=fn.indexOf('newClientId=await placeNew({deferReconcile:maxLoss})');
  const cancel=fn.indexOf('await cancelOld(newClientId)');
  assert.ok(place>=0&&cancel>place,'new MAX-LOSS must be confirmed before old MAX-LOSS cancellation');
});
