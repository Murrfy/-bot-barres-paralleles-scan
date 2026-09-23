import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');

const resumeStart=sync.indexOf("if (action === 'master-resume' && req.method === 'POST')");
const resumeEnd=sync.indexOf("if (action === 'safety' && req.method === 'GET')",resumeStart);
assert.ok(resumeStart>=0&&resumeEnd>resumeStart,'MASTER resume block missing');
const resume=sync.slice(resumeStart,resumeEnd);

const cancelStart=sync.indexOf("if (action === 'master-pause-cancel' && req.method === 'POST')");
const cancelEnd=sync.indexOf("if (action === 'real-execution-arm' && req.method === 'POST')",cancelStart);
assert.ok(cancelStart>=0&&cancelEnd>cancelStart,'MASTER pause-cancel block missing');
const cancel=sync.slice(cancelStart,cancelEnd);

test('MASTER resume requires the server mode to already be PAUSED',()=>{
  assert.ok(resume.includes('masterMode()'));
  assert.ok(resume.includes("if (currentMode !== 'PAUSED') blockers.push('MASTER_MUST_BE_PAUSED')"));
  assert.ok(
    resume.indexOf("currentMode !== 'PAUSED'") <
    resume.indexOf("setMasterMode('RUNNING')")
  );
});

test('PAUSE_PENDING cancellation remains a separate explicit ADMIN action',()=>{
  assert.ok(cancel.includes("currentMode !== 'PAUSE_PENDING'"));
  assert.ok(cancel.includes("'MASTER_PAUSE_NOT_PENDING'"));
  assert.ok(cancel.includes('verifyMasterAdminCode(req, res, device)'));
  assert.ok(cancel.includes("setMasterMode('RUNNING')"));
});

test('resume cannot act as an implicit PAUSE_PENDING cancellation path',()=>{
  assert.ok(resume.includes("'MASTER_MUST_BE_PAUSED'"));
  assert.equal(resume.includes("'MASTER_PAUSE_NOT_PENDING'"),false);
});
