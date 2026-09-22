import crypto from 'node:crypto';

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN;

const PAIRING_CODE = process.env.ZENITH_PAIRING_CODE || '';
const MASTER_PAIRING_CODE = process.env.ZENITH_MASTER_PAIRING_CODE || '';
const MASTER_ADMIN_CODE = process.env.ZENITH_MASTER_ADMIN_CODE || '';
const PAIRING_DISABLED = process.env.ZENITH_PAIRING_DISABLED === '1';
const REAL_TRADING_ENABLED = process.env.ZENITH_REAL_TRADING_ENABLED === '1';

const PREFIX = 'zenith:v1';
const KEY_MASTER = `${PREFIX}:master`;
const KEY_CONTROLLER_DEVICE = `${PREFIX}:role-device:controller`;
const KEY_MASTER_DEVICE = `${PREFIX}:role-device:master`;
const KEY_STATE = `${PREFIX}:state`;
const KEY_CONTROLLER_STATE = `${PREFIX}:controller-state`;
const KEY_CONTROLLER_REV = `${PREFIX}:controller-state:rev`;
const KEY_AUDIT = `${PREFIX}:audit`;
const KEY_PENDING = `${PREFIX}:commands:pending`;
const KEY_PROCESSING = `${PREFIX}:commands:processing`;
const KEY_DEAD = `${PREFIX}:commands:dead`;
const KEY_EMERGENCY_STOP = `${PREFIX}:safety:emergency-stop`;
const KEY_MASTER_MODE = `${PREFIX}:master-mode`;
const KEY_RECONCILE_LAST = `${PREFIX}:reconcile:last`;
const KEY_MASTER_CONFIG_ACK = `${PREFIX}:master-config:applied`;
const KEY_MASTER_HEARTBEAT = `${PREFIX}:master-heartbeat`;
const MASTER_TTL_SECONDS = 20;
const MASTER_HEARTBEAT_TTL_SECONDS = 60;
const MASTER_HEARTBEAT_STALE_MS = 30 * 1000;
const MASTER_ACTIVATION_TTL_SECONDS = 120;
const COMMAND_CLAIM_TTL_MS = 90 * 1000;
const COMMAND_DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 30;
const PAIR_RATE_LIMIT = 5;
const CONTROLLER_REPLACEMENT_TTL_SECONDS = 10 * 60;
const CONTROLLER_REPLACEMENT_RATE_LIMIT = 5;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(req.headers['x-real-ip'] || 'unknown');
}

async function redis(command) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const e = new Error('UPSTASH_NOT_CONFIGURED');
    e.code = 'UPSTASH_NOT_CONFIGURED';
    throw e;
  }
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok || data?.error) {
    const e = new Error(data?.error || `Redis HTTP ${r.status}`);
    e.code = 'REDIS_ERROR';
    throw e;
  }
  return data?.result;
}

async function pairRateAllowed(req) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${PREFIX}:pair-rate:${sha256(clientIp(req))}:${bucket}`;
  const count = Number(await redis(['INCR', key])) || 0;
  if (count === 1) await redis(['EXPIRE', key, '120']);
  return count <= PAIR_RATE_LIMIT;
}

async function controllerReplacementRateAllowed(req) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${PREFIX}:controller-replacement-rate:${sha256(clientIp(req))}:${bucket}`;
  const count = Number(await redis(['INCR', key])) || 0;
  if (count === 1) await redis(['EXPIRE', key, '120']);
  return count <= CONTROLLER_REPLACEMENT_RATE_LIMIT;
}

function normalizeReplacementCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function replacementKey(code) {
  return `${PREFIX}:controller-replacement:${sha256(normalizeReplacementCode(code))}`;
}

async function quarantineCommandsForDevice(deviceId) {
  if (!deviceId) return { pending: 0, processing: 0 };
  let pending = 0;
  let processing = 0;

  for (const [key, label] of [[KEY_PENDING, 'pending'], [KEY_PROCESSING, 'processing']]) {
    const rows = await redis(['LRANGE', key, '0', '-1']);
    for (const raw of Array.isArray(rows) ? rows : []) {
      let command = null;
      try { command = JSON.parse(raw); } catch {}
      if (String(command?.deviceId || '') !== String(deviceId)) continue;

      const removed = Number(await redis(['LREM', key, '1', raw])) || 0;
      if (removed > 0) {
        const dead = {
          raw,
          rejectedAt: Date.now(),
          rejectedReason: 'CONTROLLER_REPLACED',
          sourceList: label,
          previousControllerDeviceId: String(deviceId),
        };
        await redis(['LPUSH', KEY_DEAD, JSON.stringify(dead)]);
        if (label === 'pending') pending += removed;
        else processing += removed;
      }
    }
  }

  return { pending, processing };
}

async function authDevice(req) {
  const token = bearer(req);
  if (!token) return null;
  const hash = sha256(token);
  const raw = await redis(['GET', `${PREFIX}:device:${hash}`]);
  if (!raw) return null;
  try {
    const device = JSON.parse(raw);
    if (!device?.deviceId || !['controller', 'master'].includes(device?.role)) return null;
    return { ...device, tokenHash: hash };
  } catch {
    return null;
  }
}

function roleDeviceKey(role) {
  return role === 'master' ? KEY_MASTER_DEVICE : KEY_CONTROLLER_DEVICE;
}

async function claimOrVerifyRoleDevice(role, deviceId) {
  const key = roleDeviceKey(role);
  const script = [
    "local current = redis.call('GET', KEYS[1])",
    "if not current then",
    "  redis.call('SET', KEYS[1], ARGV[1])",
    "  return 1",
    "end",
    "if current == ARGV[1] then return 1 end",
    "return 0"
  ].join('\n');
  const ok = await redis(['EVAL', script, '1', key, String(deviceId)]);
  return Number(ok) === 1;
}

async function roleDeviceId(role) {
  const value = await redis(['GET', roleDeviceKey(role)]);
  return value ? String(value) : '';
}

async function touchDevice(device) {
  if (!device?.tokenHash) return;
  const updated = { ...device, lastSeenAt: Date.now() };
  delete updated.tokenHash;
  await redis(['SET', `${PREFIX}:device:${device.tokenHash}`, JSON.stringify(updated)]);
}

async function requireDevice(req, res, roles) {
  const device = await authDevice(req);
  if (!device) {
    send(res, 401, { ok: false, code: 'UNAUTHORIZED_DEVICE' });
    return null;
  }
  if (roles && !roles.includes(device.role)) {
    send(res, 403, { ok: false, code: 'ROLE_FORBIDDEN' });
    return null;
  }
  if (!(await claimOrVerifyRoleDevice(device.role, device.deviceId))) {
    send(res, 409, { ok: false, code: 'ROLE_DEVICE_CONFLICT' });
    return null;
  }
  await touchDevice(device);
  return device;
}

async function masterDeviceId() {
  const value = await redis(['GET', KEY_MASTER]);
  return value ? String(value) : '';
}

async function hasMasterLease(deviceId) {
  if (!deviceId) return false;
  return (await masterDeviceId()) === String(deviceId);
}

