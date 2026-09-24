import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const blueprint=fs.readFileSync('render.yaml','utf8');

test('Render deployment is a single permanent Node worker in Frankfurt',()=>{
  assert.ok(blueprint.includes('type: worker'));
  assert.ok(blueprint.includes('name: zenith-engine-24x7'));
  assert.ok(blueprint.includes('runtime: node'));
  assert.ok(blueprint.includes('region: frankfurt'));
  assert.ok(blueprint.includes('plan: 0.5c-512mb'));
  assert.ok(blueprint.includes('numInstances: 1'));
  assert.ok(blueprint.includes('startCommand: npm run engine'));
  assert.ok(blueprint.includes('maxShutdownDelaySeconds: 30'));
});

test('Render auto-deploy waits for repository CI',()=>{
  assert.ok(blueprint.includes('autoDeployTrigger: checksPass'));
  assert.equal(blueprint.includes('autoDeployTrigger: commit'),false);
});

test('Render worker points to the verified Zenith production API and is inert by default',()=>{
  assert.ok(blueprint.includes('value: https://zenithfinal3-ahle.vercel.app'));
  assert.ok(blueprint.includes('key: ZENITH_ENGINE_WORKER_ENABLED'));
  assert.ok(blueprint.includes('value: "0"'));
  assert.equal(blueprint.includes('value: "1"'),false);
});

test('bootstrap secret is requested outside Git and Binance/Redis secrets never enter Render blueprint',()=>{
  const secretBlock=blueprint.slice(
    blueprint.indexOf('key: ZENITH_ENGINE_BOOTSTRAP_SECRET'),
    blueprint.indexOf('key: ZENITH_ENGINE_WORKER_ENABLED')
  );
  assert.ok(secretBlock.includes('sync: false'));
  assert.equal(secretBlock.includes('value:'),false);
  for(const forbidden of [
    'BINANCE_API_KEY',
    'BINANCE_API_SECRET',
    'BINANCE_TRADING_API_KEY',
    'BINANCE_TRADING_API_SECRET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'ZENITH_MASTER_ADMIN_CODE',
    'ZENITH_MASTER_PAIRING_CODE',
  ]) assert.equal(blueprint.includes(forbidden),false,forbidden+' must stay out of Render worker');
});
