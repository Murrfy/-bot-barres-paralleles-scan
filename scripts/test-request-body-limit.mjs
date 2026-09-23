import assert from 'node:assert/strict';
import test from 'node:test';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';

test('request body guard rejects oversized declared content length',()=>{
  const status=requestBodyStatus({headers:{'content-length':'70000'},body:{}},64*1024);
  assert.equal(status.ok,false);
  assert.equal(status.reason,'CONTENT_LENGTH');
  assert.equal(status.maxBytes,64*1024);
});

test('request body guard rejects oversized parsed JSON even without content-length',()=>{
  const status=requestBodyStatus({headers:{},body:{data:'x'.repeat(70000)}},64*1024);
  assert.equal(status.ok,false);
  assert.equal(status.reason,'PARSED_BODY');
});

test('request body guard accepts ordinary Zenith command payloads',()=>{
  const status=requestBodyStatus({
    headers:{'content-length':'512'},
    body:{type:'EXEC_CLOSE_POSITION',payload:{symbol:'BTCUSDT',direction:'LONG',quantity:0.01,closeAll:true}},
  },64*1024);
  assert.equal(status.ok,true);
});