function masterActivationKey(deviceId) {
  return `${PREFIX}:master-activation:${deviceId}`;
}

async function acquireOrRenewMaster(deviceId) {
  const script = [
    "local current = redis.call('GET', KEYS[1])",
    "if current and current == ARGV[1] then",
    "  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])",
    "  return 2",
    "end",
    "if current and current ~= ARGV[1] then return -1 end",
    "local approved = redis.call('GET', KEYS[2])",
    "if approved ~= '1' then return 0 end",
    "redis.call('DEL', KEYS[2])",
    "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])",
    "return 1"
  ].join('\n');

  const result = Number(await redis([
    'EVAL', script, '2',
    KEY_MASTER, masterActivationKey(deviceId),
    String(deviceId), String(MASTER_TTL_SECONDS)
  ]));

  return {
    acquired: result === 1,
    renewed: result === 2,
    conflict: result === -1,
    authorized: result !== 0,
  };
}

async function emergencyStopActive() {
  const value = await redis(['GET', KEY_EMERGENCY_STOP]);
  if (value === null || value === undefined || value === '') return true;
  return String(value) !== '0';
}

function normalizeMasterMode(value) {
  const mode = String(value || '').toUpperCase();
  if (mode === 'RUNNING' || mode === 'PAUSE_PENDING') return mode;
  return 'PAUSED';
}

const PAUSE_PENDING_ALLOWED_COMMANDS = new Set([
  'UPDATE_EXIT',
  'UPDATE_PROTECTION',
  'CLOSE_POSITION',
  'CANCEL_ENTRY',
  'EXEC_UPDATE_EXIT',
  'EXEC_UPDATE_PROTECTION',
  'EXEC_CLOSE_POSITION',
  'EXEC_CANCEL_ENTRY',
]);

function commandAllowedDuringPausePending(type) {
  return PAUSE_PENDING_ALLOWED_COMMANDS.has(String(type || '').toUpperCase());
}

async function masterMode() {
  return normalizeMasterMode(await redis(['GET', KEY_MASTER_MODE]));
}

async function setMasterMode(mode) {
  const normalized = normalizeMasterMode(mode);
  await redis(['SET', KEY_MASTER_MODE, normalized]);
  return normalized;
}

function activityCount(data, arrayKeys, numberKeys) {
  let count = 0;
  for (const key of arrayKeys) {
    if (Array.isArray(data?.[key])) count = Math.max(count, data[key].length);
  }
  for (const key of numberKeys) {
    const value = Number(data?.[key]);
    if (Number.isFinite(value) && value > count) count = value;
  }
  return count;
}

function inspectRuntimeActivity(snapshot) {
  const data = snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : {};
  return {
    activePositions: activityCount(
      data,
      ['openPositions', 'positions', 'realPositions', 'binancePositions'],
      ['activePositions', 'activePositionCount', 'realPositionCount', 'realPositionsCount']
    ),
    openOrders: activityCount(
      data,
      ['openOrders', 'pendingOrders', 'binanceOrders', 'protectiveOrders'],
      ['openOrderCount', 'openOrdersCount', 'pendingOrderCount']
    ),
  };
}

function parseStoredJson(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function masterConfigSyncStatus(controllerState, appliedState, runtimeState, expectedMasterDeviceId = '') {
  const controllerRevision = Number(controllerState?.revision || 0);
  const controllerStateHash = String(controllerState?.stateHash || '');
  const appliedRevision = Number(appliedState?.revision || 0);
  const appliedStateHash = String(appliedState?.stateHash || '');
  const appliedMasterDeviceId = String(appliedState?.masterDeviceId || '');
  const activity = inspectRuntimeActivity(runtimeState);
  const controllerPresent = controllerRevision > 0 && Boolean(controllerStateHash);
  const masterIdentityMatches = !expectedMasterDeviceId || appliedMasterDeviceId === String(expectedMasterDeviceId);
  const synchronized = controllerPresent &&
    appliedRevision === controllerRevision &&
    appliedStateHash === controllerStateHash &&
    masterIdentityMatches;
  const needsApply = controllerPresent && !synchronized;
  const applyDeferred = needsApply && (activity.activePositions > 0 || activity.openOrders > 0);
  const reason = !controllerPresent
    ? 'NO_CONTROLLER_STATE'
    : synchronized
      ? 'SYNCED'
      : applyDeferred
        ? 'MASTER_CONFIG_APPLY_DEFERRED'
        : 'MASTER_CONFIG_OUT_OF_SYNC';

  return {
    controllerPresent,
    controllerRevision,
    controllerStateHash,
    appliedRevision,
    appliedStateHash,
    appliedAt: Number(appliedState?.appliedAt || 0),
    appliedMasterDeviceId,
    synchronized,
    needsApply,
    applyAllowed: needsApply && !applyDeferred,
    applyDeferred,
    failClosed: !synchronized,
    reason,
    activity,
  };
}

async function readMasterConfigSync(expectedMasterDeviceId = '') {
  const [controllerRaw, appliedRaw, runtimeRaw] = await Promise.all([
    redis(['GET', KEY_CONTROLLER_STATE]),
    redis(['GET', KEY_MASTER_CONFIG_ACK]),
    redis(['GET', KEY_STATE]),
  ]);
  const controllerState = parseStoredJson(controllerRaw);
  const appliedState = parseStoredJson(appliedRaw);
  const runtimeState = parseStoredJson(runtimeRaw);
  return {
    controllerState,
    appliedState,
    runtimeState,
    status: masterConfigSyncStatus(controllerState, appliedState, runtimeState, expectedMasterDeviceId),
  };
}

function heartbeatStatus(raw, expectedMasterDeviceId = '') {
  const heartbeat = parseStoredJson(raw);
  const at = Number(heartbeat?.at || 0);
  const ageMs = Date.now() - at;
  const identityMatches = !expectedMasterDeviceId || String(heartbeat?.masterDeviceId || '') === String(expectedMasterDeviceId);
  const fresh = Boolean(heartbeat) && identityMatches && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= MASTER_HEARTBEAT_STALE_MS;
  return { heartbeat, at, ageMs: Number.isFinite(ageMs) ? ageMs : null, fresh };
}

async function freshCleanReconciliation(maxAgeMs = 30000) {
  const raw = await redis(['GET', KEY_RECONCILE_LAST]);
  if (!raw) return { ok: false, reason: 'BINANCE_RECONCILIATION_REQUIRED' };
  try {
    const report = JSON.parse(raw);
    const ageMs = Date.now() - Number(report?.observedAt || 0);
    const positions = Number(report?.actual?.positions || 0);
    const orders = Number(report?.actual?.orders || 0);
    if (report?.failClosed !== false) return { ok: false, reason: 'BINANCE_RECONCILIATION_MISMATCH' };
    if (report.version !== 2 || !['CLEAN_REAL', 'CLEAN_IDLE'].includes(report.status) ||
        !Array.isArray(report.reasons) || report.reasons.length ||
        !report.actual || !Number.isInteger(report.actual.positions) || report.actual.positions < 0 ||
        !Number.isInteger(report.actual.orders) || report.actual.orders < 0 ||
        !report.runtimeHash) return { ok: false, reason: 'BINANCE_RECONCILIATION_INVALID' };
    const runtimeRaw = await redis(['GET', KEY_STATE]);
    if (!runtimeRaw || sha256(runtimeRaw) !== report.runtimeHash) return { ok: false, reason: 'BINANCE_RECONCILIATION_RUNTIME_CHANGED' };
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) return { ok: false, reason: 'BINANCE_RECONCILIATION_STALE' };
    if (positions > 0 || orders > 0) return { ok: false, reason: 'BINANCE_ACTIVITY_PRESENT' };
    return { ok: true, report };
  } catch {
    return { ok: false, reason: 'BINANCE_RECONCILIATION_INVALID' };
  }
}

