import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function filesUnder(root){
  const out=[];
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    const full=path.join(root,entry.name);
    if(entry.isDirectory())out.push(...filesUnder(full));
    else if(/\.(?:js|mjs)$/.test(entry.name))out.push(full.replaceAll('\\','/'));
  }
  return out;
}

test('PANIC is manual-only: backend modules never invoke emergency-stop',()=>{
  const files=[...filesUnder('server'),...filesUnder('lib'),...filesUnder('api')];
  const offenders=[];
  for(const file of files){
    if(file==='api/zenith-sync.js')continue;
    const source=fs.readFileSync(file,'utf8');
    if(source.includes('emergency-stop'))offenders.push(file);
  }
  assert.deepEqual(offenders,[]);
});

test('MAX-LOSS repair never force-closes an active position',()=>{
  const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
  const start=worker.indexOf('async function repairMissingMaxLoss');
  const end=worker.indexOf('async function reconcile',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  assert.doesNotMatch(block,/EXEC_CLOSE_POSITION|runFullClose|MARKET_LAST_RESORT/);
});
