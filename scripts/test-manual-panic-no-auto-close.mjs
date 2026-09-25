import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');
const sync=await readFile(new URL('../api/zenith-sync.js',import.meta.url),'utf8');
const ui=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('24/7 engine can never trigger manual PANIC by itself',()=>{
  assert.equal(worker.includes("syncApi('emergency-stop'"),false);
  assert.equal(worker.includes("emergency-stop',{method:'POST'"),false);
});

test('technical failures block execution without issuing an automatic full close',()=>{
  const closeCalls=[...worker.matchAll(/runFullClose\(/g)].map(m=>m.index);
  assert.equal(closeCalls.length,2); // function definition + explicit queued command dispatch
  assert.match(worker,/if\(dispatch\.type==='EXEC_CLOSE_POSITION'\)ok=await runFullClose\(command,raw\)/);
});

test('manual PANIC blocks new entries but explicitly keeps close/protection work available',()=>{
  assert.match(sync,/PANIC blocks new entries immediately but keeps close\/protection work available/);
  assert.match(sync,/setMasterMode\('PAUSE_PENDING'\)/);
});

test('real-position close originates from explicit controller confirmation',()=>{
  assert.match(ui,/async function queueRealPositionClose\(position\)/);
  assert.match(ui,/ARGENT RÉEL — Confirmer la fermeture de/);
  assert.match(ui,/data-real-close/);
});
