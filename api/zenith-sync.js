import crypto from 'node:crypto';
import { deviceTokenCandidates, setDeviceSessionCookie, clearDeviceSessionCookie, sameOriginMutation } from '../lib/device-session.mjs';
import { normalizeProtectiveUpdatePayload, protectionOnlyMismatchTarget, protectiveRepairTarget } from '../lib/protective-command.mjs';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';

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
const BINANCE_WRITE_ENABLED = process.env.ZENITH_BINANCE_WRITE_ENABLED === '1';

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
const KEY_REAL_EXECUTION_ARMED = `${PREFIX}:safety:real-execution-armed`;
const KEY_MASTER_MODE = `${PREFIX}:master-mode`;
const DEPLOYMENT_SHA = String(process.env.VERCEL_GIT_COMMIT_SHA || '');
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
const MASTER_ADMIN_FAILURE_LIMIT = 5;
const MASTER_ADMIN_LOCK_SECONDS = 15 * 60;
const RUNTIME_STATE_STALE_MS = 30 * 1000;
const COMMAND_MAX_AGE_MS = 2 * 60 * 1000;
const COMMAND_QUEUE_MAX = 100;
const COMMAND_PAYLOAD_MAX_BYTES = 16 * 1024;
const DEAD_LETTER_MAX = 500;

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

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(item => item === undefined ? 'null' : stableStringify(item)).join(',') + ']';
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = stableStringify(value[key]);
    if (encoded !== undefined) parts.push(JSON.stringify(key) + ':' + encoded);
  }
  return '{' + parts.join(',') + '}';
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

function masterAdminFailureKey(device) {
  const identity = String(device?.tokenHash || device?.deviceId || 'unknown');
  return `${PREFIX}:master-admin-fail:${sha256(identity)}`;
}

async function verifyMasterAdminCode(req, res, device) {
  if (!MASTER_ADMIN_CODE) {
    send(res, 503, { ok: false, code: 'MASTER_ADMIN_NOT_CONFIGURED' });
    return false;
  }

  const key = masterAdminFailureKey(device);
  const existing = Number(await redis(['GET', key])) || 0;
  if (existing >= MASTER_ADMIN_FAILURE_LIMIT) {
    const ttl = Number(await redis(['TTL', key])) || MASTER_ADMIN_LOCK_SECONDS;
    send(res, 429, { ok: false, code: 'MASTER_ADMIN_LOCKED', retryAfterSeconds: Math.max(1, ttl) });
    return false;
  }

  const supplied = String(req.body?.adminCode || '');
  if (!timingSafeEqualText(supplied, MASTER_ADMIN_CODE)) {
    const failures = Number(await redis(['INCR', key])) || 0;
    if (failures === 1) await redis(['EXPIRE', key, String(MASTER_ADMIN_LOCK_SECONDS)]);
    if (failures >= MASTER_ADMIN_FAILURE_LIMIT) {
      send(res, 429, { ok: false, code: 'MASTER_ADMIN_LOCKED', retryAfterSeconds: MASTER_ADMIN_LOCK_SECONDS });
    } else {
      send(res, 401, { ok: false, code: 'MASTER_ADMIN_CODE_INVALID', attemptsRemaining: Math.max(0, MASTER_ADMIN_FAILURE_LIMIT - failures) });
    }
    return false;
  }

  await redis(['DEL', key]);
  return true;
}

function normalizeReplacementCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function replacementKey(code) {
  return `${PREFIX}:controller-replacement:${sha256(normalizeReplacementCode(code))}`;
}

async function pushDeadLetter(entry) {
  const raw = typeof entry === 'string' ? entry : JSON.stringify(entry);
  await redis(['LPUSH', KEY_DEAD, raw]);
  await redis(['LTRIM', KEY_DEAD, '0', String(DEAD_LETTER_MAX - 1)]);
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
        await pushDeadLetter(dead);
        if (label === 'pending') pending += removed;
        else processing += removed;
      }
    }
  }

  return { pending, processing };
}

async function authDevice(req) {
  for (const token of deviceTokenCandidates(req)) {
    const hash = sha256(token);
    const raw = await redis(['GET', `${PREFIX}:device:${hash}`]);
    if (!raw) continue;
    try {
      const device = JSON.parse(raw);
      if (!device?.deviceId || !['controller', 'master'].includes(device?.role)) continue;
      return { ...device, tokenHash: hash, sessionToken: token };
    } catch {}
  }
  return null;
}

function roleDeviceKey(role) {
  return role === 'master' ? KEY_MASTER_DEVICE : KEY_CONTROLLER_DEVICE;
}

async function claimRoleDevice(role, deviceId) {
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

async function verifyRoleDevice(role, deviceId) {
  const current = await redis(['GET', roleDeviceKey(role)]);
  return Boolean(current) && String(current) === String(deviceId);
}

async function roleDeviceId(role) {
  const value = await redis(['GET', roleDeviceKey(role)]);
  return value ? String(value) : '';
}

async function touchDevice(device) {
  if (!device?.tokenHash) return;
  const updated = { ...device, lastSeenAt: Date.now() };
  delete updated.tokenHash;
  delete updated.sessionToken;
  await redis(['SET', `${PREFIX}:device:${device.tokenHash}`, JSON.stringify(updated)]);
}

async function requireDevice(req, res, roles) {
  const device = await authDevice(req);
  if (!device) {
    clearDeviceSessionCookie(res);
    send(res, 401, { ok: false, code: 'UNAUTHORIZED_DEVICE' });
    return null;
  }
  if (roles && !roles.includes(device.role)) {
    send(res, 403, { ok: false, code: 'ROLE_FORBIDDEN' });
    return null;
  }
  if (!(await verifyRoleDevice(device.role, device.deviceId))) {
    send(res, 409, { ok: false, code: 'ROLE_DEVICE_CONFLICT' });
    return null;
  }
  await touchDevice(device);
  setDeviceSessionCookie(res, device.sessionToken);
  const safeDevice = { ...device };
  delete safeDevice.sessionToken;
  return safeDevice;
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

async function realExecutionArmStatus(expectedMasterDeviceId = '') {
  const raw = await redis(['GET', KEY_REAL_EXECUTION_ARMED]);
  const record = parseStoredJson(raw);
  if (!record || record.version !== 1) return { armed:false, reason:'REAL_EXECUTION_NOT_ARMED', record:null };
  if (!REAL_TRADING_ENABLED) return { armed:false, reason:'REAL_TRADING_DISABLED', record };
  if (!BINANCE_WRITE_ENABLED) return { armed:false, reason:'BINANCE_WRITE_DISABLED', record };
  if (!DEPLOYMENT_SHA) return { armed:false, reason:'REAL_EXECUTION_DEPLOYMENT_SHA_MISSING', record };
  if (expectedMasterDeviceId && String(record.masterDeviceId || '') !== String(expectedMasterDeviceId)) {
    return { armed:false, reason:'REAL_EXECUTION_ARM_MASTER_CHANGED', record };
  }
  if (DEPLOYMENT_SHA && String(record.deploymentSha || '') !== DEPLOYMENT_SHA) {
    return { armed:false, reason:'REAL_EXECUTION_ARM_DEPLOYMENT_CHANGED', record };
  }
  return { armed:true, reason:'REAL_EXECUTION_ARMED', record };
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

const ALLOWED_COMMAND_TYPES = new Set([
  'UPDATE_EXIT',
  'UPDATE_PROTECTION',
  'CLOSE_POSITION',
  'CANCEL_ENTRY',
  'EXEC_UPDATE_EXIT',
  'EXEC_UPDATE_PROTECTION',
  'EXEC_CLOSE_POSITION',
  'EXEC_CANCEL_ENTRY',
]);

const PROTECTIVE_EXEC_COMMANDS = new Set([
  'EXEC_UPDATE_EXIT',
  'EXEC_UPDATE_PROTECTION',
  'EXEC_CLOSE_POSITION',
  'EXEC_CANCEL_ENTRY',
]);

function commandTypeAllowed(type) {
  return ALLOWED_COMMAND_TYPES.has(String(type || '').toUpperCase());
}

function execClosePayloadStatus(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok:false, reason:'PAYLOAD_OBJECT_REQUIRED' };
  const symbol = String(payload.symbol || '').toUpperCase();
  const direction = String(payload.direction || '').toUpperCase();
  const quantity = Number(payload.quantity);
  const exitMode = String(payload.exitMode || 'PROTECTIVE_IOC').toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) return { ok:false, reason:'SYMBOL_INVALID' };
  if (!['LONG','SHORT'].includes(direction)) return { ok:false, reason:'DIRECTION_INVALID' };
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok:false, reason:'QUANTITY_INVALID' };
  if (payload.closeAll !== true) return { ok:false, reason:'CLOSE_ALL_REQUIRED' };
  if (!['PROTECTIVE_IOC','MARKET_LAST_RESORT'].includes(exitMode)) return { ok:false, reason:'EXIT_MODE_INVALID' };
  return { ok:true, symbol, direction, quantity, exitMode, closeAll:true };
}

