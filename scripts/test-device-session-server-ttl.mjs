import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('api/zenith-sync.js', 'utf8');

test('controller sessions stay absolute while engine heartbeat renews only the engine session', () => {
  assert.match(
    source,
    /import \{[^\n]*DEVICE_SESSION_MAX_AGE_SECONDS[^\n]*deviceSessionRemainingSeconds[^\n]*bearerToken[^\n]*cookieToken[^\n]*setDeviceSessionCookie[^\n]*clearDeviceSessionCookie[^\n]*sameOriginMutation[^\n]*\} from '\.\.\/lib\/device-session\.mjs';/
  );

  assert.match(
    source,
    /SET', key, JSON\.stringify\(updated\), 'EX', String\(renewedSeconds\)/
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

  // Fresh pairing atomically claims the role, advances the epoch and creates the session with the full lifetime.
  assert.match(source, /const pairSessionScript = \[/);
  assert.match(source, /redis\.call\('SET', KEYS\[1\], ARGV\[1\]\)/);
  assert.match(source, /redis\.call\('SET', KEYS\[2\], ARGV\[2\]\)/);
  assert.match(source, /redis\.call\('SET', KEYS\[3\], ARGV\[3\], 'EX', ARGV\[4\]\)/);
  assert.match(
    source,
    /'EVAL', pairSessionScript, '3',[\s\S]*roleDeviceKey\(role\),[\s\S]*roleAssignmentKey\(PREFIX, role\),[\s\S]*\$\{PREFIX\}:device:\$\{tokenHash\}[\s\S]*String\(DEVICE_SESSION_MAX_AGE_SECONDS\)/
  );

  // Controller replacement still starts with the full maximum lifetime.
  assert.match(
    source,
    /JSON\.stringify\(deviceRecord\),\s*String\(DEVICE_SESSION_MAX_AGE_SECONDS\)/
  );

  // Only the server engine receives a rolling 30-day inactivity window.
  assert.match(
    source,
    /const engine = String\(device\?\.principal \|\| ''\) === 'engine'/
  );
  assert.match(
    source,
    /const renewedSeconds = engine \? DEVICE_SESSION_MAX_AGE_SECONDS : remainingSeconds/
  );
  assert.match(
    source,
    /return \{ expired:false, remainingSeconds:renewedSeconds \}/
  );
});
