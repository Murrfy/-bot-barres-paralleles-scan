import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api=fs.readFileSync('api/binance-entry-execute.js','utf8');

test('exact deterministic entry identity is persisted before Binance LIMIT POST',()=>{
  const start=api.indexOf("const rawTransition=await readEntryTransition(commandId);");
  const end=api.indexOf("kind:'BINANCE_ENTRY_ORDER_DISPATCH'",start);
  assert.ok(start>=0&&end>start);
  const block=api.slice(start,end+1200);
  const buildIntent=block.indexOf("const submittedIntent={");
  const validateIntent=block.indexOf("normalizeEntryTransition(submittedIntent");
  const persistIntent=block.indexOf("await writeEntryTransition(commandId,checkedSubmittedIntent.transition)");
  const auditIntent=block.indexOf("BINANCE_ENTRY_ORDER_INTENT_COMMITTED");
  const post=block.indexOf("placeStandardOrderIdempotent({");
  assert.ok(buildIntent>=0&&validateIntent>buildIntent&&persistIntent>validateIntent&&auditIntent>persistIntent&&post>auditIntent);
  assert.match(block,/entryClientOrderId:plan\.params\.newClientOrderId/);
  assert.match(block,/state:'ENTRY_SUBMITTED'/);
});

test('write-ahead transition remains exact and short-lived',()=>{
  assert.match(api,/entryClientOrderId:plan\.params\.newClientOrderId/);
  assert.match(api,/protectionClientAlgoId:storedTransition\.protectionClientAlgoId/);
  assert.match(api,/ENTRY_TRANSITION_SUBMIT_STATE_INVALID/);
  assert.match(api,/writeAttempted:false,ambiguous:false/);
});
