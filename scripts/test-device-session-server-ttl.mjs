import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('api/zenith-sync.js', 'utf8');

test('server device sessions use the same TTL as the secure cookie', () => {
  assert.match(
    source,
    /import \{ DEVICE_SESSION_MAX_AGE_SECONDS, deviceTokenCandidates, setDeviceSessionCookie, clearDeviceSessionCookie, sameOriginMutation \} from '\.\.\/lib\/device-session\.mjs';/
  );

  assert.match(
    source,
    /SET', \x60\$\{PREFIX\}:device:\$\{device\.tokenHash\}\x60, JSON\.stringify\(updated\), 'EX', String\(DEVICE_SESSION_MAX_AGE_SECONDS\)/
  );

  assert.match(
    source,
    /SET', \x60\$\{PREFIX\}:device:\$\{tokenHash\}\x60, JSON\.stringify\(record\), 'EX', String\(DEVICE_SESSION_MAX_AGE_SECONDS\)/
  );

  assert.match(
    source,
    /redis\.call\('SET', KEYS\[3\], ARGV\[2\], 'EX', ARGV\[3\]\)/
  );

  assert.match(
    source,
    /JSON\.stringify\(deviceRecord\),\s*String\(DEVICE_SESSION_MAX_AGE_SECONDS\)/
  );
});