function runtimeClosePositionQuantity(runtimeState, symbol, direction) {
  const positions = Array.isArray(runtimeState?.data?.binancePositions) ? runtimeState.data.binancePositions : [];
  const sym = String(symbol || '').toUpperCase();
  const dir = String(direction || '').toUpperCase();
  for (const position of positions) {
    if (String(position?.symbol || '').toUpperCase() !== sym) continue;
    const side = String(position?.positionSide || 'BOTH').toUpperCase();
    const amount = Number(position?.positionAmt ?? position?.quantity ?? 0);
    const actualDirection = side === 'LONG' || side === 'SHORT' ? side : amount < 0 ? 'SHORT' : 'LONG';
    if (actualDirection === dir) return Math.abs(Number.isFinite(amount) ? amount : 0);
  }
  return 0;
}

function execUpdatePayloadStatus(type, payload) {
  try {
    const normalized = normalizeProtectiveUpdatePayload(type, payload);
    return { ok:true, ...normalized };
  } catch (e) {
    return { ok:false, reason:String(e?.message || 'PROTECTIVE_UPDATE_PAYLOAD_INVALID') };
  }
}

function runtimePositionRecord(runtimeState, symbol, direction) {
  const positions = Array.isArray(runtimeState?.data?.binancePositions) ? runtimeState.data.binancePositions : [];
  const sym = String(symbol || '').toUpperCase();
  const dir = String(direction || '').toUpperCase();
  return positions.find(position => {
    if (String(position?.symbol || '').toUpperCase() !== sym) return false;
    const amount = Number(position?.positionAmt ?? position?.quantity ?? 0);
    const side = String(position?.positionSide || 'BOTH').toUpperCase();
    const actualDirection = side === 'LONG' || side === 'SHORT' ? side : amount < 0 ? 'SHORT' : 'LONG';
    return actualDirection === dir && Math.abs(Number.isFinite(amount) ? amount : 0) > 0;
  }) || null;
}

function runtimeOpenOrder(runtimeState, predicate) {
  const orders = Array.isArray(runtimeState?.data?.binanceOrders) ? runtimeState.data.binanceOrders : [];
  return orders.find(predicate) || null;
}

function numberMatches(a, b) {
  const aa = Number(a), bb = Number(b);
  if (!Number.isFinite(aa) || !Number.isFinite(bb)) return false;
  return Math.abs(aa - bb) <= Math.max(1e-9, Math.abs(bb) * 1e-10);
}

function runtimeEmergencyProtection(runtimeState, symbol, direction, entryPrice, quantity, excludeClientAlgoId = '') {
  const sym = String(symbol || '').toUpperCase();
  const dir = String(direction || '').toUpperCase();
  const expectedSide = dir === 'LONG' ? 'SELL' : 'BUY';
  const entry = Number(entryPrice);
  const qty = Math.abs(Number(quantity));
  if (!(entry > 0) || !(qty > 0)) return null;
  return runtimeOpenOrder(runtimeState, order => {
    if (String(order?.orderClass || '').toUpperCase() !== 'ALGO') return false;
    if (String(order?.symbol || '').toUpperCase() !== sym) return false;
    if (String(order?.side || '').toUpperCase() !== expectedSide) return false;
    if (String(order?.positionSide || 'BOTH').toUpperCase() !== 'BOTH') return false;
    if (String(order?.type || '').toUpperCase() !== 'STOP_MARKET') return false;
    if (!(order?.closePosition === true || order?.closePosition === 'true')) return false;
    if (excludeClientAlgoId && String(order?.clientAlgoId || '') === String(excludeClientAlgoId)) return false;
    const trigger = Number(order?.triggerPrice ?? order?.stopPrice);
    if (!(trigger > 0)) return false;
    const lossSide = dir === 'LONG' ? trigger < entry : trigger > entry;
    if (!lossSide) return false;
    const impliedLossUsd = dir === 'LONG'
      ? (entry - trigger) * qty
      : (trigger - entry) * qty;
    return impliedLossUsd <= REAL_RISK_LIMITS.maxLossUsd + 1e-8;
  });
}

function commandExpired(command, now = Date.now()) {
  const createdAt = Number(command?.createdAt || 0);
  const expiresAt = Number(command?.expiresAt || 0);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt <= 0 || expiresAt <= createdAt) return true;
  return now > expiresAt || now - createdAt > COMMAND_MAX_AGE_MS;
}

