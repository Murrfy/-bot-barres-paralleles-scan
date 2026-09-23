import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/zenith-sync.js','utf8');

function between(startMarker,endMarker){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,'missing source block '+startMarker);
  return source.slice(start,end);
}

test('authentication secret inputs have explicit small bounds',()=>{
  assert.ok(source.includes('const AUTH_SECRET_INPUT_MAX_CHARS = 256;'));
  assert.ok(source.includes('const REPLACEMENT_CODE_INPUT_MAX_CHARS = 64;'));
});

test('pairing code is bounded before timing-safe comparison',()=>{
  const block=between("if (action === 'pair'","if (action === 'controller-replacement-authorize'");
  const bound=block.indexOf('PAIRING_CODE_INPUT_TOO_LARGE');
  const compare=block.indexOf('timingSafeEqualText(supplied, expectedPairingCode)');
  assert.ok(bound>=0&&compare>bound,'pairing input bound must precede secret comparison');
});

test('MASTER admin code is bounded before lock lookup and secret comparison',()=>{
  const block=between('async function verifyMasterAdminCode','function normalizeReplacementCode');
  const bound=block.indexOf('MASTER_ADMIN_CODE_INPUT_TOO_LARGE');
  const lockRead=block.indexOf("redis(['GET', key])");
  const compare=block.indexOf('timingSafeEqualText(supplied, MASTER_ADMIN_CODE)');
  assert.ok(bound>=0&&lockRead>bound,'admin input bound must precede Redis lock lookup');
  assert.ok(compare>bound,'admin input bound must precede secret comparison');
});

test('controller replacement code is bounded before normalization and hashing',()=>{
  const block=between("if (action === 'controller-replacement-redeem'","if (action === 'whoami'");
  const bound=block.indexOf('CONTROLLER_REPLACEMENT_CODE_INPUT_TOO_LARGE');
  const normalize=block.indexOf('normalizeReplacementCode(recoveryCode)');
  const key=block.indexOf('replacementKey(recoveryCode)');
  assert.ok(bound>=0&&normalize>bound,'replacement input bound must precede normalization');
  assert.ok(key>bound,'replacement input bound must precede hashing/storage lookup');
});
