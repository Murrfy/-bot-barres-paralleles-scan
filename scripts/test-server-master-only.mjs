import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sync=fs.readFileSync('api/zenith-sync.js','utf8');
const admin=fs.readFileSync('master-admin.html','utf8');
const recovery=fs.readFileSync('replace-controller.html','utf8');
const index=fs.readFileSync('index.html','utf8');

function between(source,startMarker,endMarker){
  const start=source.indexOf(startMarker);
  const end=source.indexOf(endMarker,start+startMarker.length);
  assert.ok(start>=0&&end>start,'missing block '+startMarker);
  return source.slice(start,end);
}

test('public browser pairing can create controllers but never MASTER devices',()=>{
  const pair=between(sync,"if (action === 'pair' && req.method === 'POST')","if (action === 'controller-replacement-authorize'");
  assert.match(pair,/role === 'master'/);
  assert.match(pair,/BROWSER_MASTER_PAIRING_DISABLED/);
  assert.match(pair,/role !== 'controller'/);
  assert.match(pair,/const expectedPairingCode = PAIRING_CODE/);
  assert.doesNotMatch(pair,/MASTER_PAIRING_CODE|MASTER_PAIRING_NOT_CONFIGURED/);
});

test('MASTER identity is created by authenticated server engine bootstrap',()=>{
  const bootstrap=between(sync,"if (action === 'engine-bootstrap'","if (action === 'pair'");
  assert.match(bootstrap,/role: 'master'/);
  assert.match(bootstrap,/principal: 'engine'/);
  assert.match(bootstrap,/deviceName: 'Zenith 24\/7 Server Engine'/);
  assert.match(bootstrap,/verifyEngineBootstrapSecret\(req, res\)/);
});

test('MASTER administration in a browser accepts controller identity only',()=>{
  assert.match(admin,/role!=='controller'/);
  assert.match(admin,/Appareil contrôleur requis/);
  assert.doesNotMatch(admin,/\['controller','master'\]\.includes\(role\)/);
  assert.doesNotMatch(admin,/role==='master'\?'\/master-standby\.html'/);
});

test('lost-phone recovery stays independent from MASTER browser pairing',()=>{
  assert.match(recovery,/action=controller-recovery-admin/);
  assert.match(recovery,/Code administrateur Zenith/);
  assert.match(recovery,/sans toucher au MASTER serveur ni aux positions Binance/);
});

test('obsolete iPad/browser MASTER architecture cannot return',()=>{
  assert.equal(fs.existsSync('pair-master.html'),false);
  assert.equal(fs.existsSync('master-standby.html'),false);
  for(const forbidden of [
    'IPAD MASTER',
    'masterWakeBadge',
    'startMasterRuntimeLoop',
    'masterRuntimeState',
    'masterUserStream',
    'masterExecution',
    'masterStreamProjection',
    'localSimulationEntryAllowed',
    "controllerIdentity.role==='master'",
  ]) assert.equal(index.includes(forbidden),false,forbidden);
});