function executionGate(type, halted) {
  const normalized = String(type || '').toUpperCase();
  if (!normalized.startsWith('EXEC_')) return { allowed: true, reason: '' };
  if (!REAL_TRADING_ENABLED) return { allowed: false, reason: 'REAL_TRADING_DISABLED' };
  if (!BINANCE_WRITE_ENABLED) return { allowed: false, reason: 'BINANCE_WRITE_DISABLED' };
  if (!PAIRING_DISABLED) return { allowed: false, reason: 'PAIRING_OPEN' };
  if (halted && !PROTECTIVE_EXEC_COMMANDS.has(normalized)) {
    return { allowed: false, reason: 'EMERGENCY_STOP_ACTIVE' };
  }
  return { allowed: true, reason: '' };
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

function runtimeSnapshotStatus(snapshot, expectedMasterDeviceId = '', maxAgeMs = RUNTIME_STATE_STALE_MS) {
  const present = Boolean(snapshot?.data && typeof snapshot.data === 'object');
  const ageMs = Date.now() - Number(snapshot?.updatedAt || 0);
  const identityMatches = !expectedMasterDeviceId || String(snapshot?.masterDeviceId || '') === String(expectedMasterDeviceId);
  const fresh = present && identityMatches && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
  const reason = !present
    ? 'MASTER_RUNTIME_UNAVAILABLE'
    : !identityMatches
      ? 'MASTER_RUNTIME_WRONG_DEVICE'
      : !fresh
        ? 'MASTER_RUNTIME_STALE'
        : 'MASTER_RUNTIME_FRESH';
  return { present, identityMatches, fresh, ageMs: Number.isFinite(ageMs) ? ageMs : null, reason };
}

function parseStoredJson(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function masterConfigSyncStatus(controllerState, appliedState, runtimeState, expectedMasterDeviceId = '', runtimeRequired = REAL_TRADING_ENABLED) {
  const controllerRevision = Number(controllerState?.revision || 0);
  const controllerStateHash = String(controllerState?.stateHash || '');
  const appliedRevision = Number(appliedState?.revision || 0);
  const appliedStateHash = String(appliedState?.stateHash || '');
  const appliedMasterDeviceId = String(appliedState?.masterDeviceId || '');
  const activity = inspectRuntimeActivity(runtimeState);
  const controllerPresent = controllerRevision > 0 && Boolean(controllerStateHash);
  const masterIdentityMatches = !expectedMasterDeviceId || appliedMasterDeviceId === String(expectedMasterDeviceId);
  const configMatched = controllerPresent &&
    appliedRevision === controllerRevision &&
    appliedStateHash === controllerStateHash &&
    masterIdentityMatches;

  const runtime = runtimeSnapshotStatus(runtimeState, expectedMasterDeviceId);
  const runtimePresent = runtime.present;
  const runtimeAgeMs = runtime.ageMs;
  const runtimeFresh = runtime.fresh;
  const runtimeFailClosed = Boolean(runtimeRequired && !runtimeFresh);
  const runtimeReason = runtimeFailClosed ? runtime.reason : '';

  const synchronized = configMatched && !runtimeFailClosed;
  const needsApply = controllerPresent && !configMatched;
  const applyDeferred = needsApply && (
    activity.activePositions > 0 ||
    activity.openOrders > 0 ||
    runtimeFailClosed
  );
  const reason = !controllerPresent
    ? 'NO_CONTROLLER_STATE'
    : runtimeFailClosed
      ? runtimeReason
      : configMatched
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
    configMatched,
    needsApply,
    applyAllowed: needsApply && !applyDeferred,
    applyDeferred,
    failClosed: !synchronized,
    reason,
    runtimePresent,
    runtimeFresh,
    runtimeAgeMs: Number.isFinite(runtimeAgeMs) ? runtimeAgeMs : null,
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

function reconciliationRuntimeMatches(report, runtimeRaw) {
  if (!runtimeRaw) return false;
  if (report?.runtimeDataHash) {
    const runtimeState = parseStoredJson(runtimeRaw);
    if (!runtimeState?.data || typeof runtimeState.data !== 'object') return false;
    return sha256(stableStringify(runtimeState.data)) === String(report.runtimeDataHash);
  }
  return Boolean(report?.runtimeHash) && sha256(runtimeRaw) === String(report.runtimeHash);
}

function executionRuntimeReadinessStatus(runtimeState, expectedMasterDeviceId = '') {
  const runtime = runtimeSnapshotStatus(runtimeState, expectedMasterDeviceId);
  if (!runtime.fresh) return { ready: false, reason: runtime.reason };

  const data = runtimeState?.data || {};
  const executionMode = String(data.executionMode || data.mode || '').toUpperCase();
  if (executionMode !== 'REAL') return { ready: false, reason: 'MASTER_RUNTIME_NOT_REAL' };

  const stream = data.userStream;
  if (!stream || typeof stream !== 'object') return { ready: false, reason: 'USER_STREAM_STATE_MISSING' };
  if (stream.connected !== true) return { ready: false, reason: 'USER_STREAM_DISCONNECTED' };
  if (stream.ready !== true) return { ready: false, reason: 'USER_STREAM_NOT_READY' };
  if (stream.failClosed !== false) return { ready: false, reason: 'USER_STREAM_FAIL_CLOSED' };
  if (stream.needsReconciliation !== false) return { ready: false, reason: 'USER_STREAM_RECONCILIATION_REQUIRED' };
  if (Array.isArray(stream.failReasons) && stream.failReasons.length) {
    return { ready: false, reason: 'USER_STREAM_HAS_FAILURES' };
  }

  return { ready: true, reason: 'EXECUTION_RUNTIME_READY', runtime };
}

async function freshConsistentReconciliation(expectedMasterDeviceId = '', maxAgeMs = 10000, repairTarget = '') {
  const [reportRaw, runtimeRaw] = await Promise.all([
    redis(['GET', KEY_RECONCILE_LAST]),
    redis(['GET', KEY_STATE]),
  ]);
  if (!reportRaw) return { ok: false, reason: 'BINANCE_RECONCILIATION_REQUIRED' };

  const report = parseStoredJson(reportRaw);
  const runtimeState = parseStoredJson(runtimeRaw);
  if (!report || !runtimeState) return { ok: false, reason: 'BINANCE_RECONCILIATION_INVALID' };

  const runtimeReady = executionRuntimeReadinessStatus(runtimeState, expectedMasterDeviceId);
  if (!runtimeReady.ready) return { ok: false, reason: runtimeReady.reason };

  const ageMs = Date.now() - Number(report.observedAt || 0);
  const baseValid =
    report.version === 2 &&
    Array.isArray(report.reasons) &&
    report.actual &&
    Number.isInteger(report.actual.positions) &&
    report.actual.positions >= 0 &&
    Number.isInteger(report.actual.orders) &&
    report.actual.orders >= 0 &&
    Boolean(report.runtimeDataHash || report.runtimeHash);
  if (!baseValid) return { ok: false, reason: 'BINANCE_RECONCILIATION_INVALID' };
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) {
    return { ok: false, reason: 'BINANCE_RECONCILIATION_STALE' };
  }
  if (!reconciliationRuntimeMatches(report, runtimeRaw)) {
    return { ok: false, reason: 'BINANCE_RECONCILIATION_RUNTIME_CHANGED' };
  }

  const clean =
    report.failClosed === false &&
    report.status === 'CLEAN_REAL' &&
    report.reasons.length === 0;
  if (clean) return { ok: true, report, runtimeState, runtimeReady, protectiveRepair: false };

  const target = String(repairTarget || '').toUpperCase();
  if (target && protectionOnlyMismatchTarget(report) === target) {
    return { ok: true, report, runtimeState, runtimeReady, protectiveRepair: true, repairTarget: target };
  }

  return { ok: false, reason: 'BINANCE_RECONCILIATION_MISMATCH' };
}

async function realExecutionReadiness(expectedMasterDeviceId = '', repairTarget = '') {
  if (!expectedMasterDeviceId) return { ok: false, reason: 'MASTER_LEASE_REQUIRED' };
  const arm = await realExecutionArmStatus(expectedMasterDeviceId);
  if (!arm.armed) return { ok: false, reason: arm.reason };
  const reconciliation = await freshConsistentReconciliation(expectedMasterDeviceId, 10000, repairTarget);
  if (!reconciliation.ok) return reconciliation;
  return { ok: true, reconciliation };
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
        !(report.runtimeDataHash || report.runtimeHash)) return { ok: false, reason: 'BINANCE_RECONCILIATION_INVALID' };
    const runtimeRaw = await redis(['GET', KEY_STATE]);
    if (!reconciliationRuntimeMatches(report, runtimeRaw)) return { ok: false, reason: 'BINANCE_RECONCILIATION_RUNTIME_CHANGED' };
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
  if (REAL_TRADING_ENABLED) {
    const runtime = runtimeSnapshotStatus(runtimeState, deviceId);
    if (!runtime.fresh) blockers.push(runtime.reason);
    if (!deviceId) blockers.push('MASTER_LEASE_REQUIRED');
  }

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
        await pushDeadLetter({ raw, rejectedAt: now, rejectedReason: 'COMMAND_CORRUPT' });
        dead += 1;
      }
      continue;
    }

    if (!commandTypeAllowed(command?.type) || commandExpired(command, now)) {
      const removed = Number(await redis(['LREM', KEY_PROCESSING, '1', raw])) || 0;
      if (removed > 0) {
        await pushDeadLetter({
          raw,
          rejectedAt: now,
          rejectedReason: !commandTypeAllowed(command?.type) ? 'COMMAND_TYPE_NOT_ALLOWED' : 'COMMAND_EXPIRED',
        });
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

    if (String(command?.type || '').toUpperCase().startsWith('EXEC_')) {
      const halted = await emergencyStopActive();
      const gate = executionGate(command.type, halted);
      if (!gate.allowed) {
        const removed = Number(await redis(['LREM', KEY_PROCESSING, '1', raw])) || 0;
        if (removed > 0) {
          await pushDeadLetter({ raw, rejectedAt: now, rejectedReason: 'EXECUTION_LOCKED_' + gate.reason });
          dead += 1;
        }
        continue;
      }
    }

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
    "  redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[3]) - 1)",
    "  return '__DEAD__'",
    "end",
    "local notBefore = tonumber(obj['notBefore'] or 0)",
    "if notBefore > tonumber(ARGV[1]) then",
    "  redis.call('LPUSH', KEYS[1], raw)",
    "  return '__DEFERRED__:' .. tostring(notBefore)",
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
    String(Date.now()), String(deviceId), String(DEAD_LETTER_MAX)
  ]);
}