async function tryFinalizePendingPause(deviceId, knownMode = '') {
  const mode = knownMode ? normalizeMasterMode(knownMode) : await masterMode();
  if (mode !== 'PAUSE_PENDING') return { transitioned: false, masterMode: mode };

  const [runtimeRaw, pending, processing] = await Promise.all([
    redis(['GET', KEY_STATE]),
    redis(['LLEN', KEY_PENDING]),
    redis(['LLEN', KEY_PROCESSING]),
  ]);

  let runtimeState = null;
  try { runtimeState = runtimeRaw ? JSON.parse(runtimeRaw) : null; } catch {}
  const activity = inspectRuntimeActivity(runtimeState);
  const blockers = [];
  if (activity.activePositions > 0) blockers.push('ACTIVE_POSITION');
  if (activity.openOrders > 0) blockers.push('OPEN_ORDER');
  if (Number(pending || 0) > 0) blockers.push('PENDING_COMMAND');
  if (Number(processing || 0) > 0) blockers.push('PROCESSING_COMMAND');
  if (REAL_TRADING_ENABLED && !runtimeState) blockers.push('RUNTIME_STATE_UNAVAILABLE');

  let reconciliation = null;
  if (!blockers.length && REAL_TRADING_ENABLED) {
    reconciliation = await freshCleanReconciliation();
    if (!reconciliation.ok) blockers.push(reconciliation.reason);
  }

  if (blockers.length) {
    return {
      transitioned: false,
      masterMode: 'PAUSE_PENDING',
      blockers,
      activity,
      pendingCommands: Number(pending || 0),
      processingCommands: Number(processing || 0),
    };
  }

  await setMasterMode('PAUSED');
  const at = Date.now();
  await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
    at,
    kind: 'MASTER_PAUSE_COMPLETED',
    deviceId: String(deviceId || ''),
  })]);
  await redis(['LTRIM', KEY_AUDIT, '0', '199']);

  return {
    transitioned: true,
    masterMode: 'PAUSED',
    blockers: [],
    activity,
    pendingCommands: 0,
    processingCommands: 0,
  };
}

async function recoverStaleProcessing(deviceId) {
  const rows = await redis(['LRANGE', KEY_PROCESSING, '0', '-1']);
  const now = Date.now();
  let requeued = 0;
  let removedDone = 0;
  let dead = 0;

  for (const raw of Array.isArray(rows) ? rows : []) {
    let command = null;
    try { command = JSON.parse(raw); } catch {
      const removed = Number(await redis(['LREM', KEY_PROCESSING, '1', raw])) || 0;
      if (removed > 0) {
        await redis(['LPUSH', KEY_DEAD, raw]);
        dead += 1;
      }
      continue;
    }

    const commandId = String(command?.id || '');
    if (commandId) {
      const done = await redis(['GET', `${PREFIX}:command:done:${commandId}`]);
      if (done) {
        removedDone += Number(await redis(['LREM', KEY_PROCESSING, '1', raw])) || 0;
        continue;
      }
    }

    const claimedAt = Number(command?.claimedAt || 0);
    if (!claimedAt || now - claimedAt <= COMMAND_CLAIM_TTL_MS) continue;

    const removed = Number(await redis(['LREM', KEY_PROCESSING, '1', raw])) || 0;
    if (removed > 0) {
      const clean = { ...command };
      delete clean.claimedAt;
      delete clean.claimedBy;
      clean.recoveredAt = now;
      clean.recoveredBy = deviceId;
      await redis(['RPUSH', KEY_PENDING, JSON.stringify(clean)]);
      requeued += 1;
    }
  }

  return { requeued, removedDone, dead };
}

async function claimNextCommand(deviceId) {
  const script = [
    "local raw = redis.call('RPOP', KEYS[1])",
    "if not raw then return nil end",
    "local ok, obj = pcall(cjson.decode, raw)",
    "if not ok then",
    "  redis.call('LPUSH', KEYS[3], raw)",
    "  return '__DEAD__'",
    "end",
    "obj['claimedAt'] = tonumber(ARGV[1])",
    "obj['claimedBy'] = ARGV[2]",
    "local claimed = cjson.encode(obj)",
    "redis.call('LPUSH', KEYS[2], claimed)",
    "return claimed"
  ].join('\n');

  return await redis([
    'EVAL', script, '3',
    KEY_PENDING, KEY_PROCESSING, KEY_DEAD,
    String(Date.now()), String(deviceId)
  ]);
}

