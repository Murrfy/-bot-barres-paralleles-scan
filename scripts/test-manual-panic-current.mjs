import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const ui=fs.readFileSync('index.html','utf8');

function block(source,startNeedle,endNeedle){
  const start=source.indexOf(startNeedle);
  assert.ok(start>=0,'missing '+startNeedle);
  const end=source.indexOf(endNeedle,start+startNeedle.length);
  assert.ok(end>start,'missing end '+endNeedle);
  return source.slice(start,end);
}

test('24/7 engine cannot trigger manual PANIC by itself',()=>{
  assert.equal(worker.includes("syncApi('emergency-stop'"),false);
  assert.equal(worker.includes('/api/zenith-sync?action=emergency-stop'),false);
  assert.equal(worker.includes('assertEmergencyStop'),false);
  assert.equal(worker.includes('PANIC'),false);
});

test('technical protection and MAX-LOSS repair failures fail closed without closing the position',()=>{
  const autoProtection=block(worker,'async function failClosedAutoProtection','async function failClosedAutoTarget');
  assert.match(autoProtection,/invalidateStream/);
  assert.doesNotMatch(autoProtection,/EXEC_CLOSE_POSITION|callProtectiveExecute|runFullClose|emergency-stop/);

  const repair=block(worker,'async function markMaxLossRepairFailure','async function waitForWriteAheadEntryEvidence');
  assert.match(repair,/invalidateStream/);
  assert.doesNotMatch(repair,/EXEC_CLOSE_POSITION|callProtectiveExecute|runFullClose|emergency-stop/);
});

test('ordinary full-position close remains reachable only from an explicit queued close command',()=>{
  const calls=[...worker.matchAll(/runFullClose\(/g)].map(match=>match.index);
  assert.equal(calls.length,2); // function definition + explicit queued command dispatch
  assert.match(worker,/if\(dispatch\.type==='EXEC_CLOSE_POSITION'\)ok=await runFullClose\(command,raw\)/);
});

test('triggered MAX-LOSS remainder recovery remains an allowed automatic safety close',()=>{
  const recovery=block(worker,'async function recoverTriggeredMaxLossRemainder','async function reconcile');
  assert.match(recovery,/type:'EXEC_CLOSE_POSITION'/);
  assert.match(recovery,/recoveryReason:'TRIGGERED_MAX_LOSS_REMAINDER'/);
  assert.match(recovery,/exitMode:'REMAINDER_MARKET'/);
  assert.doesNotMatch(recovery,/emergency-stop|PANIC|runFullClose\(/);
});

test('manual PANIC blocks new entries and drains existing close/protection work',()=>{
  assert.match(sync,/if \(action === 'emergency-stop' && req\.method === 'POST'\)/);
  assert.match(sync,/PANIC blocks new entries immediately but keeps close\/protection work available/);
  assert.match(sync,/await setMasterMode\('PAUSE_PENDING'\)/);
});

test('manual real-position close requires the iPhone controller and explicit confirmation',()=>{
  const close=block(ui,'async function queueRealPositionClose','async function queueRealEntryCancel');
  assert.match(close,/controllerIdentity\.paired&&controllerIdentity\.role==='controller'/);
  assert.match(close,/ARGENT RÉEL — Confirmer la fermeture de/);
  assert.match(close,/buildControllerRealCloseCommand/);
  assert.match(close,/sortie LIMIT IOC reduce-only/);
});