async function rejectClaimedCommand(raw, reason, extra = {}) {
  await redis(['LREM', KEY_PROCESSING, '1', raw]);
  await pushDeadLetter({
    raw,
    rejectedAt: Date.now(),
    rejectedReason: String(reason || 'COMMAND_REJECTED'),
    ...extra,
  });
}

function deferredCommandPayload(command, reason, deviceId, now = Date.now(), delayMs = 1500) {
  const clean = { ...(command || {}) };
  delete clean.claimedAt;
  delete clean.claimedBy;
  const expiresAt = Number(clean.expiresAt || 0);
  const requestedNotBefore = now + Math.max(250, Number(delayMs) || 1500);
  clean.deferredAt = now;
  clean.deferredReason = String(reason || 'EXECUTION_TEMPORARILY_UNAVAILABLE');
  clean.deferredBy = String(deviceId || '');
  clean.notBefore = expiresAt > 0 ? Math.min(expiresAt, requestedNotBefore) : requestedNotBefore;
  return clean;
}

async function deferClaimedCommand(raw, command, reason, deviceId, delayMs = 1500) {
  const removed = Number(await redis(['LREM', KEY_PROCESSING, '1', raw])) || 0;
  if (removed <= 0) return false;
  const clean = deferredCommandPayload(command, reason, deviceId, Date.now(), delayMs);
  await redis(['LPUSH', KEY_PENDING, JSON.stringify(clean)]);
  return true;
}