export default async function handler(req, res) {
  const action = String(req.query?.action || 'health');

  if (action === 'health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      redisConfigured: Boolean(REDIS_URL && REDIS_TOKEN),
      pairingConfigured: Boolean(PAIRING_CODE),
      masterPairingConfigured: Boolean(MASTER_PAIRING_CODE),
      masterAdminConfigured: Boolean(MASTER_ADMIN_CODE),
      pairingDisabled: PAIRING_DISABLED,
      realTradingEnabled: REAL_TRADING_ENABLED,
      executionMode: REAL_TRADING_ENABLED ? 'REAL_ARMED_BY_ENV' : 'SIMULATION_LOCKED',
      mode: 'SYNC_SAFE_SIMULATION',
      masterTtlSeconds: MASTER_TTL_SECONDS,
      masterActivationTtlSeconds: MASTER_ACTIVATION_TTL_SECONDS,
      commandClaimTtlMs: COMMAND_CLAIM_TTL_MS,
    });
  }

  try {
    if (action === 'pair' && req.method === 'POST') {
      if (PAIRING_DISABLED) return send(res, 403, { ok: false, code: 'PAIRING_DISABLED' });
      if (!(await pairRateAllowed(req))) return send(res, 429, { ok: false, code: 'PAIRING_RATE_LIMIT' });

      const supplied = String(req.body?.pairingCode || '');
      const deviceId = String(req.body?.deviceId || '').trim();
      const role = String(req.body?.role || '').trim();
      const deviceName = String(req.body?.deviceName || '').trim().slice(0, 80);

      if (!deviceId || !['controller', 'master'].includes(role)) {
        return send(res, 400, { ok: false, code: 'PAIRING_REQUEST_INVALID' });
      }

      const expectedPairingCode = role === 'master' ? MASTER_PAIRING_CODE : PAIRING_CODE;
      if (!expectedPairingCode) {
        return send(res, 503, {
          ok: false,
          code: role === 'master' ? 'MASTER_PAIRING_NOT_CONFIGURED' : 'PAIRING_NOT_CONFIGURED'
        });
      }
      if (!timingSafeEqualText(supplied, expectedPairingCode)) {
        return send(res, 401, { ok: false, code: 'PAIRING_CODE_INVALID' });
      }

      const claimedDeviceId = await roleDeviceId(role);
      if (claimedDeviceId && claimedDeviceId !== deviceId) {
        return send(res, 409, { ok: false, code: 'ROLE_DEVICE_CONFLICT' });
      }
      if (role === 'master' && !(await claimOrVerifyRoleDevice(role, deviceId))) {
        return send(res, 409, { ok: false, code: 'ROLE_DEVICE_CONFLICT' });
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = sha256(token);
      const record = {
        deviceId,
        role,
        deviceName,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      await redis(['SET', `${PREFIX}:device:${tokenHash}`, JSON.stringify(record)]);
      return send(res, 201, { ok: true, token, device: record });
    }

    if (action === 'controller-replacement-authorize' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      if (!MASTER_ADMIN_CODE) {
        return send(res, 503, { ok: false, code: 'MASTER_ADMIN_NOT_CONFIGURED' });
      }

      const adminCode = String(req.body?.adminCode || '');
      if (!timingSafeEqualText(adminCode, MASTER_ADMIN_CODE)) {
        return send(res, 401, { ok: false, code: 'MASTER_ADMIN_CODE_INVALID' });
      }

      const oldControllerDeviceId = await roleDeviceId('controller');
      if (!oldControllerDeviceId) {
        return send(res, 409, { ok: false, code: 'CONTROLLER_NOT_REGISTERED' });
      }

      const rawCode = crypto.randomBytes(6).toString('hex').toUpperCase();
      const recoveryCode = rawCode.match(/.{1,4}/g).join('-');
      const createdAt = Date.now();
      const expiresAt = createdAt + CONTROLLER_REPLACEMENT_TTL_SECONDS * 1000;
      const record = {
        version: 1,
        createdAt,
        expiresAt,
        oldControllerDeviceId,
        masterDeviceId: device.deviceId,
      };

      await redis([
        'SET',
        replacementKey(recoveryCode),
        JSON.stringify(record),
        'EX',
        String(CONTROLLER_REPLACEMENT_TTL_SECONDS),
      ]);

      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at: createdAt,
        kind: 'CONTROLLER_REPLACEMENT_AUTHORIZED',
        masterDeviceId: device.deviceId,
        oldControllerDeviceId,
        expiresAt,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        recoveryCode,
        expiresAt,
        expiresInSeconds: CONTROLLER_REPLACEMENT_TTL_SECONDS,
      });
    }

    if (action === 'controller-replacement-redeem' && req.method === 'POST') {
      if (!(await controllerReplacementRateAllowed(req))) {
        return send(res, 429, { ok: false, code: 'CONTROLLER_REPLACEMENT_RATE_LIMIT' });
      }

      const recoveryCode = String(req.body?.recoveryCode || '');
      const newDeviceId = String(req.body?.deviceId || '').trim();
      const deviceName = String(req.body?.deviceName || 'iPhone contrôleur Zenith').trim().slice(0, 80);

      if (!newDeviceId || normalizeReplacementCode(recoveryCode).length < 12) {
        return send(res, 400, { ok: false, code: 'CONTROLLER_REPLACEMENT_REQUEST_INVALID' });
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = sha256(token);
      const createdAt = Date.now();
      const deviceRecord = {
        deviceId: newDeviceId,
        role: 'controller',
        deviceName,
        createdAt,
        lastSeenAt: createdAt,
      };

      const script = [
        "local recoveryRaw = redis.call('GET', KEYS[1])",
        "if not recoveryRaw then return {0, '', ''} end",
        "local ok, recovery = pcall(cjson.decode, recoveryRaw)",
        "if not ok then return {-2, '', ''} end",
        "local oldController = tostring(recovery['oldControllerDeviceId'] or '')",
        "local currentController = tostring(redis.call('GET', KEYS[2]) or '')",
        "if currentController ~= oldController then",
        "  return {-1, currentController, oldController}",
        "end",
        "redis.call('SET', KEYS[2], ARGV[1])",
        "redis.call('SET', KEYS[3], ARGV[2])",
        "redis.call('DEL', KEYS[1])",
        "return {1, oldController, ARGV[1]}"
      ].join('\n');

      const result = await redis([
        'EVAL', script, '3',
        replacementKey(recoveryCode),
        KEY_CONTROLLER_DEVICE,
        `${PREFIX}:device:${tokenHash}`,
        newDeviceId,
        JSON.stringify(deviceRecord),
      ]);

      const code = Number(Array.isArray(result) ? result[0] : 0);
      if (code === 0) {
        return send(res, 410, { ok: false, code: 'CONTROLLER_REPLACEMENT_CODE_EXPIRED' });
      }
      if (code === -1) {
        return send(res, 409, { ok: false, code: 'CONTROLLER_REPLACEMENT_CONFLICT' });
      }
      if (code !== 1) {
        return send(res, 500, { ok: false, code: 'CONTROLLER_REPLACEMENT_FAILED' });
      }

      const oldControllerDeviceId = String(result[1] || '');

      let quarantined = { pending: 0, processing: 0 };
      try {
        quarantined = await quarantineCommandsForDevice(oldControllerDeviceId);
      } catch {}

      let state = null;
      try {
        const controllerRaw = await redis(['GET', KEY_CONTROLLER_STATE]);
        state = controllerRaw ? JSON.parse(controllerRaw) : null;
      } catch {}

      try {
        await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
          at: Date.now(),
          kind: 'CONTROLLER_REPLACED',
          oldControllerDeviceId,
          newControllerDeviceId: newDeviceId,
          quarantined,
        })]);
        await redis(['LTRIM', KEY_AUDIT, '0', '199']);
      } catch {}

      return send(res, 200, {
        ok: true,
        token,
        device: deviceRecord,
        state,
        previousControllerDeviceId: oldControllerDeviceId,
        quarantined,
      });
    }

    if (action === 'whoami' && req.method === 'GET') {
      const device = await requireDevice(req, res);
      if (!device) return;
      return send(res, 200, {
        ok: true,
        device: {
          deviceId: device.deviceId,
          role: device.role,
          deviceName: device.deviceName || '',
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
        },
      });
    }

    if (action === 'master-authorize' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller']);
      if (!device) return;

      const masterDevice = await roleDeviceId('master');
      if (!masterDevice) {
        return send(res, 409, { ok: false, code: 'MASTER_NOT_REGISTERED' });
      }

      await redis([
        'SET',
        masterActivationKey(masterDevice),
        '1',
        'EX',
        String(MASTER_ACTIVATION_TTL_SECONDS)
      ]);

      const at = Date.now();
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: 'MASTER_ACTIVATION_AUTHORIZED',
        deviceId: device.deviceId,
        masterDeviceId: masterDevice,
        ttlSeconds: MASTER_ACTIVATION_TTL_SECONDS,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        masterDeviceId: masterDevice,
        expiresInSeconds: MASTER_ACTIVATION_TTL_SECONDS,
      });
    }

    if (action === 'master-heartbeat' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;

      const lease = await acquireOrRenewMaster(device.deviceId);
      if (lease.conflict) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_LEASE_CONFLICT',
          currentMaster: await masterDeviceId(),
        });
      }
      if (!lease.authorized) {
        return send(res, 423, {
          ok: false,
          code: 'MASTER_ACTIVATION_REQUIRED',
          currentMaster: await masterDeviceId(),
        });
      }

      let currentMode = await masterMode();
      let pauseTransition = null;
      if (currentMode === 'PAUSE_PENDING') {
        pauseTransition = await tryFinalizePendingPause(device.deviceId, currentMode);
        currentMode = pauseTransition.masterMode;
      }

      const configSync = await readMasterConfigSync(device.deviceId);
      const heartbeat = {
        version: 1,
        at: Date.now(),
        masterDeviceId: device.deviceId,
        masterMode: currentMode,
        controllerRevision: configSync.status.controllerRevision,
        appliedRevision: configSync.status.appliedRevision,
        synchronized: configSync.status.synchronized,
        syncReason: configSync.status.reason,
      };
      await redis([
        'SET', KEY_MASTER_HEARTBEAT, JSON.stringify(heartbeat),
        'EX', String(MASTER_HEARTBEAT_TTL_SECONDS)
      ]);

      return send(res, 200, {
        ok: true,
        master: true,
        acquired: lease.acquired,
        renewed: lease.renewed,
        currentMaster: await masterDeviceId(),
        masterMode: currentMode,
        pauseTransition,
        configSync: configSync.status,
        heartbeat,
        ttlSeconds: MASTER_TTL_SECONDS,
      });
    }

    if (action === 'master' && req.method === 'GET') {
      const device = await requireDevice(req, res);
      if (!device) return;
      return send(res, 200, { ok: true, currentMaster: await masterDeviceId() });
    }

    if (action === 'master-pause' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      if (!MASTER_ADMIN_CODE) {
        return send(res, 503, { ok: false, code: 'MASTER_ADMIN_NOT_CONFIGURED' });
      }
      if (!timingSafeEqualText(String(req.body?.adminCode || ''), MASTER_ADMIN_CODE)) {
        return send(res, 401, { ok: false, code: 'MASTER_ADMIN_CODE_INVALID' });
      }

      const [runtimeRaw, pending, processing] = await Promise.all([
        redis(['GET', KEY_STATE]),
        redis(['LLEN', KEY_PENDING]),
        redis(['LLEN', KEY_PROCESSING]),
      ]);

      let runtimeState = null;
      try { runtimeState = runtimeRaw ? JSON.parse(runtimeRaw) : null; } catch {}
      const activity = inspectRuntimeActivity(runtimeState);
      const hardBlockers = [];
      if (Number(pending || 0) > 0) hardBlockers.push('PENDING_COMMAND');
      if (Number(processing || 0) > 0) hardBlockers.push('PROCESSING_COMMAND');
      if (REAL_TRADING_ENABLED && !runtimeState) hardBlockers.push('RUNTIME_STATE_UNAVAILABLE');
      if (activity.activePositions === 0 && activity.openOrders > 0) hardBlockers.push('OPEN_ORDER_WITHOUT_POSITION');

      if (hardBlockers.length) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_PAUSE_BLOCKED',
          blockers: hardBlockers,
          activity,
          pendingCommands: Number(pending || 0),
          processingCommands: Number(processing || 0),
        });
      }

      const requestedMode = activity.activePositions > 0 ? 'PAUSE_PENDING' : 'PAUSED';
      const script = [
        "if redis.call('LLEN', KEYS[1]) > 0 then return 0 end",
        "if redis.call('LLEN', KEYS[2]) > 0 then return 0 end",
        "redis.call('SET', KEYS[3], ARGV[1])",
        "return 1"
      ].join('\n');
      const armed = Number(await redis([
        'EVAL', script, '3',
        KEY_PENDING, KEY_PROCESSING, KEY_MASTER_MODE,
        requestedMode,
      ])) === 1;

      if (!armed) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_PAUSE_RACE_BLOCKED',
          blockers: ['COMMAND_QUEUE_CHANGED'],
        });
      }

      const at = Date.now();
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: requestedMode === 'PAUSE_PENDING' ? 'MASTER_PAUSE_QUEUED' : 'MASTER_PAUSED',
        deviceId: device.deviceId,
        requestedByRole: device.role,
        activePositions: activity.activePositions,
        openOrders: activity.openOrders,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        masterMode: requestedMode,
        pauseQueued: requestedMode === 'PAUSE_PENDING',
        activity,
        pendingCommands: 0,
        processingCommands: 0,
      });
    }

    if (action === 'master-pause-cancel' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      if (!MASTER_ADMIN_CODE) {
        return send(res, 503, { ok: false, code: 'MASTER_ADMIN_NOT_CONFIGURED' });
      }
      if (!timingSafeEqualText(String(req.body?.adminCode || ''), MASTER_ADMIN_CODE)) {
        return send(res, 401, { ok: false, code: 'MASTER_ADMIN_CODE_INVALID' });
      }

      const [currentMaster, registeredMaster, currentMode] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('master'),
        masterMode(),
      ]);
      if (currentMode !== 'PAUSE_PENDING') {
        return send(res, 409, { ok: false, code: 'MASTER_PAUSE_NOT_PENDING', masterMode: currentMode });
      }
      if (!currentMaster || !registeredMaster || String(currentMaster) !== String(registeredMaster)) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_LEASE_REQUIRED',
          currentMaster,
          registeredMaster,
        });
      }
      if (device.role === 'master' && String(currentMaster) !== String(device.deviceId)) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }

      const mode = await setMasterMode('RUNNING');
      const at = Date.now();
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: 'MASTER_PAUSE_CANCELLED',
        deviceId: device.deviceId,
        requestedByRole: device.role,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, { ok: true, masterMode: mode });
    }

    if (action === 'master-resume' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      if (!MASTER_ADMIN_CODE) {
        return send(res, 503, { ok: false, code: 'MASTER_ADMIN_NOT_CONFIGURED' });
      }
      if (!timingSafeEqualText(String(req.body?.adminCode || ''), MASTER_ADMIN_CODE)) {
        return send(res, 401, { ok: false, code: 'MASTER_ADMIN_CODE_INVALID' });
      }
      const [currentMaster, registeredMaster] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('master'),
      ]);
      if (!currentMaster) {
        return send(res, 409, { ok: false, code: 'MASTER_LEASE_REQUIRED' });
      }
      if (!registeredMaster || String(currentMaster) !== String(registeredMaster)) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_LEASE_CONFLICT',
          currentMaster,
          registeredMaster,
        });
      }
      if (device.role === 'master' && String(currentMaster) !== String(device.deviceId)) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }

      const [controllerRaw, pending, processing] = await Promise.all([
        redis(['GET', KEY_CONTROLLER_STATE]),
        redis(['LLEN', KEY_PENDING]),
        redis(['LLEN', KEY_PROCESSING]),
      ]);

      const blockers = [];
      if (!controllerRaw) blockers.push('NO_CONTROLLER_STATE');
      if (Number(pending || 0) > 0) blockers.push('PENDING_COMMAND');
      if (Number(processing || 0) > 0) blockers.push('PROCESSING_COMMAND');

      const configSync = await readMasterConfigSync(currentMaster);
      if (!configSync.status.synchronized) blockers.push('MASTER_CONFIG_OUT_OF_SYNC');
      const heartbeatRaw = await redis(['GET', KEY_MASTER_HEARTBEAT]);
      const heartbeat = heartbeatStatus(heartbeatRaw, currentMaster);
      if (!heartbeat.fresh) blockers.push('MASTER_HEARTBEAT_STALE');

      let reconciliation = null;
      if (REAL_TRADING_ENABLED) {
        reconciliation = await freshCleanReconciliation();
        if (!reconciliation.ok) blockers.push(reconciliation.reason);
      }

      if (blockers.length) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_RESUME_BLOCKED',
          blockers,
          pendingCommands: Number(pending || 0),
          processingCommands: Number(processing || 0),
        });
      }

      const mode = await setMasterMode('RUNNING');
      const at = Date.now();
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: 'MASTER_RESUMED',
        deviceId: device.deviceId,
        requestedByRole: device.role,
        realTradingEnabled: REAL_TRADING_ENABLED,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        masterMode: mode,
        executionMode: REAL_TRADING_ENABLED ? 'REAL_ARMED_BY_ENV' : 'SIMULATION_LOCKED',
      });
    }

    if (action === 'safety' && req.method === 'GET') {
      const device = await requireDevice(req, res);
      if (!device) return;

      const [currentMaster, controllerDevice, masterDevice, pending, processing, controllerRaw, emergencyStop, currentMasterMode] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('controller'),
        roleDeviceId('master'),
        redis(['LLEN', KEY_PENDING]),
        redis(['LLEN', KEY_PROCESSING]),
        redis(['GET', KEY_CONTROLLER_STATE]),
        emergencyStopActive(),
        masterMode(),
      ]);

      let controllerRevision = 0;
      let controllerUpdatedAt = 0;
      let controllerStateHash = '';
      try {
        const parsed = controllerRaw ? JSON.parse(controllerRaw) : null;
        controllerRevision = Number(parsed?.revision || 0);
        controllerUpdatedAt = Number(parsed?.updatedAt || 0);
        controllerStateHash = String(parsed?.stateHash || '');
      } catch {}

      const configSync = await readMasterConfigSync(currentMaster || masterDevice || '');
      const heartbeatRaw = await redis(['GET', KEY_MASTER_HEARTBEAT]);
      const heartbeat = heartbeatStatus(heartbeatRaw, currentMaster || masterDevice || '');

      return send(res, 200, {
        ok: true,
        executionMode: REAL_TRADING_ENABLED ? 'REAL_ARMED_BY_ENV' : 'SIMULATION_LOCKED',
        realTradingEnabled: REAL_TRADING_ENABLED,
        emergencyStopActive: Boolean(emergencyStop),
        masterLeaseActive: Boolean(currentMaster),
        currentMaster,
        masterMode: currentMasterMode,
        controllerRegistered: Boolean(controllerDevice),
        masterRegistered: Boolean(masterDevice),
        pendingCommands: Number(pending || 0),
        processingCommands: Number(processing || 0),
        controllerRevision,
        controllerUpdatedAt,
        controllerStateHash,
        masterAppliedRevision: configSync.status.appliedRevision,
        masterAppliedAt: configSync.status.appliedAt,
        masterSyncStatus: configSync.status.reason,
        masterSyncFailClosed: configSync.status.failClosed,
        masterConfigApplyAllowed: configSync.status.applyAllowed,
        masterConfigApplyDeferred: configSync.status.applyDeferred,
        masterHeartbeatAt: heartbeat.at,
        masterHeartbeatAgeMs: heartbeat.ageMs,
        masterHeartbeatFresh: heartbeat.fresh,
        commandClaimTtlMs: COMMAND_CLAIM_TTL_MS,
      });
    }


    if (action === 'master-preflight' && req.method === 'GET') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;

      const [currentMaster, controllerRaw, emergencyStop, pending, processing, currentMasterMode] = await Promise.all([
        masterDeviceId(),
        redis(['GET', KEY_CONTROLLER_STATE]),
        emergencyStopActive(),
        redis(['LLEN', KEY_PENDING]),
        redis(['LLEN', KEY_PROCESSING]),
        masterMode(),
      ]);

      let controllerState = null;
      try { controllerState = controllerRaw ? JSON.parse(controllerRaw) : null; } catch {}

      const canAcquireLease = !currentMaster || currentMaster === device.deviceId;
      const reasons = [];
      if (!controllerState) reasons.push('NO_CONTROLLER_STATE');
      if (!emergencyStop) reasons.push('EMERGENCY_STOP_NOT_ACTIVE');
      if (REAL_TRADING_ENABLED) reasons.push('REAL_TRADING_ENV_ARMED');
      if (!canAcquireLease) reasons.push('MASTER_LEASE_CONFLICT');

      return send(res, 200, {
        ok: true,
        readyForStandby: reasons.length === 0,
        canAcquireLease,
        controllerRevision: Number(controllerState?.revision || 0),
        controllerStateHash: String(controllerState?.stateHash || ''),
        emergencyStopActive: Boolean(emergencyStop),
        realTradingEnabled: REAL_TRADING_ENABLED,
        executionMode: REAL_TRADING_ENABLED ? 'REAL_ARMED_BY_ENV' : 'SIMULATION_LOCKED',
        currentMaster,
        masterMode: currentMasterMode,
        pendingCommands: Number(pending || 0),
        processingCommands: Number(processing || 0),
        reasons,
      });
    }

    if (action === 'master-config-status' && req.method === 'GET') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const configSync = await readMasterConfigSync(device.deviceId);
      return send(res, 200, {
        ok: true,
        controllerState: configSync.controllerState,
        appliedState: configSync.appliedState,
        ...configSync.status,
      });
    }

    if (action === 'master-config-ack' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }

      const configSync = await readMasterConfigSync(device.deviceId);
      if (!configSync.controllerState) {
        return send(res, 409, { ok: false, code: 'NO_CONTROLLER_STATE' });
      }
      if (configSync.status.activity.activePositions > 0 || configSync.status.activity.openOrders > 0) {
        return send(res, 423, {
          ok: false,
          code: 'MASTER_CONFIG_APPLY_DEFERRED',
          activity: configSync.status.activity,
        });
      }

      const revision = Number(req.body?.revision);
      const stateHash = String(req.body?.stateHash || '');
      if (!Number.isInteger(revision) || revision <= 0 || !stateHash) {
        return send(res, 400, { ok: false, code: 'MASTER_CONFIG_ACK_INVALID' });
      }
      if (revision !== configSync.status.controllerRevision || stateHash !== configSync.status.controllerStateHash) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_CONFIG_REVISION_CHANGED',
          controllerRevision: configSync.status.controllerRevision,
          controllerStateHash: configSync.status.controllerStateHash,
        });
      }

      const applied = {
        version: 1,
        revision,
        stateHash,
        appliedAt: Date.now(),
        masterDeviceId: device.deviceId,
      };
      await redis(['SET', KEY_MASTER_CONFIG_ACK, JSON.stringify(applied)]);
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at: applied.appliedAt,
        kind: 'MASTER_CONFIG_APPLIED',
        deviceId: device.deviceId,
        revision,
        stateHash,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        applied,
        synchronized: true,
        controllerRevision: revision,
        appliedRevision: revision,
      });
    }

    if (action === 'controller-state' && req.method === 'GET') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;
      const raw = await redis(['GET', KEY_CONTROLLER_STATE]);
      let state = null;
      try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
      return send(res, 200, { ok: true, state });
    }

    if (action === 'controller-state' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller']);
      if (!device) return;

      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        return send(res, 400, { ok: false, code: 'EXPECTED_REVISION_REQUIRED' });
      }

      const data = req.body?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return send(res, 400, { ok: false, code: 'CONTROLLER_STATE_INVALID' });
      }

      const safeData = {
        settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
        tokenSettings: data.tokenSettings && typeof data.tokenSettings === 'object' ? data.tokenSettings : {},
        manualTokens: data.manualTokens && typeof data.manualTokens === 'object' ? data.manualTokens : {},
        validated: data.validated && typeof data.validated === 'object' ? data.validated : {},
      };
      if (JSON.stringify(safeData).length > 250000) {
        return send(res, 413, { ok: false, code: 'CONTROLLER_STATE_TOO_LARGE' });
      }

      const updatedAt = Date.now();
      const stateHash = sha256(JSON.stringify(safeData));
      const snapshotTemplate = {
        version: 1,
        revision: 0,
        updatedAt,
        controllerDeviceId: device.deviceId,
        stateHash,
        data: safeData,
      };
      const auditTemplate = {
        at: updatedAt,
        kind: 'CONTROLLER_STATE_WRITE',
        revision: 0,
        deviceId: device.deviceId,
        stateHash,
      };

      const script = [
        "local currentRaw = redis.call('GET', KEYS[1])",
        "local currentRev = 0",
        "if currentRaw then",
        "  local ok, current = pcall(cjson.decode, currentRaw)",
        "  if ok and current and current['revision'] then currentRev = tonumber(current['revision']) or 0 end",
        "end",
        "local expected = tonumber(ARGV[1])",
        "if currentRev ~= expected then",
        "  return {0, tostring(currentRev), currentRaw or ''}",
        "end",
        "local newRev = currentRev + 1",
        "local snapshot = cjson.decode(ARGV[2])",
        "snapshot['revision'] = newRev",
        "local snapshotRaw = cjson.encode(snapshot)",
        "local audit = cjson.decode(ARGV[3])",
        "audit['revision'] = newRev",
        "local auditRaw = cjson.encode(audit)",
        "redis.call('SET', KEYS[1], snapshotRaw)",
        "redis.call('SET', KEYS[2], tostring(newRev))",
        "redis.call('LPUSH', KEYS[3], auditRaw)",
        "redis.call('LTRIM', KEYS[3], 0, 199)",
        "return {1, tostring(newRev), snapshotRaw}"
      ].join('\n');

      const result = await redis([
        'EVAL', script, '3',
        KEY_CONTROLLER_STATE, KEY_CONTROLLER_REV, KEY_AUDIT,
        String(expectedRevision),
        JSON.stringify(snapshotTemplate),
        JSON.stringify(auditTemplate),
      ]);

      const applied = Number(Array.isArray(result) ? result[0] : 0) === 1;
      const currentRevision = Number(Array.isArray(result) ? result[1] : 0) || 0;
      const rawState = String(Array.isArray(result) ? result[2] || '' : '');

      let state = null;
      try { state = rawState ? JSON.parse(rawState) : null; } catch {}

      if (!applied) {
        return send(res, 409, {
          ok: false,
          code: 'REVISION_CONFLICT',
          currentRevision,
          state,
        });
      }

      return send(res, 200, { ok: true, state });
    }

    if (action === 'state' && req.method === 'GET') {
      const device = await requireDevice(req, res);
      if (!device) return;
      const raw = await redis(['GET', KEY_STATE]);
      let state = null;
      try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
      return send(res, 200, { ok: true, state });
    }

    if (action === 'state' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const snapshot = {
        version: 1,
        updatedAt: Date.now(),
        masterDeviceId: device.deviceId,
        data: req.body?.data ?? null,
      };
      await redis(['SET', KEY_STATE, JSON.stringify(snapshot)]);
      return send(res, 200, { ok: true, state: snapshot });
    }

    if (action === 'command' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller']);
      if (!device) return;

      const type = String(req.body?.type || '').trim().toUpperCase();
      const clientCommandId = String(req.body?.clientCommandId || '').trim();

      if (!/^[A-Z0-9_:-]{1,64}$/.test(type)) {
        return send(res, 400, { ok: false, code: 'COMMAND_TYPE_INVALID' });
      }
      const modeAtSubmit = await masterMode();
      if (modeAtSubmit === 'PAUSED') {
        return send(res, 423, { ok: false, code: 'MASTER_PAUSED', masterMode: modeAtSubmit });
      }
      const allowedWhilePending = commandAllowedDuringPausePending(type);
      if (modeAtSubmit === 'PAUSE_PENDING' && !allowedWhilePending) {
        return send(res, 423, { ok: false, code: 'MASTER_PAUSE_PENDING', masterMode: modeAtSubmit });
      }
      const activeMaster = await masterDeviceId();
      const configSync = await readMasterConfigSync(activeMaster);
      if (!configSync.status.synchronized && !allowedWhilePending) {
        return send(res, 423, {
          ok: false,
          code: 'MASTER_CONFIG_OUT_OF_SYNC',
          masterSyncStatus: configSync.status.reason,
          controllerRevision: configSync.status.controllerRevision,
          appliedRevision: configSync.status.appliedRevision,
        });
      }
      if (type.startsWith('EXEC_')) {
        const halted = await emergencyStopActive();
        if (!REAL_TRADING_ENABLED || halted) {
          return send(res, 423, {
            ok: false,
            code: 'EXECUTION_LOCKED',
            realTradingEnabled: REAL_TRADING_ENABLED,
            emergencyStopActive: halted,
          });
        }
      }
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientCommandId)) {
        return send(res, 400, { ok: false, code: 'CLIENT_COMMAND_ID_REQUIRED' });
      }

      const payload = req.body?.payload ?? null;
      if (JSON.stringify(payload).length > 100000) {
        return send(res, 413, { ok: false, code: 'COMMAND_PAYLOAD_TOO_LARGE' });
      }

      const command = {
        id: crypto.randomUUID(),
        clientCommandId,
        createdAt: Date.now(),
        deviceId: device.deviceId,
        type,
        payload,
      };
      const raw = JSON.stringify(command);
      const dedupeKey = `${PREFIX}:command:client:${device.deviceId}:${sha256(clientCommandId)}`;

      const script = [
        "local mode = tostring(redis.call('GET', KEYS[3]) or 'PAUSED')",
        "if mode == 'PAUSED' then return {-2, mode} end",
        "if mode == 'PAUSE_PENDING' and ARGV[4] ~= '1' then return {-3, mode} end",
        "local existing = redis.call('GET', KEYS[1])",
        "if existing then return {0, existing} end",
        "redis.call('LPUSH', KEYS[2], ARGV[2])",
        "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])",
        "return {1, ARGV[1]}"
      ].join('\n');

      const result = await redis([
        'EVAL', script, '3',
        dedupeKey, KEY_PENDING, KEY_MASTER_MODE,
        command.id, raw, String(COMMAND_DEDUPE_TTL_SECONDS),
        allowedWhilePending ? '1' : '0'
      ]);

      const resultCode = Number(Array.isArray(result) ? result[0] : -99);
      if (resultCode === -2) {
        return send(res, 423, { ok: false, code: 'MASTER_PAUSED', masterMode: 'PAUSED' });
      }
      if (resultCode === -3) {
        return send(res, 423, { ok: false, code: 'MASTER_PAUSE_PENDING', masterMode: 'PAUSE_PENDING' });
      }

      const created = resultCode === 1;
      const commandId = String(Array.isArray(result) ? result[1] : command.id);
      return send(res, created ? 202 : 200, {
        ok: true,
        commandId,
        duplicate: !created,
      });
    }

    if (action === 'command-next' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const currentMode = await masterMode();
      if (currentMode === 'PAUSED') {
        return send(res, 423, { ok: false, code: 'MASTER_PAUSED', masterMode: currentMode });
      }

      const configSync = await readMasterConfigSync(device.deviceId);
      const recovery = await recoverStaleProcessing(device.deviceId);
      const raw = await claimNextCommand(device.deviceId);
      if (!raw) return send(res, 200, { ok: true, command: null, recovery });
      if (raw === '__DEAD__') {
        return send(res, 500, { ok: false, code: 'COMMAND_CORRUPT', recovery });
      }

      let command = null;
      try { command = JSON.parse(raw); } catch {}

      if (!configSync.status.synchronized && !commandAllowedDuringPausePending(command?.type)) {
        await redis(['LREM', KEY_PROCESSING, '1', raw]);
        await redis(['LPUSH', KEY_DEAD, JSON.stringify({
          raw,
          rejectedAt: Date.now(),
          rejectedReason: 'MASTER_CONFIG_OUT_OF_SYNC',
          controllerRevision: configSync.status.controllerRevision,
          appliedRevision: configSync.status.appliedRevision,
        })]);
        return send(res, 200, {
          ok: true,
          command: null,
          syncRejected: true,
          masterSyncStatus: configSync.status.reason,
          recovery,
        });
      }

      if (currentMode === 'PAUSE_PENDING' && !commandAllowedDuringPausePending(command?.type)) {
        await redis(['LREM', KEY_PROCESSING, '1', raw]);
        await redis(['LPUSH', KEY_DEAD, JSON.stringify({
          raw,
          rejectedAt: Date.now(),
          rejectedReason: 'MASTER_PAUSE_PENDING_UNSAFE_COMMAND',
        })]);
        return send(res, 200, {
          ok: true,
          command: null,
          pausePendingRejected: true,
          recovery,
        });
      }

      const currentController = await roleDeviceId('controller');
      if (!command || String(command.deviceId || '') !== String(currentController || '')) {
        await redis(['LREM', KEY_PROCESSING, '1', raw]);
        await redis(['LPUSH', KEY_DEAD, JSON.stringify({
          raw,
          rejectedAt: Date.now(),
          rejectedReason: 'STALE_CONTROLLER_COMMAND',
          currentControllerDeviceId: currentController,
        })]);
        return send(res, 200, {
          ok: true,
          command: null,
          staleRejected: true,
          recovery,
        });
      }

      return send(res, 200, { ok: true, command, raw, recovery });
    }

    if (action === 'command-recover-stale' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const recovery = await recoverStaleProcessing(device.deviceId);
      return send(res, 200, { ok: true, recovery });
    }

    if (action === 'command-ack' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const raw = String(req.body?.raw || '');
      if (!raw) return send(res, 400, { ok: false, code: 'RAW_REQUIRED' });
      let commandId = '';
      try { commandId = String(JSON.parse(raw)?.id || ''); } catch {}
      if (commandId) {
        await redis(['SET', `${PREFIX}:command:done:${commandId}`, String(Date.now()), 'EX', String(60 * 60 * 24 * 30)]);
      }
      await redis(['LREM', KEY_PROCESSING, '1', raw]);
      return send(res, 200, { ok: true });
    }

    if (action === 'command-requeue' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const raw = String(req.body?.raw || '');
      if (!raw) return send(res, 400, { ok: false, code: 'RAW_REQUIRED' });

      let commandId = '';
      try { commandId = String(JSON.parse(raw)?.id || ''); } catch {}
      if (commandId) {
        const done = await redis(['GET', `${PREFIX}:command:done:${commandId}`]);
        if (done) {
          await redis(['LREM', KEY_PROCESSING, '1', raw]);
          return send(res, 200, { ok: true, requeued: false, alreadyDone: true });
        }
      }

      const removed = await redis(['LREM', KEY_PROCESSING, '1', raw]);
      if (Number(removed) > 0) await redis(['LPUSH', KEY_PENDING, raw]);
      return send(res, 200, { ok: true, requeued: Number(removed) > 0 });
    }

    if (action === 'emergency-stop' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      const at = Date.now();
      await redis(['SET', KEY_EMERGENCY_STOP, '1']);
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: 'EMERGENCY_STOP_SET',
        deviceId: device.deviceId,
        role: device.role,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        emergencyStopActive: true,
        executionMode: 'STOPPED',
      });
    }

    if (action === 'audit' && req.method === 'GET') {
      const device = await requireDevice(req, res);
      if (!device) return;

      const requested = Math.max(1, Math.min(50, Number(req.query?.limit || 20)));
      const rows = await redis(['LRANGE', KEY_AUDIT, '0', String(requested - 1)]);
      const events = [];
      for (const raw of Array.isArray(rows) ? rows : []) {
        try { events.push(JSON.parse(raw)); } catch {}
      }
      return send(res, 200, { ok: true, events });
    }

    return send(res, 404, { ok: false, code: 'UNKNOWN_ACTION' });
  } catch (e) {
    return send(res, 500, {
      ok: false,
      code: e?.code || 'SYNC_ERROR',
      error: e?.message || 'Zenith sync error',
    });
  }
}
