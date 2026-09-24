import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync('api/binance-read.js','utf8');

test('read-only Binance API fences stale engine worker sessions',()=>{
  assert.ok(source.includes('engineInstanceHeader'));
  assert.ok(source.includes('enginePrincipalInstanceActive'));
  assert.ok(source.includes("redis(['GET',`${PREFIX}:engine-instance`])"));
  assert.ok(source.includes("const e=new Error('ENGINE_INSTANCE_FENCED')"));
  assert.ok(source.includes("e.code='ENGINE_INSTANCE_FENCED'"));
});

test('stale engine fence is returned as conflict, not hidden as backend failure',()=>{
  assert.ok(source.includes("if (e?.code === 'ENGINE_INSTANCE_FENCED')"));
  assert.ok(source.includes("return send(res, 409"));
  assert.ok(source.includes("code: 'ENGINE_INSTANCE_FENCED'"));
});

test('controller and ordinary paired MASTER reads remain compatible',()=>{
  const requireStart=source.indexOf('async function requireZenithDevice');
  const requireEnd=source.indexOf('async function binanceReadRateAllowed',requireStart);
  const block=source.slice(requireStart,requireEnd);
  assert.ok(block.includes("if(String(device?.principal||'')==='engine')"));
  assert.ok(block.includes('return device;'));
});