export default async function handler(req, res) {
  const action = String(req.query?.action || 'health');

  if (!sameOriginMutation(req)) {
    return send(res, 403, { ok: false, code: 'ORIGIN_FORBIDDEN' });
  }

  if (action === 'health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      redisConfigured: Boolean(REDIS_URL && REDIS_TOKEN),
      pairingConfigured: Boolean(PAIRING_CODE),
      masterPairingConfigured: Boolean(MASTER_PAIRING_CODE),
      masterAdminConfigured: Boolean(MASTER_ADMIN_CODE),
      pairingDisabled: PAIRING_DISABLED,
      realTradingEnabled: REAL_TRADING_ENABLED,
      binanceWriteEnabled: BINANCE_WRITE_ENABLED,
      realExecutionEnvironmentReady: Boolean(REAL_TRADING_ENABLED && BINANCE_WRITE_ENABLED && PAIRING_DISABLED),
      executionMode: REAL_TRADING_ENABLED && BINANCE_WRITE_ENABLED ? 'REAL_ARMED_BY_ENV' : 'SIMULATION_LOCKED',
      mode: 'SYNC_SAFE_SIMULATION',
      masterTtlSeconds: MASTER_TTL_SECONDS,
      masterActivationTtlSeconds: MASTER_ACTIVATION_TTL_SECONDS,
      commandClaimTtlMs: COMMAND_CLAIM_TTL_MS,
      commandMaxAgeMs: COMMAND_MAX_AGE_MS,
      commandQueueMax: COMMAND_QUEUE_MAX,
      commandPayloadMaxBytes: COMMAND_PAYLOAD_MAX_BYTES,
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
      if (!(await claimRoleDevice(role, deviceId))) {
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
      setDeviceSessionCookie(res, token);
      return send(res, 201, { ok: true, sessionReady: true, device: record });
    }

    if (action === 'controller-replacement-authorize' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      if (!(await verifyMasterAdminCode(req, res, device))) return;

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

      setDeviceSessionCookie(res, token);
      return send(res, 200, {
        ok: true,
        sessionReady: true,
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

      const armStatus = await realExecutionArmStatus(device.deviceId);
      return send(res, 200, {
        ok: true,
        master: true,
        realExecutionArmed: armStatus.armed,
        realExecutionArmReason: armStatus.reason,
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
      if (!(await verifyMasterAdminCode(req, res, device))) return;

      // Block every new entry first. Close/protection work may drain safely while pending.
      await setMasterMode('PAUSE_PENDING');
      const currentMaster = await masterDeviceId();
      const transition = await tryFinalizePendingPause(currentMaster, 'PAUSE_PENDING');
      const requestedMode = transition.masterMode;

      const at = Date.now();
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: requestedMode === 'PAUSED' ? 'MASTER_PAUSED' : 'MASTER_PAUSE_QUEUED',
        deviceId: device.deviceId,
        requestedByRole: device.role,
        blockers: transition.blockers || [],
        activePositions: Number(transition.activity?.activePositions || 0),
        openOrders: Number(transition.activity?.openOrders || 0),
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        masterMode: requestedMode,
        pauseQueued: requestedMode === 'PAUSE_PENDING',
        blockers: transition.blockers || [],
        activity: transition.activity || { activePositions: 0, openOrders: 0 },
        pendingCommands: Number(transition.pendingCommands || 0),
        processingCommands: Number(transition.processingCommands || 0),
      });
    }

    if (action === 'master-pause-cancel' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      if (!(await verifyMasterAdminCode(req, res, device))) return;

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

    if (action === 'real-execution-arm' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;
      if (!(await verifyMasterAdminCode(req, res, device))) return;
      if (!REAL_TRADING_ENABLED) return send(res, 423, { ok:false, code:'REAL_TRADING_DISABLED' });
      if (!BINANCE_WRITE_ENABLED) return send(res, 423, { ok:false, code:'BINANCE_WRITE_DISABLED' });
      if (!PAIRING_DISABLED) return send(res, 423, { ok:false, code:'PAIRING_MUST_BE_DISABLED' });
      if (!DEPLOYMENT_SHA) return send(res, 423, { ok:false, code:'REAL_EXECUTION_DEPLOYMENT_SHA_MISSING' });

      const [currentMaster, registeredMaster, currentMode, halted, pending, processing, runtimeRaw] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('master'),
        masterMode(),
        emergencyStopActive(),
        redis(['LLEN', KEY_PENDING]),
        redis(['LLEN', KEY_PROCESSING]),
        redis(['GET', KEY_STATE]),
      ]);
      const blockers = [];
      if (!currentMaster || !registeredMaster || String(currentMaster) !== String(registeredMaster)) blockers.push('MASTER_LEASE_REQUIRED');
      if (device.role === 'master' && String(currentMaster) !== String(device.deviceId)) blockers.push('NOT_MASTER');
      if (currentMode !== 'PAUSED') blockers.push('MASTER_MUST_BE_PAUSED');
      if (!halted) blockers.push('EMERGENCY_STOP_MUST_BE_ACTIVE');
      if (Number(pending || 0) > 0) blockers.push('PENDING_COMMAND');
      if (Number(processing || 0) > 0) blockers.push('PROCESSING_COMMAND');

      const runtimeState = parseStoredJson(runtimeRaw);
      const runtime = runtimeSnapshotStatus(runtimeState, currentMaster);
      if (!runtime.fresh) blockers.push(runtime.reason);
      const stream = runtimeState?.data?.userStream;
      if (!stream || stream.connected !== true || stream.ready !== true ||
          stream.failClosed !== false || stream.needsReconciliation !== false ||
          (Array.isArray(stream.failReasons) && stream.failReasons.length)) {
        blockers.push('USER_STREAM_NOT_READY');
      }

      const configSync = await readMasterConfigSync(currentMaster);
      if (!configSync.status.synchronized) blockers.push('MASTER_CONFIG_OUT_OF_SYNC');
      const heartbeatRaw = await redis(['GET', KEY_MASTER_HEARTBEAT]);
      if (!heartbeatStatus(heartbeatRaw, currentMaster).fresh) blockers.push('MASTER_HEARTBEAT_STALE');

      let reconciliation = null;
      if (!blockers.length) {
        reconciliation = await freshCleanReconciliation(10000);
        if (!reconciliation.ok) blockers.push(reconciliation.reason);
      }
      if (blockers.length) {
        return send(res, 409, { ok:false, code:'REAL_EXECUTION_ARM_BLOCKED', blockers });
      }

      const record = {
        version:1,
        armedAt:Date.now(),
        masterDeviceId:currentMaster,
        controllerRevision:configSync.status.controllerRevision,
        deploymentSha:DEPLOYMENT_SHA,
        reconciliationObservedAt:Number(reconciliation?.report?.observedAt || 0),
      };
      await redis(['SET', KEY_REAL_EXECUTION_ARMED, JSON.stringify(record)]);
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at:record.armedAt,kind:'REAL_EXECUTION_ARMED',deviceId:device.deviceId,
        requestedByRole:device.role,masterDeviceId:currentMaster,deploymentSha:DEPLOYMENT_SHA
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);
      return send(res, 200, { ok:true, realExecutionArmed:true, armedAt:record.armedAt });
    }

    if (action === 'master-resume' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      if (!(await verifyMasterAdminCode(req, res, device))) return;
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
        if (!PAIRING_DISABLED) blockers.push('PAIRING_MUST_BE_DISABLED');
        const armStatus = await realExecutionArmStatus(currentMaster);
        if (!armStatus.armed) blockers.push(armStatus.reason);
        if (await emergencyStopActive()) blockers.push('EMERGENCY_STOP_ACTIVE');
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
      const armStatus = await realExecutionArmStatus(currentMaster || masterDevice || '');

      return send(res, 200, {
        ok: true,
        executionMode: REAL_TRADING_ENABLED ? 'REAL_ARMED_BY_ENV' : 'SIMULATION_LOCKED',
        realTradingEnabled: REAL_TRADING_ENABLED,
        binanceWriteEnabled: BINANCE_WRITE_ENABLED,
        realExecutionArmed: armStatus.armed,
        realExecutionArmReason: armStatus.reason,
        realExecutionArmedAt: Number(armStatus.record?.armedAt || 0),
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
      if (!configSync.status.synchronized && !configSync.status.applyAllowed) {
        return send(res, 423, {
          ok: false,
          code: configSync.status.reason || 'MASTER_CONFIG_APPLY_DEFERRED',
          activity: configSync.status.activity,
          runtimeFresh: configSync.status.runtimeFresh,
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
      const stateHash = sha256(stableStringify(safeData));
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
      const data = req.body?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return send(res, 400, { ok: false, code: 'RUNTIME_STATE_INVALID' });
      }
      if (JSON.stringify(data).length > 500000) {
        return send(res, 413, { ok: false, code: 'RUNTIME_STATE_TOO_LARGE' });
      }
      const snapshot = {
        version: 2,
        updatedAt: Date.now(),
        masterDeviceId: device.deviceId,
        controllerRevision: Math.max(0, Number(req.body?.controllerRevision || 0)),
        appliedRevision: Math.max(0, Number(req.body?.appliedRevision || 0)),
        data,
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
      if (!commandTypeAllowed(type)) {
        return send(res, 400, { ok: false, code: 'COMMAND_TYPE_NOT_ALLOWED' });
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
        const gate = executionGate(type, halted);
        if (!gate.allowed) {
          return send(res, 423, {
            ok: false,
            code: 'EXECUTION_LOCKED',
            reason: gate.reason,
            realTradingEnabled: REAL_TRADING_ENABLED,
            emergencyStopActive: halted,
            pairingDisabled: PAIRING_DISABLED,
          });
        }
        const repairTarget = protectiveRepairTarget(type, req.body?.payload);
        const readiness = await realExecutionReadiness(activeMaster, repairTarget);
        if (!readiness.ok) {
          return send(res, 423, {
            ok: false,
            code: 'EXECUTION_NOT_READY',
            reason: readiness.reason,
          });
        }
      }
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientCommandId)) {
        return send(res, 400, { ok: false, code: 'CLIENT_COMMAND_ID_REQUIRED' });
      }

      const payload = req.body?.payload ?? null;
      const payloadJson = JSON.stringify(payload);
      const payloadBytes = Buffer.byteLength(payloadJson === undefined ? 'null' : payloadJson, 'utf8');
      if (payloadBytes > COMMAND_PAYLOAD_MAX_BYTES) {
        return send(res, 413, {
          ok: false,
          code: 'COMMAND_PAYLOAD_TOO_LARGE',
          maxBytes: COMMAND_PAYLOAD_MAX_BYTES,
        });
      }
      if (type === 'EXEC_CLOSE_POSITION') {
        const payloadStatus = execClosePayloadStatus(payload);
        if (!payloadStatus.ok) {
          return send(res, 400, { ok:false, code:'COMMAND_PAYLOAD_INVALID', reason:payloadStatus.reason });
        }
      }
      if (type === 'EXEC_UPDATE_EXIT' || type === 'EXEC_UPDATE_PROTECTION') {
        const payloadStatus = execUpdatePayloadStatus(type, payload);
        if (!payloadStatus.ok) {
          return send(res, 400, { ok:false, code:'COMMAND_PAYLOAD_INVALID', reason:payloadStatus.reason });
        }
      }

      const createdAt = Date.now();
      const command = {
        id: crypto.randomUUID(),
        clientCommandId,
        createdAt,
        expiresAt: createdAt + COMMAND_MAX_AGE_MS,
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
        "local total = redis.call('LLEN', KEYS[2]) + redis.call('LLEN', KEYS[4])",
        "if total >= tonumber(ARGV[5]) then return {-4, tostring(total)} end",
        "redis.call('LPUSH', KEYS[2], ARGV[2])",
        "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])",
        "return {1, ARGV[1]}"
      ].join('\n');

      const result = await redis([
        'EVAL', script, '4',
        dedupeKey, KEY_PENDING, KEY_MASTER_MODE, KEY_PROCESSING,
        command.id, raw, String(COMMAND_DEDUPE_TTL_SECONDS),
        allowedWhilePending ? '1' : '0', String(COMMAND_QUEUE_MAX)
      ]);

      const resultCode = Number(Array.isArray(result) ? result[0] : -99);
      if (resultCode === -2) {
        return send(res, 423, { ok: false, code: 'MASTER_PAUSED', masterMode: 'PAUSED' });
      }
      if (resultCode === -3) {
        return send(res, 423, { ok: false, code: 'MASTER_PAUSE_PENDING', masterMode: 'PAUSE_PENDING' });
      }
      if (resultCode === -4) {
        return send(res, 429, {
          ok: false,
          code: 'COMMAND_QUEUE_FULL',
          queueDepth: Number(Array.isArray(result) ? result[1] : COMMAND_QUEUE_MAX),
          queueMax: COMMAND_QUEUE_MAX,
        });
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

      const modeBeforeClaim = await masterMode();
      if (modeBeforeClaim === 'PAUSED') {
        return send(res, 423, { ok: false, code: 'MASTER_PAUSED', masterMode: modeBeforeClaim });
      }

      const recovery = await recoverStaleProcessing(device.deviceId);
      const raw = await claimNextCommand(device.deviceId);
      if (!raw) return send(res, 200, { ok: true, command: null, recovery });
      if (raw === '__DEAD__') {
        return send(res, 500, { ok: false, code: 'COMMAND_CORRUPT', recovery });
      }
      if (String(raw).startsWith('__DEFERRED__:')) {
        const notBefore = Number(String(raw).slice('__DEFERRED__:'.length)) || Date.now() + 1000;
        return send(res, 200, {
          ok: true,
          command: null,
          deferred: true,
          retryAfterMs: Math.max(250, notBefore - Date.now()),
          recovery,
        });
      }

      let command = null;
      try { command = JSON.parse(raw); } catch {}

      if (!command || !commandTypeAllowed(command.type)) {
        await rejectClaimedCommand(raw, 'COMMAND_TYPE_NOT_ALLOWED');
        return send(res, 200, { ok: true, command: null, typeRejected: true, recovery });
      }
      if (String(command.type || '').toUpperCase() === 'EXEC_CLOSE_POSITION') {
        const payloadStatus = execClosePayloadStatus(command.payload);
        if (!payloadStatus.ok) {
          await rejectClaimedCommand(raw, 'COMMAND_PAYLOAD_INVALID', { payloadReason:payloadStatus.reason });
          return send(res, 200, { ok:true, command:null, payloadRejected:true, payloadReason:payloadStatus.reason, recovery });
        }
      }

      if (commandExpired(command)) {
        await rejectClaimedCommand(raw, 'COMMAND_EXPIRED', {
          createdAt: Number(command.createdAt || 0),
          expiresAt: Number(command.expiresAt || 0),
        });
        return send(res, 200, { ok: true, command: null, expiredRejected: true, recovery });
      }

      const modeNow = await masterMode();
      if (modeNow === 'PAUSED') {
        await rejectClaimedCommand(raw, 'MASTER_PAUSED_AFTER_CLAIM');
        return send(res, 200, { ok: true, command: null, pausedRejected: true, recovery });
      }
      if (modeNow === 'PAUSE_PENDING' && !commandAllowedDuringPausePending(command.type)) {
        await rejectClaimedCommand(raw, 'MASTER_PAUSE_PENDING_UNSAFE_COMMAND');
        return send(res, 200, { ok: true, command: null, pausePendingRejected: true, recovery });
      }

      const currentController = await roleDeviceId('controller');
      if (String(command.deviceId || '') !== String(currentController || '')) {
        await rejectClaimedCommand(raw, 'STALE_CONTROLLER_COMMAND', {
          currentControllerDeviceId: currentController,
        });
        return send(res, 200, { ok: true, command: null, staleRejected: true, recovery });
      }

      const configSync = await readMasterConfigSync(device.deviceId);
      if (!configSync.status.synchronized && !commandAllowedDuringPausePending(command.type)) {
        await rejectClaimedCommand(raw, 'MASTER_CONFIG_OUT_OF_SYNC', {
          controllerRevision: configSync.status.controllerRevision,
          appliedRevision: configSync.status.appliedRevision,
        });
        return send(res, 200, {
          ok: true,
          command: null,
          syncRejected: true,
          masterSyncStatus: configSync.status.reason,
          recovery,
        });
      }

      if (String(command.type || '').toUpperCase().startsWith('EXEC_')) {
        const halted = await emergencyStopActive();
        const gate = executionGate(command.type, halted);
        if (!gate.allowed) {
          await rejectClaimedCommand(raw, 'EXECUTION_LOCKED_' + gate.reason, {
            emergencyStopActive: halted,
            realTradingEnabled: REAL_TRADING_ENABLED,
            pairingDisabled: PAIRING_DISABLED,
          });
          return send(res, 200, {
            ok: true,
            command: null,
            executionRejected: true,
            executionReason: gate.reason,
            recovery,
          });
        }
        const repairTarget = protectiveRepairTarget(command.type, command.payload);
        const readiness = await realExecutionReadiness(device.deviceId, repairTarget);
        if (!readiness.ok) {
          const deferred = await deferClaimedCommand(
            raw,
            command,
            'EXECUTION_NOT_READY_' + readiness.reason,
            device.deviceId
          );
          return send(res, 200, {
            ok: true,
            command: null,
            executionDeferred: deferred,
            executionReason: readiness.reason,
            retryAfterMs: 1500,
            recovery,
          });
        }
      }

      return send(res, 200, {
        ok: true,
        command,
        raw,
        recovery,
        validatedAt: Date.now(),
        masterMode: modeNow,
      });
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
      let command = null;
      try { command = JSON.parse(raw); } catch {}
      const commandId = String(command?.id || '');
      const commandType = String(command?.type || '').toUpperCase();

      if (commandType === 'EXEC_CANCEL_ENTRY') {
        const payload = command?.payload || {};
        const symbol = String(payload.symbol || '').toUpperCase();
        const clientOrderId = String(payload.clientOrderId || '');
        const proof = req.body?.executionProof;
        const terminalStatus = String(proof?.terminalStatus || '').toUpperCase();
        if (!/^[A-Z0-9]{3,30}$/.test(symbol) || !clientOrderId ||
            !['CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(terminalStatus)) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_PROOF_INVALID' });
        }
        const readiness = await freshConsistentReconciliation(device.deviceId);
        if (!readiness.ok) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_RECONCILIATION_REQUIRED', reason:readiness.reason });
        }
        const stillOpen = runtimeOpenOrder(readiness.runtimeState, order =>
          String(order?.orderClass || 'STANDARD').toUpperCase() === 'STANDARD' &&
          String(order?.symbol || '').toUpperCase() === symbol &&
          String(order?.clientOrderId || '') === clientOrderId
        );
        if (stillOpen) return send(res, 409, { ok:false, code:'EXECUTION_ACK_ENTRY_STILL_OPEN' });
        await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
          at:Date.now(),kind:'EXEC_CANCEL_ENTRY_CONFIRMED',commandId,deviceId:device.deviceId,
          symbol,clientOrderId,terminalStatus,
          reconciliationObservedAt:Number(readiness.report?.observedAt || 0),
        })]);
        await redis(['LTRIM', KEY_AUDIT, '0', '199']);
      }

      if (commandType === 'EXEC_UPDATE_EXIT' || commandType === 'EXEC_UPDATE_PROTECTION') {
        const payloadStatus = execUpdatePayloadStatus(commandType, command?.payload);
        if (!payloadStatus.ok) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_PAYLOAD_INVALID', reason:payloadStatus.reason });
        }
        const proof = req.body?.executionProof;
        const newClientId = String(proof?.newClientId || '');
        if (!/^zth-[A-Za-z0-9._:-]+$/.test(newClientId) || newClientId.length > 36) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_PROOF_INVALID' });
        }
        const readiness = await freshConsistentReconciliation(device.deviceId);
        if (!readiness.ok) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_RECONCILIATION_REQUIRED', reason:readiness.reason });
        }
        const position = runtimePositionRecord(readiness.runtimeState, payloadStatus.symbol, payloadStatus.direction);
        const liveQuantity = Math.abs(Number(position?.positionAmt ?? position?.quantity ?? 0));
        if (!position || !numberMatches(liveQuantity, payloadStatus.quantity)) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_POSITION_CHANGED', liveQuantity });
        }
        const expectedSide = payloadStatus.direction === 'LONG' ? 'SELL' : 'BUY';
        const previousId = commandType === 'EXEC_UPDATE_EXIT'
          ? String(payloadStatus.previousClientOrderId || '')
          : String(payloadStatus.previousClientAlgoId || '');
        if (previousId) {
          const oldStillOpen = runtimeOpenOrder(readiness.runtimeState, order =>
            String(order?.symbol || '').toUpperCase() === payloadStatus.symbol &&
            (String(order?.clientOrderId || '') === previousId || String(order?.clientAlgoId || '') === previousId)
          );
          if (oldStillOpen) return send(res, 409, { ok:false, code:'EXECUTION_ACK_PREVIOUS_ORDER_STILL_OPEN' });
        }

        let confirmedOrder = null;
        if (commandType === 'EXEC_UPDATE_EXIT') {
          confirmedOrder = runtimeOpenOrder(readiness.runtimeState, order =>
            String(order?.orderClass || 'STANDARD').toUpperCase() === 'STANDARD' &&
            String(order?.symbol || '').toUpperCase() === payloadStatus.symbol &&
            String(order?.clientOrderId || '') === newClientId &&
            String(order?.side || '').toUpperCase() === expectedSide &&
            String(order?.positionSide || 'BOTH').toUpperCase() === 'BOTH' &&
            String(order?.type || '').toUpperCase() === 'LIMIT' &&
            String(order?.timeInForce || '').toUpperCase() === 'GTC' &&
            (order?.reduceOnly === true || order?.reduceOnly === 'true') &&
            numberMatches(order?.origQty, payloadStatus.quantity) &&
            numberMatches(order?.price, payloadStatus.targetPrice)
          );
          const entryPrice = Number(position?.entryPrice || 0);
          if (!runtimeEmergencyProtection(readiness.runtimeState,payloadStatus.symbol,payloadStatus.direction,entryPrice,Math.abs(Number(position?.positionAmt||position?.quantity||0)))) {
            return send(res, 409, { ok:false, code:'EXECUTION_ACK_EMERGENCY_PROTECTION_MISSING' });
          }
        } else {
          confirmedOrder = runtimeOpenOrder(readiness.runtimeState, order => {
            if (String(order?.orderClass || '').toUpperCase() !== 'ALGO') return false;
            if (String(order?.symbol || '').toUpperCase() !== payloadStatus.symbol) return false;
            if (String(order?.clientAlgoId || '') !== newClientId) return false;
            if (String(order?.side || '').toUpperCase() !== expectedSide) return false;
            if (String(order?.positionSide || 'BOTH').toUpperCase() !== 'BOTH') return false;
            if (!numberMatches(order?.triggerPrice ?? order?.stopPrice, payloadStatus.triggerPrice)) return false;
            if (payloadStatus.protectionKind === 'MAX_LOSS') {
              return String(order?.type || '').toUpperCase() === 'STOP_MARKET' &&
                (order?.closePosition === true || order?.closePosition === 'true');
            }
            return String(order?.type || '').toUpperCase() === 'STOP' &&
              String(order?.timeInForce || '').toUpperCase() === 'GTC' &&
              (order?.reduceOnly === true || order?.reduceOnly === 'true') &&
              numberMatches(order?.origQty, payloadStatus.quantity) &&
              numberMatches(order?.price, payloadStatus.limitPrice) &&
              (!order?.priceMatch || String(order?.priceMatch || '').toUpperCase() === 'NONE');
          });
          if (payloadStatus.protectionKind === 'PROGRESSIVE') {
            const entryPrice = Number(position?.entryPrice || 0);
            if (!runtimeEmergencyProtection(readiness.runtimeState,payloadStatus.symbol,payloadStatus.direction,entryPrice,Math.abs(Number(position?.positionAmt||position?.quantity||0)),newClientId)) {
              return send(res, 409, { ok:false, code:'EXECUTION_ACK_EMERGENCY_PROTECTION_MISSING' });
            }
          }
        }
        if (!confirmedOrder) return send(res, 409, { ok:false, code:'EXECUTION_ACK_NEW_ORDER_NOT_CONFIRMED' });

        await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
          at:Date.now(),kind:'EXEC_PROTECTIVE_UPDATE_CONFIRMED',commandId,commandType,
          deviceId:device.deviceId,symbol:payloadStatus.symbol,newClientId,previousId,
          reconciliationObservedAt:Number(readiness.report?.observedAt || 0),
        })]);
        await redis(['LTRIM', KEY_AUDIT, '0', '199']);
      }

      if (commandType === 'EXEC_CLOSE_POSITION') {
        const payloadStatus = execClosePayloadStatus(command?.payload);
        if (!payloadStatus.ok) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_PAYLOAD_INVALID', reason:payloadStatus.reason });
        }
        const proof = req.body?.executionProof;
        const beforeQuantity = Number(proof?.beforeQuantity);
        const clientOrderId = String(proof?.clientOrderId || '');
        const alreadySatisfied = proof?.alreadySatisfied === true;
        if (!proof || !Number.isFinite(beforeQuantity) || beforeQuantity <= 0 ||
            (!alreadySatisfied && !/^[.A-Z:/a-z0-9_-]{1,36}$/.test(clientOrderId))) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_PROOF_INVALID' });
        }

        const readiness = await freshConsistentReconciliation(device.deviceId);
        if (!readiness.ok) {
          return send(res, 409, {
            ok:false,
            code:'EXECUTION_ACK_RECONCILIATION_REQUIRED',
            reason:readiness.reason,
          });
        }
        const currentQuantity = runtimeClosePositionQuantity(
          readiness.runtimeState,
          payloadStatus.symbol,
          payloadStatus.direction
        );
        if (currentQuantity > 1e-12) {
          return send(res, 409, { ok:false, code:'EXECUTION_ACK_NOT_CONFIRMED', currentQuantity });
        }

        await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
          at:Date.now(),
          kind:'EXEC_CLOSE_CONFIRMED',
          commandId,
          deviceId:device.deviceId,
          symbol:payloadStatus.symbol,
          direction:payloadStatus.direction,
          beforeQuantity,
          currentQuantity,
          clientOrderId,
          alreadySatisfied,
          reconciliationObservedAt:Number(readiness.report?.observedAt || 0),
        })]);
        await redis(['LTRIM', KEY_AUDIT, '0', '199']);
      }

      if (commandId) {
        await redis(['SET', `${PREFIX}:command:done:${commandId}`, String(Date.now()), 'EX', String(60 * 60 * 24 * 30)]);
      }
      await redis(['LREM', KEY_PROCESSING, '1', raw]);
      return send(res, 200, { ok:true, commandId });
    }

    if (action === 'command-fail' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) return send(res, 409, { ok:false, code:'NOT_MASTER' });
      const raw = String(req.body?.raw || '');
      const reason = String(req.body?.reason || 'EXECUTION_FAILED').toUpperCase();
      if (!raw) return send(res, 400, { ok:false, code:'RAW_REQUIRED' });
      if (!/^[A-Z0-9_:-]{3,96}$/.test(reason)) return send(res, 400, { ok:false, code:'FAIL_REASON_INVALID' });
      let command = null;
      try { command = JSON.parse(raw); } catch {}
      const removed = Number(await redis(['LREM', KEY_PROCESSING, '1', raw])) || 0;
      if (removed > 0) {
        await pushDeadLetter({raw,rejectedAt:Date.now(),rejectedReason:reason,failedBy:device.deviceId});
        await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
          at:Date.now(),
          kind:'COMMAND_EXECUTION_FAILED',
          commandId:String(command?.id || ''),
          commandType:String(command?.type || ''),
          reason,
          deviceId:device.deviceId,
        })]);
        await redis(['LTRIM', KEY_AUDIT, '0', '199']);
      }
      return send(res, 200, { ok:true, failed:removed > 0 });
    }

    if (action === 'command-requeue' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }

      const raw = String(req.body?.raw || '');
      if (!raw) return send(res, 400, { ok: false, code: 'RAW_REQUIRED' });

      let command = null;
      try { command = JSON.parse(raw); } catch {}
      if (!command || !commandTypeAllowed(command.type)) {
        await rejectClaimedCommand(raw, 'COMMAND_TYPE_NOT_ALLOWED');
        return send(res, 200, { ok: true, requeued: false, rejected: true });
      }
      if (commandExpired(command)) {
        await rejectClaimedCommand(raw, 'COMMAND_EXPIRED');
        return send(res, 200, { ok: true, requeued: false, expired: true });
      }

      const commandId = String(command.id || '');
      if (commandId) {
        const done = await redis(['GET', `${PREFIX}:command:done:${commandId}`]);
        if (done) {
          await redis(['LREM', KEY_PROCESSING, '1', raw]);
          return send(res, 200, { ok: true, requeued: false, alreadyDone: true });
        }
      }

      const modeNow = await masterMode();
      if (modeNow === 'PAUSED' ||
          (modeNow === 'PAUSE_PENDING' && !commandAllowedDuringPausePending(command.type))) {
        await rejectClaimedCommand(raw, modeNow === 'PAUSED' ? 'MASTER_PAUSED' : 'MASTER_PAUSE_PENDING_UNSAFE_COMMAND');
        return send(res, 200, { ok: true, requeued: false, paused: true, masterMode: modeNow });
      }

      if (String(command.type || '').toUpperCase().startsWith('EXEC_')) {
        const halted = await emergencyStopActive();
        const gate = executionGate(command.type, halted);
        if (!gate.allowed) {
          await rejectClaimedCommand(raw, 'EXECUTION_LOCKED_' + gate.reason);
          return send(res, 200, { ok: true, requeued: false, executionRejected: true, executionReason: gate.reason });
        }
        const readiness = await realExecutionReadiness(device.deviceId);
        if (!readiness.ok) {
          const deferred = await deferClaimedCommand(
            raw,
            command,
            'EXECUTION_NOT_READY_' + readiness.reason,
            device.deviceId
          );
          return send(res, 200, {
            ok: true,
            requeued: deferred,
            executionDeferred: deferred,
            executionReason: readiness.reason,
            retryAfterMs: 1500,
          });
        }
      }

      const requestedDelayMs = Math.max(0, Math.min(30000, Number(req.body?.deferMs || 0)));
      if (requestedDelayMs > 0) {
        const reason = String(req.body?.deferReason || 'MASTER_EXECUTION_RETRY').slice(0, 120);
        const deferred = await deferClaimedCommand(raw, command, reason, device.deviceId, requestedDelayMs);
        return send(res, 200, {
          ok: true,
          requeued: deferred,
          deferred,
          retryAfterMs: requestedDelayMs,
        });
      }

      const removed = Number(await redis(['LREM', KEY_PROCESSING, '1', raw])) || 0;
      if (removed > 0) {
        const clean = { ...command };
        delete clean.claimedAt;
        delete clean.claimedBy;
        clean.requeuedAt = Date.now();
        clean.requeuedBy = device.deviceId;
        await redis(['LPUSH', KEY_PENDING, JSON.stringify(clean)]);
      }
      return send(res, 200, { ok: true, requeued: removed > 0 });
    }

    if (action === 'emergency-stop' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      const at = Date.now();
      await redis(['SET', KEY_EMERGENCY_STOP, '1']);

      // PANIC blocks new entries immediately but keeps close/protection work available.
      await setMasterMode('PAUSE_PENDING');
      const currentMaster = await masterDeviceId();
      const transition = await tryFinalizePendingPause(currentMaster, 'PAUSE_PENDING');

      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: 'EMERGENCY_STOP_SET',
        deviceId: device.deviceId,
        role: device.role,
        masterMode: transition.masterMode,
        blockers: transition.blockers || [],
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        emergencyStopActive: true,
        executionMode: 'STOPPED',
        masterMode: transition.masterMode,
        blockers: transition.blockers || [],
      });
    }

    if (action === 'emergency-stop-clear' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      if (!(await verifyMasterAdminCode(req, res, device))) return;
      if (!REAL_TRADING_ENABLED) {
        return send(res, 423, { ok: false, code: 'REAL_TRADING_DISABLED' });
      }
      if (!PAIRING_DISABLED) {
        return send(res, 423, { ok: false, code: 'PAIRING_MUST_BE_DISABLED' });
      }

      const [currentMaster, registeredMaster, currentMode] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('master'),
        masterMode(),
      ]);
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
      const armStatus = await realExecutionArmStatus(currentMaster);
      if (!armStatus.armed) {
        return send(res, 409, { ok:false, code:'REAL_EXECUTION_NOT_ARMED', reason:armStatus.reason });
      }
      if (currentMode !== 'PAUSED') {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_MUST_BE_PAUSED',
          masterMode: currentMode,
        });
      }

      const configSync = await readMasterConfigSync(currentMaster);
      if (!configSync.status.synchronized) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_CONFIG_OUT_OF_SYNC',
          masterSyncStatus: configSync.status.reason,
          controllerRevision: configSync.status.controllerRevision,
          appliedRevision: configSync.status.appliedRevision,
        });
      }

      const heartbeatRaw = await redis(['GET', KEY_MASTER_HEARTBEAT]);
      const heartbeat = heartbeatStatus(heartbeatRaw, currentMaster);
      if (!heartbeat.fresh) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_HEARTBEAT_STALE',
          masterHeartbeatAgeMs: heartbeat.ageMs,
        });
      }

      const reconciliation = await freshCleanReconciliation();
      if (!reconciliation.ok) {
        return send(res, 409, {
          ok: false,
          code: reconciliation.reason,
        });
      }

      await redis(['SET', KEY_EMERGENCY_STOP, '0']);
      const at = Date.now();
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: 'EMERGENCY_STOP_CLEARED',
        deviceId: device.deviceId,
        role: device.role,
        masterDeviceId: currentMaster,
        reconciliationObservedAt: Number(reconciliation.report?.observedAt || 0),
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        emergencyStopActive: false,
        executionMode: 'REAL_ARMED_BY_ENV',
        masterMode: currentMode,
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
