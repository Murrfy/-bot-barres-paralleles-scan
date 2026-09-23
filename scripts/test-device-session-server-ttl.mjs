import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('api/zenith-sync.js', 'utf8');

test('device sessions have an absolute 30-day lifetime instead of sliding forever', () => {
  assert.match(
    source,
    /import \{[^\n]*DEVICE_SESSION_MAX_AGE_SECONDS[^\n]*bearerToken[^\n]*cookieToken[^\n]*setDeviceSessionCookie[^\n]*clearDeviceSessionCookie[^\n]*sameOriginMutation[^\n]*\} from '\.\.\/lib\/device-session\.mjs';/
  );

  assert.match(
    source,
    /function deviceSessionRemainingSeconds\(device, now = Date\.now\(\)\)/
  );
  assert.match(
    source,
    /absoluteExpiresAt = createdAt \+ DEVICE_SESSION_MAX_AGE_SECONDS \* 1000/
  );
  assert.match(
    source,
    /SET', key, JSON\.stringify\(updated\), 'EX', String\(remainingSeconds\)/
  );
  assert.match(
    source,
    /if \(remainingSeconds <= 0\) \{\s*await redis\(\['DEL', key\]\)/
  );
  assert.match(
    source,
    /setDeviceSessionCookie\(res, device\.sessionToken, session\.remainingSeconds\)/
  );
  assert.match(
    source,
    /'DEVICE_SESSION_EXPIRED'/
  );

  // Fresh pairing atomically advances the role epoch and creates the session with the full lifetime.
  assert.match(source, /const pairSessionScript = \[/);
  assert.match(source, /redis\.call\('SET', KEYS\[1\], ARGV\[1\]\)/);
  assert.match(source, /redis\.call\('SET', KEYS\[2\], ARGV\[2\], 'EX', ARGV\[3\]\)/);
  assert.match(
    source,
    /'EVAL', pairSessionScript, '2',[\s\S]*roleAssignmentKey\(PREFIX, role\),[\s\S]*\$\{PREFIX\}:device:\$\{tokenHash\}[\s\S]*String\(DEVICE_SESSION_MAX_AGE_SECONDS\)/
  );

  // Controller replacement still starts with the full maximum lifetime.
  assert.match(
    source,
    /JSON\.stringify\(deviceRecord\),\s*String\(DEVICE_SESSION_MAX_AGE_SECONDS\)/
  );

  // The old sliding refresh must never come back.
  assert.doesNotMatch(
    source,
    /device\.tokenHash\}\x60, JSON\.stringify\(updated\), 'EX', String\(DEVICE_SESSION_MAX_AGE_SECONDS\)/
  );
});
