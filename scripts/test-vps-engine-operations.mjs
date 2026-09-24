import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const worker=fs.readFileSync('server/zenith-engine-worker.mjs','utf8');
const service=fs.readFileSync('deploy/zenith-engine.service','utf8');
const watchdog=fs.readFileSync('deploy/zenith-engine-watchdog.service','utf8');
const timer=fs.readFileSync('deploy/zenith-engine-watchdog.timer','utf8');
const restart=fs.readFileSync('deploy/zenith-engine-restart.service','utf8');
const probe=fs.readFileSync('deploy/check-engine-liveness.mjs','utf8');
const envExample=fs.readFileSync('deploy/engine.env.example','utf8');

test('engine health endpoint is localhost-only and separates liveness from readiness',()=>{
  assert.ok(worker.includes("import http from 'node:http';"));
  assert.ok(worker.includes("const HEALTH_HOST='127.0.0.1';"));
  assert.ok(worker.includes("path!=='/healthz'&&path!=='/readyz'"));
  assert.ok(worker.includes("const status=path==='/readyz'&&!payload.ready?503:200;"));
  assert.ok(worker.includes("workerPhase==='RUNNING'"));
  assert.ok(worker.includes('runtime.leaseActive'));
  assert.ok(worker.includes('runtime.heartbeatFresh'));
  assert.ok(worker.includes('runtime.synchronized'));
  assert.ok(worker.includes('userStreamReady(stream.state)'));
  assert.equal(worker.includes("HEALTH_HOST='0.0.0.0'"),false);
});

test('local health response does not expose credentials or session material',()=>{
  const start=worker.indexOf('function healthPayload(){');
  const end=worker.indexOf('async function startHealthServer()',start);
  assert.ok(start>=0&&end>start);
  const block=worker.slice(start,end);
  for(const forbidden of [
    'BOOTSTRAP_SECRET',
    'sessionCookie',
    'BINANCE_API',
    'UPSTASH',
    'adminCode',
    'pairingCode',
  ]) assert.equal(block.includes(forbidden),false,forbidden+' must not be disclosed');
});

test('VPS service runs as non-root with automatic crash restart and read-only system hardening',()=>{
  assert.ok(service.includes('User=zenith'));
  assert.ok(service.includes('Group=zenith'));
  assert.ok(service.includes('EnvironmentFile=/etc/zenith/engine.env'));
  assert.ok(service.includes('ExecStart=/usr/bin/node /opt/zenith/current/server/zenith-engine-worker.mjs'));
  assert.ok(service.includes('Restart=on-failure'));
  assert.ok(service.includes('RestartSec=5'));
  assert.ok(service.includes('NoNewPrivileges=true'));
  assert.ok(service.includes('ProtectSystem=strict'));
  assert.ok(service.includes('ProtectHome=true'));
  assert.ok(service.includes('PrivateDevices=true'));
  assert.ok(service.includes('CapabilityBoundingSet='));
  assert.equal(service.includes('User=root'),false);
});

test('watchdog checks only local liveness and restarts through a dedicated systemd unit',()=>{
  assert.ok(watchdog.includes('OnFailure=zenith-engine-restart.service'));
  assert.ok(watchdog.includes('EnvironmentFile=/etc/zenith/engine.env'));
  assert.ok(probe.includes("process.env.ZENITH_ENGINE_WORKER_ENABLED==='1'"));
  assert.ok(probe.includes('http://127.0.0.1:'));
  assert.ok(probe.includes('/healthz'));
  assert.equal(probe.includes('/readyz'),false,'dependency outages must not trigger restart loops');
  assert.ok(restart.includes('ExecStart=/usr/bin/systemctl restart zenith-engine.service'));
  assert.ok(timer.includes('OnUnitActiveSec=1min'));
  assert.ok(timer.includes('Persistent=true'));
});

test('deployment example is production-targeted but disabled by default and contains no real secret',()=>{
  assert.ok(envExample.includes('ZENITH_BASE_URL=https://zenithfinal3-ahle.vercel.app'));
  assert.ok(envExample.includes('ZENITH_ENGINE_WORKER_ENABLED=0'));
  assert.ok(envExample.includes('ZENITH_ENGINE_HEALTH_PORT=8787'));
  assert.ok(envExample.includes('REPLACE_WITH_UNIQUE_RANDOM_SECRET_AT_LEAST_32_CHARS'));
  assert.equal(/ZENITH_ENGINE_WORKER_ENABLED=1/.test(envExample),false);
  assert.equal(/[A-Za-z0-9_-]{40,}/.test(
    envExample.replace('REPLACE_WITH_UNIQUE_RANDOM_SECRET_AT_LEAST_32_CHARS','')
  ),false);
});
