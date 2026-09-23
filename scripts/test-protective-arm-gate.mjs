import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateExecutionArmRecord,
  protectiveModeReason,
} from '../api/binance-protective-execute.js';

const arm={version:1,masterDeviceId:'master-1',deploymentSha:'sha-prod'};

test('protective writer requires deployment-bound arm for current MASTER',()=>{
  assert.equal(validateExecutionArmRecord(arm,'master-1','sha-prod'),'');
  assert.equal(validateExecutionArmRecord(null,'master-1','sha-prod'),'REAL_EXECUTION_NOT_ARMED');
  assert.equal(validateExecutionArmRecord(arm,'master-2','sha-prod'),'REAL_EXECUTION_ARM_MASTER_CHANGED');
  assert.equal(validateExecutionArmRecord(arm,'master-1','sha-new'),'REAL_EXECUTION_ARM_DEPLOYMENT_CHANGED');
  assert.equal(validateExecutionArmRecord(arm,'master-1',''),'REAL_EXECUTION_DEPLOYMENT_SHA_MISSING');
});

test('protective writer runs only in RUNNING or PAUSE_PENDING, never PAUSED',()=>{
  assert.equal(protectiveModeReason('RUNNING'),'');
  assert.equal(protectiveModeReason('PAUSE_PENDING'),'');
  assert.equal(protectiveModeReason('PAUSED'),'MASTER_PAUSED');
  assert.equal(protectiveModeReason(''),'MASTER_PAUSED');
});
