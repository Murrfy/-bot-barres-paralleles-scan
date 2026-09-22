import fs from 'node:fs';

const htmlFiles = [
  'index.html',
  'pair-controller.html',
  'controller-status.html',
  'pair-master.html',
  'master-standby.html',
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

const binanceRead = fs.readFileSync('api/binance-read.js', 'utf8');
for (const forbidden of ['/fapi/v1/order', '/fapi/v1/algoOrder', '/fapi/v1/batchOrders']) {
  if (binanceRead.includes(forbidden)) {
    fail(`api/binance-read.js must remain read-only; forbidden endpoint found: ${forbidden}`);
  }
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

if (failed) process.exit(1);
console.log('Zenith safety checks passed.');
