import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');

test('MASTER worker routes close, cancel and protective updates separately',()=>{
  assert.match(html,/if\(dispatch\.type==='EXEC_CLOSE_POSITION'\)\{\s*ok=await runMasterFullClose/);
  assert.match(html,/else if\(dispatch\.type==='EXEC_CANCEL_ENTRY'\)\{\s*ok=await runMasterCancelEntry/);
  assert.match(html,/else if\(dispatch\.type==='EXEC_UPDATE_EXIT'\|\|dispatch\.type==='EXEC_UPDATE_PROTECTION'\)\{\s*ok=await runMasterProtectiveUpdate/);
  assert.doesNotMatch(html,/const ok=await runMasterFullClose\(command,raw\);/);
});

test('mutating cancel/update workers require stream confirmation before ACK',()=>{
  assert.match(html,/waitForStreamOrder\(\{kind:'STANDARD',clientId:clientOrderId,terminal:true\}/);
  assert.match(html,/waitForStreamOrder\(\{kind,clientId:previousId,terminal:true\}/);
  assert.match(html,/waitForStreamOrder\(\{kind,clientId,terminal:false\}/);
  assert.match(html,/reconcileMasterUserStream\(\)/);
});
