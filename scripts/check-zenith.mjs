import fs from 'node:fs';

const htmlFiles = [
  'index.html',
  'pair-controller.html',
  'controller-status.html',
  'pair-master.html',
  'master-standby.html',
  'master-admin.html',
  'replace-controller.html',
].filter(fs.existsSync);

let failed = false;

function fail(message) {
  failed = true;
  console.error('FAIL:', message);
}

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

  scripts.forEach((source, index) => {
    try {
      new Function(source);
    } catch (error) {
      fail(`${file}: inline script ${index + 1} syntax error: ${error.message}`);
    }
  });

  if (/<\/[^>]+>\\n\s*</.test(html)) {
    fail(`${file}: literal \\n found between HTML tags`);
  }
}

const index = fs.readFileSync('index.html', 'utf8');
if (!index.includes('simulation uniquement')) {
  fail('index.html must keep the visible simulation-only marker until real trading is deliberately released');
}
if (!index.includes('startBinanceAccountReadOnly()')) {
  fail('index.html must keep Binance read-only account refresh');
}
if (!index.includes("Authorization:'Bearer '+token")) {
  fail('index.html must authenticate Binance account reads with the paired device token');
}

const binanceRead = fs.readFileSync('api/binance-read.js', 'utf8');
for (const forbidden of ['/fapi/v1/order', '/fapi/v1/algoOrder', '/fapi/v1/batchOrders']) {
  if (binanceRead.includes(forbidden)) {
    fail(`api/binance-read.js must remain read-only; forbidden endpoint found: ${forbidden}`);
  }
}
if (!binanceRead.includes("'UNAUTHORIZED_DEVICE'") || !binanceRead.includes('requireZenithDevice')) {
  fail('api/binance-read.js must require a paired Zenith device');
}
if (!binanceRead.includes('role-device:controller') || !binanceRead.includes('role-device:master')) {
  fail('api/binance-read.js must reject tokens from devices that no longer own their Zenith role');
}

const sync = fs.readFileSync('api/zenith-sync.js', 'utf8');
if (!sync.includes("process.env.ZENITH_REAL_TRADING_ENABLED === '1'")) {
  fail('api/zenith-sync.js must keep the explicit real-trading environment lock');
}
if (!sync.includes("'SIMULATION_LOCKED'")) {
  fail('api/zenith-sync.js must expose SIMULATION_LOCKED when real trading is not armed');
}
if (!sync.includes("KEY_EMERGENCY_STOP")) {
  fail('api/zenith-sync.js must keep the persistent emergency-stop key');
}
if (!sync.includes("'EXECUTION_LOCKED'")) {
  fail('api/zenith-sync.js must reject future execution commands while locked');
}
if (!sync.includes("'MASTER_ACTIVATION_REQUIRED'") || !sync.includes("action === 'master-authorize'")) {
  fail('api/zenith-sync.js must require controller authorization before first MASTER lease');
}
if (!sync.includes("ZENITH_MASTER_ADMIN_CODE") ||
    !sync.includes("action === 'controller-replacement-authorize'") ||
    !sync.includes("action === 'controller-replacement-redeem'")) {
  fail('api/zenith-sync.js must keep secure controller replacement recovery');
}
if (!sync.includes('CONTROLLER_REPLACEMENT_TTL_SECONDS = 10 * 60') ||
    !sync.includes("redis.call('DEL', KEYS[1])")) {
  fail('controller replacement code must remain short-lived and one-time use');
}
if (!sync.includes("'STALE_CONTROLLER_COMMAND'") || !sync.includes("'CONTROLLER_REPLACED'")) {
  fail('api/zenith-sync.js must reject/quarantine commands from a replaced controller');
}
if (!sync.includes("const KEY_MASTER_MODE") ||
    !sync.includes("action === 'master-pause'") ||
    !sync.includes("action === 'master-resume'")) {
  fail('api/zenith-sync.js must keep protected MASTER pause/resume');
}
if (!sync.includes("'MASTER_PAUSE_BLOCKED'") ||
    !sync.includes("'ACTIVE_POSITION'") ||
    !sync.includes("'OPEN_ORDER'") ||
    !sync.includes("'PENDING_COMMAND'") ||
    !sync.includes("'PROCESSING_COMMAND'")) {
  fail('MASTER pause must fail closed while trading activity or commands remain');
}
if (!sync.includes("'MASTER_PAUSED'") || !sync.includes("masterMode()) !== 'RUNNING'")) {
  fail('MASTER command consumption must stop while paused');
}
if (!sync.includes('freshCleanReconciliation') ||
    !sync.includes("'BINANCE_RECONCILIATION_REQUIRED'")) {
  fail('real MASTER resume must require fresh clean Binance reconciliation');
}
if (!sync.includes("requireDevice(req, res, ['controller', 'master'])")) {
  fail('MASTER pause/resume must be callable by both controller and MASTER');
}
if (!sync.includes("'PAUSE_PENDING'") ||
    !sync.includes("action === 'master-pause-cancel'") ||
    !sync.includes("'MASTER_PAUSE_QUEUED'") ||
    !sync.includes("'MASTER_PAUSE_COMPLETED'")) {
  fail('MASTER must support queued pause after active positions close');
}
if (!sync.includes('PAUSE_PENDING_ALLOWED_COMMANDS') ||
    !sync.includes("'MASTER_PAUSE_PENDING_UNSAFE_COMMAND'")) {
  fail('queued pause must block new entry commands while allowing explicit close/protection commands');
}
if (!index.includes('masterCancelPauseBtn') ||
    !index.includes("controllerMasterAction('master-pause-cancel')")) {
  fail('iPhone controller UI must allow cancelling a queued MASTER pause');
}
if (!index.includes('masterPauseBtn') ||
    !index.includes('masterResumeBtn') ||
    !index.includes("controllerMasterAction('master-pause')") ||
    !index.includes("controllerMasterAction('master-resume')")) {
  fail('iPhone controller UI must expose protected MASTER pause/resume controls');
}

const masterAdmin = fs.readFileSync('master-admin.html', 'utf8');
if (!masterAdmin.includes('cancelPauseBtn') ||
    !masterAdmin.includes("setMasterMode('master-pause-cancel')")) {
  fail('iPad MASTER admin UI must allow cancelling a queued pause');
}

const replaceController = fs.readFileSync('replace-controller.html', 'utf8');
if (!replaceController.includes('restoreCentralState') ||
    !replaceController.includes('zenith_controller_revision_v1')) {
  fail('replace-controller.html must restore central configuration and revision before opening Zenith');
}

if (failed) process.exit(1);
console.log('Zenith safety checks passed.');
