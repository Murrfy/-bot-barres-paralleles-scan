import assert from 'node:assert/strict';
import test from 'node:test';

const originalVercel=process.env.VERCEL;
const originalVercelEnv=process.env.VERCEL_ENV;
const {clientIp}=await import('../api/zenith-sync.js?client-ip-test='+Date.now());

test('Vercel trusted forwarded IP takes precedence over generic forwarded headers',()=>{
  process.env.VERCEL='1';
  process.env.VERCEL_ENV='production';
  const ip=clientIp({headers:{
    'x-vercel-forwarded-for':'203.0.113.10, 203.0.113.11',
    'x-forwarded-for':'198.51.100.25',
    'x-real-ip':'192.0.2.50',
  }});
  assert.equal(ip,'203.0.113.10');
});

test('non-Vercel hosting keeps x-forwarded-for fallback for future cloud migration',()=>{
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  const ip=clientIp({headers:{
    'x-forwarded-for':'198.51.100.25, 198.51.100.26',
    'x-real-ip':'192.0.2.50',
  }});
  assert.equal(ip,'198.51.100.25');
});

test.after(()=>{
  if(originalVercel===undefined) delete process.env.VERCEL; else process.env.VERCEL=originalVercel;
  if(originalVercelEnv===undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV=originalVercelEnv;
});
