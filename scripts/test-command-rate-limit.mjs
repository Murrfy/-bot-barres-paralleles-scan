import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only';

const source = fs.readFileSync('api/zenith-sync.js', 'utf8')
  .replace(
    /^import \{ DEVICE_SESSION_MAX_AGE_SECONDS, deviceTokenCandidates, setDeviceSessionCookie, clearDeviceSessionCookie, sameOriginMutation \} from '\.\.\/lib\/device-session\.mjs';\n/m,
    "const DEVICE_SESSION_MAX_AGE_SECONDS=60*60*24*30; const deviceTokenCandidates=()=>[]; const setDeviceSessionCookie=()=>{}; const clearDeviceSessionCookie=()=>{}; const sameOriginMutation=()=>true;\n"
  )
  .replace(
    /^import \{ normalizeProtectiveUpdatePayload, protectionOnlyMismatchTarget, protectiveRepairTarget \} from '\.\.\/lib\/protective-command\.mjs';\n/m,
    "const normalizeProtectiveUpdatePayload=()=>{ throw new Error('NOT_USED_BY_COMMAND_RATE_TEST'); }; const protectionOnlyMismatchTarget=()=>''; const protectiveRepairTarget=()=>'';\n"
  )
  .replace(
    /^import \{ REAL_RISK_LIMITS \} from '\.\.\/lib\/risk-policy\.mjs';\n/m,
    "const REAL_RISK_LIMITS=Object.freeze({maxLossUsd:400});\n"
  );

const { commandSubmitRateAllowed } = await import(
  'data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { commandSubmitRateAllowed };').toString('base64')
);

test('controller command submissions are capped at 30 per minute per device', async () => {
  const original = globalThis.fetch;
  const counters = new Map();
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(url, 'https://redis.test');
    const cmd = JSON.parse(init.body);
    let result = null;
    if (cmd[0] === 'INCR') {
      const key = String(cmd[1]);
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      result = next;
    } else if (cmd[0] === 'EXPIRE') {
      result = 1;
    } else {
      assert.fail('unexpected Redis command: ' + cmd[0]);
    }
    return new Response(JSON.stringify({ result }));
  };

  try {
    for (let i = 1; i <= 30; i++) {
      const rate = await commandSubmitRateAllowed('controller-1');
      assert.equal(rate.allowed, true, 'request ' + i);
      assert.equal(rate.count, i);
    }
    const blocked = await commandSubmitRateAllowed('controller-1');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.count, 31);

    const other = await commandSubmitRateAllowed('controller-2');
    assert.equal(other.allowed, true);
    assert.equal(other.count, 1);
  } finally {
    globalThis.fetch = original;
  }
});
