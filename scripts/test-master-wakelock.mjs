import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('iPad MASTER requests a screen wake lock only while active and visible',()=>{
  assert.match(html,/function masterWakeLockWanted\(\)/);
  assert.match(html,/controllerIdentity\.role==='master'/);
  assert.match(html,/document\.visibilityState!=='visible'/);
  assert.match(html,/mode==='RUNNING'\|\|mode==='PAUSE_PENDING'/);
  assert.match(html,/navigator\.wakeLock\.request\('screen'\)/);
});

test('wake lock is feature-detected, released safely and visibly reported',()=>{
  assert.match(html,/if\(!\('wakeLock' in navigator\)\)/);
  assert.match(html,/async function releaseMasterWakeLock\(\)/);
  assert.match(html,/await sentinel\.release\(\)/);
  assert.match(html,/id="masterWakeBadge"/);
  assert.match(html,/ÉCRAN MASTER · ÉVEILLÉ/);
  assert.match(html,/ÉCRAN MASTER · VEILLE NON BLOQUÉE/);
});

test('MASTER reacquires wake lock when visible and keeps PAGE_HIDDEN fail-closed',()=>{
  assert.match(html,/visibilitychange/);
  assert.match(html,/syncMasterWakeLock\(true\);masterRuntimeCycle\(\)/);
  assert.match(html,/releaseMasterWakeLock\(\);invalidateMasterStream\('PAGE_HIDDEN'\)/);
  assert.match(html,/controllerIdentity\.role!=='master'\|\|document\.hidden/);
});

test('MASTER pause does not hold the screen awake',()=>{
  assert.match(html,/if\(!masterWakeLockWanted\(\)\)\{/);
  assert.match(html,/if\(masterWakeLock\.sentinel\)await releaseMasterWakeLock\(\)/);
  assert.match(html,/mode==='PAUSED'/);
  assert.match(html,/ÉCRAN MASTER · PAUSE/);
});
