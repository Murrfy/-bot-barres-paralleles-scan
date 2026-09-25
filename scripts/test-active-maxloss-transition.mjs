import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const reconcile=fs.readFileSync('api/binance-reconcile.js','utf8');
const execute=fs.readFileSync('api/binance-protective-update-execute.js','utf8');
const command=fs.readFileSync('lib/controller-real-command.mjs','utf8');
const protective=fs.readFileSync('lib/protective-command.mjs','utf8');

function block(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start+' block missing');
  return source.slice(a,b);
}

test('active MAX-LOSS command carries the requested dollar cap explicitly',()=>{
  const fn=block(command,'export function buildControllerUpdateProtectionCommand','}');
  assert.match(command,/maxLossUsd = NaN/);
  assert.match(command,/MAX_LOSS_USD_INVALID/);
  assert.match(command,/maxLossUsd: requestedMaxLoss/);
  assert.match(protective,/protectionKind==='MAX_LOSS'&&Number\.isFinite\(maxLossUsd\)\?\{maxLossUsd\}:\{\}/);
});

test('pending MAX-LOSS reconciliation authorization is tightly fenced',()=>{
  const fn=block(reconcile,'function authorizedPendingMaxLossEdit','function enforceConfiguredMaxLossSafety');
  assert.match(fn,/EXEC_UPDATE_PROTECTION/);
  assert.match(fn,/claimedBy/);
  assert.match(fn,/controllerDeviceId/);
  assert.match(fn,/expiresAt > now/);
  assert.match(fn,/requestedMaxLossUsd >= 2/);
  assert.match(fn,/requestedMaxLossUsd <= REAL_RISK_LIMITS\.maxLossUsd/);
  assert.match(fn,/configuredMarginUsd\(controllerState, symbol\)/);
  assert.match(fn,/requestedMaxLossUsd > configuredMargin \+ 1e-8/);
  assert.match(fn,/matchingNew/);
  assert.match(fn,/STOP_MARKET/);
  assert.match(fn,/closePosition === true/);
});

test('Binance execution independently enforces requested MAX-LOSS and configured margin',()=>{
  const fn=block(execute,"if(type==='EXEC_UPDATE_PROTECTION'&&update.protectionKind==='MAX_LOSS')","const emergency=");
  assert.match(fn,/requestedMaxLoss=n\(update\.maxLossUsd,NaN\)/);
  assert.match(fn,/allowedMaxLoss=activeEdit\?requestedMaxLoss:configuredMaxLoss/);
  assert.match(fn,/configuredMarginUsd\(state\.controllerState,update\.symbol\)/);
  assert.match(fn,/MAX_LOSS_EXCEEDS_CONFIGURED_MARGIN/);
  assert.match(fn,/Math\.min\(allowedMaxLoss,REAL_RISK_LIMITS\.maxLossUsd\)/);
});
