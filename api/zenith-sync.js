import crypto from 'node:crypto';
import { DEVICE_SESSION_MAX_AGE_SECONDS, bearerToken, cookieToken, setDeviceSessionCookie, clearDeviceSessionCookie, sameOriginMutation, validDeviceId, roleAssignmentKey, deviceRoleAssignmentActive } from '../lib/device-session.mjs';
import { normalizeProtectiveUpdatePayload, protectionOnlyMismatchTarget, protectiveRepairTarget } from '../lib/protective-command.mjs';
import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';
import { jsonStructureStatus, plainJsonObject } from '../lib/json-structure.mjs';

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
const ENGINE_BOOTSTRAP_SECRET = process.env.ZENITH_ENGINE_BOOTSTRAP_SECRET || '';
const ENGINE_MASTER_DEVICE_ID = 'zenith-server-engine-v1';
const PAIRING_DISABLED = process.env.ZENITH_PAIRING_DISABLED === '1';
const REAL_TRADING_ENABLED = process.env.ZENITH_REAL_TRADING_ENABLED === '1';
const BINANCE_WRITE_ENABLED = process.env.ZENITH_BINANCE_WRITE_ENABLED === '1';
const VERCEL_PRODUCTION_WRITE_ALLOWED = process.env.VERCEL_ENV === 'production' && process.env.VERCEL_GIT_COMMIT_REF === 'main';
const ZENITH_CONTROL_MUTATION_ALLOWED = !process.env.VERCEL_ENV ||
  process.env.VERCEL_ENV === 'development' ||
  VERCEL_PRODUCTION_WRITE_ALLOWED;
const BINANCE_API_BASE = 'https://api.binance.com';
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';
const BINANCE_API_RESTRICTIONS_PATH = '/sapi/v1/account/apiRestrictions';
const BINANCE_API_TIME_PATH = '/api/v3/time';
const BINANCE_FUTURES_TIME_PATH = '/fapi/v1/time';
const BINANCE_PERMISSION_RECV_WINDOW = 5000;

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
const KEY_EMERGENCY_STOP_EPOCH = `${PREFIX}:safety:emergency-stop:epoch`;
const KEY_REAL_EXECUTION_ARMED = `${PREFIX}:safety:real-execution-armed`;
const KEY_MASTER_MODE = `${PREFIX}:master-mode`;
const DEPLOYMENT_SHA = String(process.env.VERCEL_GIT_COMMIT_SHA || '');
const KEY_RECONCILE_LAST = `${PREFIX}:reconcile:last`;
const KEY_MASTER_CONFIG_ACK = `${PREFIX}:master-config:applied`;
const KEY_MASTER_HEARTBEAT = `${PREFIX}:master-heartbeat`;
const KEY_USER_STREAM_SESSION = `${PREFIX}:binance-user-stream`;
const KEY_USER_STREAM_MUTATION_LOCK = `${PREFIX}:binance-user-stream:mutation-lock`;
const KEY_ENGINE_INSTANCE = `${PREFIX}:engine-instance`;
const KEY_ENGINE_AUTHORIZED = `${PREFIX}:engine-authorized`;
const KEY_ENGINE_DISABLED = `${PREFIX}:engine-disabled`;
const KEY_ENGINE_PROTECTION_HIGH_WATER = `${PREFIX}:engine-protection-high-water`;
const MASTER_TTL_SECONDS = 20;
const ENGINE_INSTANCE_TTL_SECONDS = 45;
const MASTER_HEARTBEAT_TTL_SECONDS = 60;
const MASTER_HEARTBEAT_STALE_MS = 30 * 1000;
const MASTER_ACTIVATION_TTL_SECONDS = 120;
const COMMAND_CLAIM_TTL_MS = 90 * 1000;
const COMMAND_DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 30;
const PAIR_RATE_LIMIT = 5;
const PAIR_GLOBAL_RATE_LIMIT = 30;
const CONTROLLER_REPLACEMENT_TTL_SECONDS = 10 * 60;
const CONTROLLER_REPLACEMENT_RATE_LIMIT = 5;
const CONTROLLER_REPLACEMENT_GLOBAL_RATE_LIMIT = 30;
const CONTROLLER_ADMIN_RECOVERY_RATE_LIMIT = 5;
const CONTROLLER_ADMIN_RECOVERY_GLOBAL_RATE_LIMIT = 30;
const ENGINE_BOOTSTRAP_RATE_LIMIT = 5;
const ENGINE_BOOTSTRAP_GLOBAL_RATE_LIMIT = 30;
const CONTROLLER_STATE_WRITE_RATE_LIMIT_PER_MINUTE = 120;
const MASTER_ADMIN_FAILURE_LIMIT = 5;
const MASTER_ADMIN_LOCK_SECONDS = 15 * 60;
const AUTH_SECRET_INPUT_MAX_CHARS = 256;
const REPLACEMENT_CODE_INPUT_MAX_CHARS = 64;
const RUNTIME_STATE_STALE_MS = 30 * 1000;
const COMMAND_MAX_AGE_MS = 2 * 60 * 1000;
const COMMAND_QUEUE_MAX = 100;
const COMMAND_PAYLOAD_MAX_BYTES = 16 * 1024;
const COMMAND_RAW_MAX_BYTES = 64 * 1024;
const DEAD_LETTER_MAX = 500;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function timingSafeEqualText(a, b) {
  const aa = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
  const bb = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
  return crypto.timingSafeEqual(aa, bb);
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function adminSecretPolicyBlockers({
  adminCode = MASTER_ADMIN_CODE,
  pairingCode = PAIRING_CODE,
  masterPairingCode = MASTER_PAIRING_CODE,
} = {}) {
  const blockers = [];
  const admin = String(adminCode || '');
  if (admin.length < 16) blockers.push('MASTER_ADMIN_CODE_TOO_WEAK');
  if (admin && (timingSafeEqualText(admin, pairingCode) || timingSafeEqualText(admin, masterPairingCode))) {
    blockers.push('MASTER_ADMIN_CODE_REUSED');
  }
  return blockers;
}

function engineBootstrapSecretPolicyBlockers({
  engineSecret = ENGINE_BOOTSTRAP_SECRET,
  adminCode = MASTER_ADMIN_CODE,
  pairingCode = PAIRING_CODE,
  masterPairingCode = MASTER_PAIRING_CODE,
} = {}) {
  const secret = String(engineSecret || '');
  const blockers = [];
  if (secret.length < 32) blockers.push('ENGINE_BOOTSTRAP_SECRET_TOO_WEAK');
  if (secret && [adminCode, pairingCode, masterPairingCode].some(value => value && timingSafeEqualText(secret, value))) {
    blockers.push('ENGINE_BOOTSTRAP_SECRET_REUSED');
  }
  return blockers;
}

function pairingSecretPolicyBlockers({
  role,
  pairingCode = PAIRING_CODE,
  masterPairingCode = MASTER_PAIRING_CODE,
  adminCode = MASTER_ADMIN_CODE,
} = {}) {
  const normalizedRole = String(role || '');
  const secret = String(normalizedRole === 'master' ? masterPairingCode : pairingCode || '');
  const other = String(normalizedRole === 'master' ? pairingCode : masterPairingCode || '');
  const admin = String(adminCode || '');
  const blockers = [];

  if (!['controller', 'master'].includes(normalizedRole)) {
    blockers.push('PAIRING_ROLE_INVALID');
    return blockers;
  }
  if (secret.length < 16) {
    blockers.push(normalizedRole === 'master' ? 'MASTER_PAIRING_CODE_TOO_WEAK' : 'PAIRING_CODE_TOO_WEAK');
  }
  if (other && secret && timingSafeEqualText(secret, other)) {
    blockers.push('PAIRING_CODES_REUSED');
  }
  if (admin && secret && timingSafeEqualText(secret, admin)) {
    blockers.push('PAIRING_CODE_REUSES_ADMIN');
  }
  return blockers;
}

function binanceCredentialSeparationBlockers({
  readApiKey = process.env.BINANCE_API_KEY || '',
  tradingApiKey = process.env.BINANCE_TRADING_API_KEY || '',
} = {}) {
  const blockers = [];
  if (readApiKey && tradingApiKey && timingSafeEqualText(readApiKey, tradingApiKey)) {
    blockers.push('BINANCE_TRADING_KEY_MUST_DIFFER_FROM_READ_KEY');
  }
  return blockers;
}

function binanceApiPermissionBlockers(permission) {
  if (!permission || typeof permission !== 'object') return ['BINANCE_API_PERMISSIONS_UNAVAILABLE'];
  const blockers = [];
  if (permission.ipRestrict !== true) blockers.push('BINANCE_API_IP_RESTRICTION_REQUIRED');
  if (permission.enableReading !== true) blockers.push('BINANCE_API_READING_REQUIRED');
  if (permission.enableFutures !== true) blockers.push('BINANCE_API_FUTURES_REQUIRED');
  const forbidden = [
    ['enableWithdrawals', 'BINANCE_API_WITHDRAWALS_MUST_BE_DISABLED'],
    ['enableInternalTransfer', 'BINANCE_API_INTERNAL_TRANSFER_MUST_BE_DISABLED'],
    ['enableMargin', 'BINANCE_API_MARGIN_MUST_BE_DISABLED'],
    ['permitsUniversalTransfer', 'BINANCE_API_UNIVERSAL_TRANSFER_MUST_BE_DISABLED'],
    ['enableVanillaOptions', 'BINANCE_API_OPTIONS_MUST_BE_DISABLED'],
    ['enableFixApiTrade', 'BINANCE_API_FIX_TRADE_MUST_BE_DISABLED'],
    ['enableSpotAndMarginTrading', 'BINANCE_API_SPOT_MARGIN_TRADING_MUST_BE_DISABLED'],
    ['enablePortfolioMarginTrading', 'BINANCE_API_PORTFOLIO_MARGIN_MUST_BE_DISABLED'],
  ];
  for (const [field, code] of forbidden) {
    if (permission[field] === true) blockers.push(code);
  }
  return blockers;
}

async function binanceJson(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok || data?.code) {
      const error = new Error(data?.msg || `Binance HTTP ${response.status}`);
      error.code = 'BINANCE_API_PERMISSION_CHECK_FAILED';
      error.status = response.status;
      error.binanceCode = data?.code ?? null;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBinanceApiPermissions() {
  const apiKey = process.env.BINANCE_TRADING_API_KEY || '';
  const secret = process.env.BINANCE_TRADING_API_SECRET || '';
  if (!apiKey || !secret) {
    const error = new Error('BINANCE_TRADING_CREDENTIALS_MISSING');
    error.code = 'BINANCE_TRADING_CREDENTIALS_MISSING';
    throw error;
  }

  const time = await binanceJson(`${BINANCE_API_BASE}${BINANCE_API_TIME_PATH}`);
  const serverTime = Number(time?.serverTime);
  if (!Number.isFinite(serverTime)) {
    const error = new Error('BINANCE_TIME_INVALID');
    error.code = 'BINANCE_API_PERMISSION_CHECK_FAILED';
    throw error;
  }

  const query = new URLSearchParams({
    timestamp: String(serverTime),
    recvWindow: String(BINANCE_PERMISSION_RECV_WINDOW),
  });
  const signature = crypto.createHmac('sha256', secret).update(query.toString()).digest('hex');
  query.set('signature', signature);

  return binanceJson(`${BINANCE_API_BASE}${BINANCE_API_RESTRICTIONS_PATH}?${query.toString()}`, {
    method: 'GET',
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

async function signedFuturesGet(path, apiKey, secret, serverTime, extra = {}) {
  const query = new URLSearchParams({
    timestamp: String(serverTime),
    recvWindow: String(BINANCE_PERMISSION_RECV_WINDOW),
  });
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const signature = crypto.createHmac('sha256', secret).update(query.toString()).digest('hex');
  query.set('signature', signature);
  return binanceJson(`${BINANCE_FUTURES_BASE}${path}?${query.toString()}`, {
    method: 'GET',
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

async function fetchLiveBinanceActivity() {
  const apiKey = process.env.BINANCE_API_KEY || '';
  const secret = process.env.BINANCE_API_SECRET || '';
  if (!apiKey || !secret) {
    const error = new Error('BINANCE_API_CREDENTIALS_MISSING');
    error.code = 'BINANCE_API_CREDENTIALS_MISSING';
    throw error;
  }

  const time = await binanceJson(`${BINANCE_FUTURES_BASE}${BINANCE_FUTURES_TIME_PATH}`);
  const serverTime = Number(time?.serverTime);
  if (!Number.isFinite(serverTime)) {
    const error = new Error('BINANCE_TIME_INVALID');
    error.code = 'BINANCE_ACTIVITY_CHECK_FAILED';
    throw error;
  }

  const [positions, openOrders, openAlgoOrders] = await Promise.all([
    signedFuturesGet('/fapi/v3/positionRisk', apiKey, secret, serverTime),
    signedFuturesGet('/fapi/v1/openOrders', apiKey, secret, serverTime),
    signedFuturesGet('/fapi/v1/openAlgoOrders', apiKey, secret, serverTime, { algoType: 'CONDITIONAL' }),
  ]);

  const activePositions = (Array.isArray(positions) ? positions : [])
    .filter(position => Math.abs(Number(position?.positionAmt || 0)) > 0).length;
  const standardOpenOrders = Array.isArray(openOrders) ? openOrders.length : 0;
  const algoOpenOrders = Array.isArray(openAlgoOrders) ? openAlgoOrders.length : 0;

  return {
    activePositions,
    standardOpenOrders,
    algoOpenOrders,
    openOrders: standardOpenOrders + algoOpenOrders,
  };
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

function firstForwardedIp(value) {
  return String(value || '').split(',')[0].trim();
}

function clientIp(req) {
  const headers = req?.headers || {};
  const onVercel = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
  if (onVercel) {
    const vercelForwarded = firstForwardedIp(headers['x-vercel-forwarded-for']);
    if (vercelForwarded) return vercelForwarded;
  }
  return firstForwardedIp(headers['x-forwarded-for']) ||
    firstForwardedIp(headers['x-real-ip']) ||
    'unknown';
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
    signal: AbortSignal.timeout(8000),
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

async function incrementWithExpiry(key, ttlSeconds) {
  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  return Number(await redis(['EVAL', script, '1', key, String(ttlSeconds)])) || 0;
}

async function incrementWithGlobalExpiry(localKey, globalKey, ttlSeconds) {
  const script = [
    "local localCount = redis.call('INCR', KEYS[1])",
    "if localCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "local globalCount = redis.call('INCR', KEYS[2])",
    "if globalCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end",
    "return {localCount, globalCount}"
  ].join('\n');
  const result = await redis(['EVAL', script, '2', localKey, globalKey, String(ttlSeconds)]);
  return {
    localCount: Number(Array.isArray(result) ? result[0] : 0) || 0,
    globalCount: Number(Array.isArray(result) ? result[1] : 0) || 0,
  };
}

async function pairRateAllowed(req) {
  const bucket = Math.floor(Date.now() / 60000);
  const localKey = `${PREFIX}:pair-rate:${sha256(clientIp(req))}:${bucket}`;
  const globalKey = `${PREFIX}:pair-rate:global:${bucket}`;
  const counts = await incrementWithGlobalExpiry(localKey, globalKey, 120);
  return counts.localCount <= PAIR_RATE_LIMIT && counts.globalCount <= PAIR_GLOBAL_RATE_LIMIT;
}

async function controllerReplacementRateAllowed(req) {
  const bucket = Math.floor(Date.now() / 60000);
  const localKey = `${PREFIX}:controller-replacement-rate:${sha256(clientIp(req))}:${bucket}`;
  const globalKey = `${PREFIX}:controller-replacement-rate:global:${bucket}`;
  const counts = await incrementWithGlobalExpiry(localKey, globalKey, 120);
  return counts.localCount <= CONTROLLER_REPLACEMENT_RATE_LIMIT &&
    counts.globalCount <= CONTROLLER_REPLACEMENT_GLOBAL_RATE_LIMIT;
}

async function controllerAdminRecoveryRateAllowed(req) {
  const bucket = Math.floor(Date.now() / 60000);
  const localKey = `${PREFIX}:controller-admin-recovery-rate:${sha256(clientIp(req))}:${bucket}`;
  const globalKey = `${PREFIX}:controller-admin-recovery-rate:global:${bucket}`;
  const counts = await incrementWithGlobalExpiry(localKey, globalKey, 120);
  return counts.localCount <= CONTROLLER_ADMIN_RECOVERY_RATE_LIMIT &&
    counts.globalCount <= CONTROLLER_ADMIN_RECOVERY_GLOBAL_RATE_LIMIT;
}

async function engineBootstrapRateAllowed(req) {
  const bucket = Math.floor(Date.now() / 60000);
  const localKey = `${PREFIX}:engine-bootstrap-rate:${sha256(clientIp(req))}:${bucket}`;
  const globalKey = `${PREFIX}:engine-bootstrap-rate:global:${bucket}`;
  const counts = await incrementWithGlobalExpiry(localKey, globalKey, 120);
  return counts.localCount <= ENGINE_BOOTSTRAP_RATE_LIMIT &&
    counts.globalCount <= ENGINE_BOOTSTRAP_GLOBAL_RATE_LIMIT;
}

async function controllerStateWriteRateAllowed(deviceId) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${PREFIX}:rate:controller-state-write:${sha256(deviceId)}:${bucket}`;
  const count = await incrementWithExpiry(key, 120);
  return count <= CONTROLLER_STATE_WRITE_RATE_LIMIT_PER_MINUTE;
}

function controllerStateRetryAfterSeconds() {
  return Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
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

  const supplied = String(req.body?.adminCode || '');
  if (supplied.length > AUTH_SECRET_INPUT_MAX_CHARS) {
    send(res, 400, { ok: false, code: 'MASTER_ADMIN_CODE_INPUT_TOO_LARGE' });
    return false;
  }

  const key = masterAdminFailureKey(device);
  const existing = Number(await redis(['GET', key])) || 0;
  if (existing >= MASTER_ADMIN_FAILURE_LIMIT) {
    const ttl = Number(await redis(['TTL', key])) || MASTER_ADMIN_LOCK_SECONDS;
    send(res, 429, { ok: false, code: 'MASTER_ADMIN_LOCKED', retryAfterSeconds: Math.max(1, ttl) });
    return false;
  }

  if (!timingSafeEqualText(supplied, MASTER_ADMIN_CODE)) {
    const failures = await incrementWithExpiry(key, MASTER_ADMIN_LOCK_SECONDS);
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

function engineInstanceHeader(req) {
  const raw = req?.headers?.['x-zenith-engine-instance'] ?? req?.headers?.['X-Zenith-Engine-Instance'];
  return Array.isArray(raw) ? String(raw[0] || '').trim() : String(raw || '').trim();
}

function validEngineInstanceId(value) {
  return /^engine-instance-[A-Za-z0-9._:-]{16,96}$/.test(String(value || ''));
}

async function verifyEngineBootstrapSecret(req, res) {
  if (!ENGINE_BOOTSTRAP_SECRET) {
    send(res, 503, { ok:false, code:'ENGINE_BOOTSTRAP_NOT_CONFIGURED' });
    return false;
  }

  const blockers = engineBootstrapSecretPolicyBlockers();
  if (blockers.length) {
    send(res, 503, { ok:false, code:'ENGINE_BOOTSTRAP_SECURITY_POLICY_BLOCKED', blockers });
    return false;
  }

  const supplied = bearerToken(req);
  if (supplied.length > AUTH_SECRET_INPUT_MAX_CHARS) {
    send(res, 400, { ok:false, code:'ENGINE_BOOTSTRAP_SECRET_INPUT_TOO_LARGE' });
    return false;
  }
  if (!timingSafeEqualText(supplied, ENGINE_BOOTSTRAP_SECRET)) {
    send(res, 401, { ok:false, code:'ENGINE_BOOTSTRAP_UNAUTHORIZED' });
    return false;
  }
  return true;
}

function controllerAdminRecoveryFailureKey(req) {
  return `${PREFIX}:controller-admin-recovery-fail:${sha256(clientIp(req))}`;
}

async function verifyControllerRecoveryAdminCode(req, res) {
  if (!MASTER_ADMIN_CODE) {
    send(res, 503, { ok: false, code: 'MASTER_ADMIN_NOT_CONFIGURED' });
    return false;
  }

  const policyBlockers = adminSecretPolicyBlockers();
  if (policyBlockers.length) {
    send(res, 503, { ok: false, code: policyBlockers[0] });
    return false;
  }

  const supplied = String(req.body?.adminCode || '');
  if (supplied.length > AUTH_SECRET_INPUT_MAX_CHARS) {
    send(res, 400, { ok: false, code: 'MASTER_ADMIN_CODE_INPUT_TOO_LARGE' });
    return false;
  }

  const key = controllerAdminRecoveryFailureKey(req);
  const existing = Number(await redis(['GET', key])) || 0;
  if (existing >= MASTER_ADMIN_FAILURE_LIMIT) {
    const ttl = Number(await redis(['TTL', key])) || MASTER_ADMIN_LOCK_SECONDS;
    send(res, 429, { ok: false, code: 'MASTER_ADMIN_LOCKED', retryAfterSeconds: Math.max(1, ttl) });
    return false;
  }

  if (!timingSafeEqualText(supplied, MASTER_ADMIN_CODE)) {
    const failures = await incrementWithExpiry(key, MASTER_ADMIN_LOCK_SECONDS);
    if (failures >= MASTER_ADMIN_FAILURE_LIMIT) {
      send(res, 429, { ok: false, code: 'MASTER_ADMIN_LOCKED', retryAfterSeconds: MASTER_ADMIN_LOCK_SECONDS });
    } else {
      send(res, 401, {
        ok: false,
        code: 'MASTER_ADMIN_CODE_INVALID',
        attemptsRemaining: Math.max(0, MASTER_ADMIN_FAILURE_LIMIT - failures),
      });
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

async function authDevice(req, allowBearer = false) {
  const cookie = cookieToken(req);
  const bearer = allowBearer ? bearerToken(req) : '';
  const candidates = [];
  if (cookie) candidates.push({ token: cookie, credentialSource: 'cookie' });
  if (bearer && bearer !== cookie) candidates.push({ token: bearer, credentialSource: 'bearer' });

  for (const candidate of candidates) {
    const hash = sha256(candidate.token);
    const raw = await redis(['GET', `${PREFIX}:device:${hash}`]);
    if (!raw) continue;
    try {
      const device = JSON.parse(raw);
      if (!device?.deviceId || !['controller', 'master'].includes(device?.role)) continue;
      return {
        ...device,
        tokenHash: hash,
        sessionToken: candidate.token,
        credentialSource: candidate.credentialSource,
      };
    } catch {}
  }
  return null;
}

function roleDeviceKey(role) {
  return role === 'master' ? KEY_MASTER_DEVICE : KEY_CONTROLLER_DEVICE;
}

async function verifyRoleDevice(role, device) {
  const deviceId = String(device?.deviceId || '');
  const [current, issuedAt] = await Promise.all([
    redis(['GET', roleDeviceKey(role)]),
    redis(['GET', roleAssignmentKey(PREFIX, role)]),
  ]);
  return Boolean(current) &&
    String(current) === deviceId &&
    deviceRoleAssignmentActive(device, issuedAt);
}

async function roleDeviceId(role) {
  const value = await redis(['GET', roleDeviceKey(role)]);
  return value ? String(value) : '';
}

function deviceSessionRemainingSeconds(device, now = Date.now()) {
  const createdAt = Number(device?.createdAt || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 0;
  const absoluteExpiresAt = createdAt + DEVICE_SESSION_MAX_AGE_SECONDS * 1000;
  return Math.max(0, Math.ceil((absoluteExpiresAt - now) / 1000));
}

async function touchDevice(device) {
  if (!device?.tokenHash) return { expired:true, remainingSeconds:0 };
  const remainingSeconds = deviceSessionRemainingSeconds(device);
  const key = `${PREFIX}:device:${device.tokenHash}`;
  if (remainingSeconds <= 0) {
    await redis(['DEL', key]);
    return { expired:true, remainingSeconds:0 };
  }
  const updated = { ...device, lastSeenAt: Date.now() };
  delete updated.tokenHash;
  delete updated.sessionToken;
  await redis(['SET', key, JSON.stringify(updated), 'EX', String(remainingSeconds)]);
  return { expired:false, remainingSeconds };
}

async function rotateLegacyBearerSession(device) {
  if (!device?.tokenHash || device.credentialSource !== 'bearer') {
    return { ok:false, reason:'BEARER_MIGRATION_NOT_REQUIRED' };
  }

  const remainingSeconds = deviceSessionRemainingSeconds(device);
  if (remainingSeconds <= 0) {
    await redis(['DEL', `${PREFIX}:device:${device.tokenHash}`]);
    return { ok:false, reason:'DEVICE_SESSION_EXPIRED' };
  }

  const newToken = crypto.randomBytes(32).toString('base64url');
  const newTokenHash = sha256(newToken);
  const updated = { ...device, lastSeenAt: Date.now() };
  delete updated.tokenHash;
  delete updated.sessionToken;
  delete updated.credentialSource;

  const script = [
    "local currentRole = tostring(redis.call('GET', KEYS[3]) or '')",
    "if currentRole ~= ARGV[1] then return -1 end",
    "local old = redis.call('GET', KEYS[1])",
    "if not old then return 0 end",
    "redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])",
    "redis.call('DEL', KEYS[1])",
    "return 1"
  ].join('\n');

  const result = Number(await redis([
    'EVAL', script, '3',
    `${PREFIX}:device:${device.tokenHash}`,
    `${PREFIX}:device:${newTokenHash}`,
    roleDeviceKey(device.role),
    String(device.deviceId),
    JSON.stringify(updated),
    String(remainingSeconds),
  ]));

  if (result === -1) return { ok:false, reason:'ROLE_DEVICE_CONFLICT' };
  if (result !== 1) return { ok:false, reason:'LEGACY_BEARER_ALREADY_USED' };

  return {
    ok:true,
    token:newToken,
    remainingSeconds,
    device:{ ...updated, tokenHash:newTokenHash, credentialSource:'cookie' },
  };
}

async function requireDevice(req, res, roles, { allowBearer = false, rotateBearer = false } = {}) {
  const device = await authDevice(req, allowBearer);
  if (!device) {
    clearDeviceSessionCookie(res);
    send(res, 401, { ok: false, code: 'UNAUTHORIZED_DEVICE' });
    return null;
  }
  if (roles && !roles.includes(device.role)) {
    send(res, 403, { ok: false, code: 'ROLE_FORBIDDEN' });
    return null;
  }
  if (!(await verifyRoleDevice(device.role, device))) {
    clearDeviceSessionCookie(res);
    send(res, 409, { ok: false, code: 'ROLE_DEVICE_CONFLICT' });
    return null;
  }

  if (device.principal === 'engine') {
    const suppliedInstance = engineInstanceHeader(req);
    const expectedInstance = String(device.engineInstanceId || '');
    const currentInstance = String(await redis(['GET', KEY_ENGINE_INSTANCE]) || '');
    if (!validEngineInstanceId(suppliedInstance) ||
        !expectedInstance ||
        !timingSafeEqualText(suppliedInstance, expectedInstance) ||
        !currentInstance ||
        !timingSafeEqualText(suppliedInstance, currentInstance)) {
      clearDeviceSessionCookie(res);
      send(res, 409, { ok:false, code:'ENGINE_INSTANCE_FENCED' });
      return null;
    }
  }

  if (rotateBearer && device.credentialSource === 'bearer') {
    const migration = await rotateLegacyBearerSession(device);
    if (!migration.ok) {
      clearDeviceSessionCookie(res);
      send(res, migration.reason === 'ROLE_DEVICE_CONFLICT' ? 409 : 401, {
        ok:false,
        code:migration.reason,
      });
      return null;
    }
    setDeviceSessionCookie(res, migration.token, migration.remainingSeconds);
    const safeDevice = { ...migration.device };
    delete safeDevice.sessionToken;
    delete safeDevice.credentialSource;
    return safeDevice;
  }

  const session = await touchDevice(device);
  if (session.expired) {
    clearDeviceSessionCookie(res);
    send(res, 401, { ok:false, code:'DEVICE_SESSION_EXPIRED' });
    return null;
  }
  setDeviceSessionCookie(res, device.sessionToken, session.remainingSeconds);
  const safeDevice = { ...device };
  delete safeDevice.sessionToken;
  delete safeDevice.credentialSource;
  return safeDevice;
}

async function renewEngineInstance(device) {
  if (device?.principal !== 'engine') return { ok:true, reason:'' };
  const instanceId = String(device.engineInstanceId || '');
  if (!validEngineInstanceId(instanceId)) return { ok:false, reason:'ENGINE_INSTANCE_INVALID' };
  const script = [
    "local currentInstance = tostring(redis.call('GET', KEYS[1]) or '')",
    "if currentInstance ~= ARGV[1] then return -1 end",
    "local registeredMaster = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registeredMaster ~= ARGV[2] then return -2 end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[3]) or '')",
    "if roleEpoch ~= ARGV[3] then return -3 end",
    "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])",
    "return 1"
  ].join('\n');
  const result = Number(await redis([
    'EVAL', script, '3',
    KEY_ENGINE_INSTANCE,
    KEY_MASTER_DEVICE,
    roleAssignmentKey(PREFIX, 'master'),
    instanceId,
    String(device.deviceId || ''),
    String(Number(device.createdAt || 0)),
    String(ENGINE_INSTANCE_TTL_SECONDS),
  ]));
  return {
    ok: result === 1,
    reason: result === -1 ? 'ENGINE_INSTANCE_FENCED'
      : result === -2 ? 'MASTER_ROLE_CHANGED'
        : result === -3 ? 'MASTER_SESSION_REVOKED'
          : result === 1 ? '' : 'ENGINE_INSTANCE_RENEW_FAILED',
  };
}

async function persistEngineRestartAuthorization(device, createAllowed = false) {
  if (device?.principal !== 'engine') return { ok:true, authorized:false, created:false };
  const instanceId = String(device.engineInstanceId || '');
  const masterDeviceId = String(device.deviceId || '');
  const roleEpoch = String(Number(device.createdAt || 0));
  const authorizedAt = Date.now();
  const record = {
    version:1,
    masterDeviceId,
    authorizedAt,
  };
  const audit = {
    at:authorizedAt,
    kind:'ENGINE_RESTART_AUTHORIZED',
    masterDeviceId,
    roleEpoch,
    engineInstanceHash:sha256(instanceId).slice(0, 16),
  };
  const script = [
    "local currentInstance = tostring(redis.call('GET', KEYS[1]) or '')",
    "if currentInstance ~= ARGV[1] then return -1 end",
    "local registeredMaster = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registeredMaster ~= ARGV[2] then return -2 end",
    "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
    "if lease ~= ARGV[2] then return -3 end",
    "local currentEpoch = tostring(redis.call('GET', KEYS[4]) or '')",
    "if currentEpoch ~= ARGV[3] then return -4 end",
    "local existingRaw = redis.call('GET', KEYS[5])",
    "if existingRaw then",
    "  local ok, existing = pcall(cjson.decode, existingRaw)",
    "  if ok and tonumber(existing['version'] or 0) == 1 and tostring(existing['masterDeviceId'] or '') == ARGV[2] then return 2 end",
    "end",
    "if ARGV[6] ~= '1' then return 0 end",
    "redis.call('SET', KEYS[5], ARGV[4])",
    "redis.call('LPUSH', KEYS[6], ARGV[5])",
    "redis.call('LTRIM', KEYS[6], 0, 199)",
    "return 1"
  ].join('\n');
  const result = Number(await redis([
    'EVAL', script, '6',
    KEY_ENGINE_INSTANCE,
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    KEY_ENGINE_AUTHORIZED,
    KEY_AUDIT,
    instanceId,
    masterDeviceId,
    roleEpoch,
    JSON.stringify(record),
    JSON.stringify(audit),
    createAllowed ? '1' : '0',
  ]));
  return {
    ok: result >= 0,
    authorized: result === 1 || result === 2,
    created: result === 1,
    reason: result === -1 ? 'ENGINE_INSTANCE_FENCED'
      : result === -2 ? 'MASTER_ROLE_CHANGED'
        : result === -3 ? 'MASTER_LEASE_REQUIRED'
          : result === -4 ? 'MASTER_SESSION_REVOKED'
            : result < 0 ? 'ENGINE_RESTART_AUTHORIZATION_FAILED' : '',
  };
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

async function acquireOrRenewMaster(device) {
  const deviceId = String(device?.deviceId || '');
  const sessionCreatedAt = String(Number(device?.createdAt || 0));
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[3]) or '')",
    "if registered ~= ARGV[1] then return -2 end",
    "local roleIssuedAt = tonumber(redis.call('GET', KEYS[4]) or '0') or 0",
    "local sessionCreatedAt = tonumber(ARGV[3]) or 0",
    "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
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
    'EVAL', script, '4',
    KEY_MASTER,
    masterActivationKey(deviceId),
    KEY_MASTER_DEVICE,
    roleAssignmentKey(PREFIX, 'master'),
    deviceId,
    String(MASTER_TTL_SECONDS),
    sessionCreatedAt,
  ]));

  return {
    acquired: result === 1,
    renewed: result === 2,
    conflict: result === -1,
    roleChanged: result === -2,
    sessionRevoked: result === -3,
    authorized: result === 1 || result === 2,
  };
}

async function commitMasterHeartbeat(heartbeat, device) {
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registered ~= ARGV[2] then return -1 end",
    "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
    "if lease ~= ARGV[2] then return -2 end",
    "local roleIssuedAt = tonumber(redis.call('GET', KEYS[4]) or '0') or 0",
    "local sessionCreatedAt = tonumber(ARGV[3]) or 0",
    "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
    "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '4',
    KEY_MASTER_HEARTBEAT,
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    JSON.stringify(heartbeat),
    String(device?.deviceId || ''),
    String(Number(device?.createdAt || 0)),
    String(MASTER_HEARTBEAT_TTL_SECONDS),
  ]));
}

async function emergencyStopActive() {
  const value = await redis(['GET', KEY_EMERGENCY_STOP]);
  if (value === null || value === undefined || value === '') return true;
  return String(value) !== '0';
}

async function assertEmergencyStop() {
  const script = [
    "redis.call('SET', KEYS[1], '1')",
    "local epoch = redis.call('INCR', KEYS[2])",
    "return epoch"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '2',
    KEY_EMERGENCY_STOP,
    KEY_EMERGENCY_STOP_EPOCH,
  ])) || 0;
}

async function realExecutionArmStatus(expectedMasterDeviceId = '') {
  const [raw, registeredMaster, leasedMaster, masterRoleEpochRaw] = await Promise.all([
    redis(['GET', KEY_REAL_EXECUTION_ARMED]),
    redis(['GET', KEY_MASTER_DEVICE]),
    redis(['GET', KEY_MASTER]),
    redis(['GET', roleAssignmentKey(PREFIX, 'master')]),
  ]);
  const record = parseStoredJson(raw);
  if (!record || record.version !== 1) return { armed:false, reason:'REAL_EXECUTION_NOT_ARMED', record:null };
  const recordMaster = String(record.masterDeviceId || '');
  if (!registeredMaster || recordMaster !== String(registeredMaster)) {
    return { armed:false, reason:'REAL_EXECUTION_ARM_MASTER_CHANGED', record };
  }
  if (!leasedMaster || recordMaster !== String(leasedMaster)) {
    return { armed:false, reason:'MASTER_LEASE_REQUIRED', record };
  }
  if (!masterRoleEpochRaw || String(record.masterRoleEpoch || '') !== String(masterRoleEpochRaw)) {
    return { armed:false, reason:'REAL_EXECUTION_ARM_ROLE_EPOCH_CHANGED', record };
  }
  if (!REAL_TRADING_ENABLED) return { armed:false, reason:'REAL_TRADING_DISABLED', record };
  const adminSecretBlockers = adminSecretPolicyBlockers();
  if (adminSecretBlockers.length) return { armed:false, reason:adminSecretBlockers[0], blockers:adminSecretBlockers, record };
  const credentialSeparationBlockers = binanceCredentialSeparationBlockers();
  if (credentialSeparationBlockers.length) {
    return { armed:false, reason:credentialSeparationBlockers[0], blockers:credentialSeparationBlockers, record };
  }
  if (!BINANCE_WRITE_ENABLED) return { armed:false, reason:'BINANCE_WRITE_DISABLED', record };
  if (!VERCEL_PRODUCTION_WRITE_ALLOWED) return { armed:false, reason:'NON_PRODUCTION_DEPLOYMENT', record };
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
    if (!/^zth-MAX-[A-Za-z0-9._:-]+$/.test(String(order?.clientAlgoId || ''))) return false;
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

function commandRawStatus(raw) {
  const value = String(raw || '');
  if (!value) return { ok:false, reason:'RAW_REQUIRED', bytes:0 };
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > COMMAND_RAW_MAX_BYTES) {
    return { ok:false, reason:'COMMAND_RAW_TOO_LARGE', bytes, maxBytes:COMMAND_RAW_MAX_BYTES };
  }
  return { ok:true, value, bytes, maxBytes:COMMAND_RAW_MAX_BYTES };
}

function executionGate(type, halted) {
  const normalized = String(type || '').toUpperCase();
  if (!normalized.startsWith('EXEC_')) return { allowed: true, reason: '' };
  if (!REAL_TRADING_ENABLED) return { allowed: false, reason: 'REAL_TRADING_DISABLED' };
  if (!BINANCE_WRITE_ENABLED) return { allowed: false, reason: 'BINANCE_WRITE_DISABLED' };
  if (!VERCEL_PRODUCTION_WRITE_ALLOWED) return { allowed: false, reason: 'NON_PRODUCTION_DEPLOYMENT' };
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

async function trySetMasterRunningFrom(
  expectedMode,
  expectedMasterDeviceId,
  expectedMasterRoleEpochRaw = '0',
  requesterDevice = null
) {
  const expected = normalizeMasterMode(expectedMode);
  const expectedMaster = String(expectedMasterDeviceId || '');
  const expectedRoleEpoch = String(expectedMasterRoleEpochRaw || '0');
  const requesterRole = String(requesterDevice?.role || '').toLowerCase();
  const requesterId = String(requesterDevice?.deviceId || '');
  const requesterCreatedAt = String(Number(requesterDevice?.createdAt || 0));
  const script = [
    "local panic = tostring(redis.call('GET', KEYS[1]) or '')",
    "local mode = tostring(redis.call('GET', KEYS[2]) or 'PAUSED')",
    "if ARGV[2] == '1' and panic ~= '0' then return {-1, mode} end",
    "if mode ~= ARGV[1] then return {-2, mode} end",
    "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
    "local registered = tostring(redis.call('GET', KEYS[4]) or '')",
    "if lease ~= ARGV[3] or registered ~= ARGV[3] then return {-3, mode} end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[5]) or '0')",
    "if roleEpoch ~= ARGV[4] then return {-4, mode} end",
    "local requester = tostring(redis.call('GET', KEYS[6]) or '')",
    "if requester ~= ARGV[5] then return {-5, mode} end",
    "local requesterEpoch = tonumber(redis.call('GET', KEYS[7]) or '0') or 0",
    "local requesterCreatedAt = tonumber(ARGV[6]) or 0",
    "if requesterEpoch > 0 and requesterCreatedAt < requesterEpoch then return {-6, mode} end",
    "redis.call('SET', KEYS[2], 'RUNNING')",
    "return {1, 'RUNNING'}"
  ].join('\n');
  const result = await redis([
    'EVAL', script, '7',
    KEY_EMERGENCY_STOP,
    KEY_MASTER_MODE,
    KEY_MASTER,
    KEY_MASTER_DEVICE,
    roleAssignmentKey(PREFIX, 'master'),
    roleDeviceKey(requesterRole),
    roleAssignmentKey(PREFIX, requesterRole),
    expected,
    REAL_TRADING_ENABLED ? '1' : '0',
    expectedMaster,
    expectedRoleEpoch,
    requesterId,
    requesterCreatedAt,
  ]);
  const code = Number(Array.isArray(result) ? result[0] : 0);
  const mode = normalizeMasterMode(Array.isArray(result) ? result[1] : '');
  return {
    ok: code === 1,
    reason: code === -1
      ? 'EMERGENCY_STOP_ACTIVE'
      : code === -2
        ? 'MASTER_MODE_CHANGED'
        : code === -3
          ? 'MASTER_LEASE_REQUIRED'
          : code === -4
            ? 'MASTER_ROLE_CHANGED'
            : code === -5
              ? 'REQUESTER_ROLE_CHANGED'
              : code === -6
                ? 'REQUESTER_SESSION_REVOKED'
                : code === 1
                  ? ''
                  : 'MASTER_MODE_TRANSITION_FAILED',
    masterMode: mode,
  };
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

  const [runtimeRaw, pending, processing, masterRoleEpochRaw] = await Promise.all([
    redis(['GET', KEY_STATE]),
    redis(['LLEN', KEY_PENDING]),
    redis(['LLEN', KEY_PROCESSING]),
    redis(['GET', roleAssignmentKey(PREFIX, 'master')]),
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
    if (!masterRoleEpochRaw) blockers.push('MASTER_ROLE_CHANGED');
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

  const at = Date.now();
  const pauseAudit = JSON.stringify({
    at,
    kind: 'MASTER_PAUSE_COMPLETED',
    deviceId: String(deviceId || ''),
  });
  const finalizeScript = [
    "local mode = tostring(redis.call('GET', KEYS[1]) or 'PAUSED')",
    "local pending = tonumber(redis.call('LLEN', KEYS[2]) or '0') or 0",
    "local processing = tonumber(redis.call('LLEN', KEYS[3]) or '0') or 0",
    "if mode ~= 'PAUSE_PENDING' then return {-1, mode, pending, processing} end",
    "if pending > 0 then return {-2, mode, pending, processing} end",
    "if processing > 0 then return {-3, mode, pending, processing} end",
    "if ARGV[3] == '1' then",
    "  local lease = tostring(redis.call('GET', KEYS[5]) or '')",
    "  local registered = tostring(redis.call('GET', KEYS[6]) or '')",
    "  if lease ~= ARGV[1] or registered ~= ARGV[1] then return {-4, mode, pending, processing} end",
    "  local roleEpoch = tostring(redis.call('GET', KEYS[7]) or '')",
    "  if roleEpoch == '' or roleEpoch ~= ARGV[2] then return {-5, mode, pending, processing} end",
    "  local runtimeRaw = tostring(redis.call('GET', KEYS[8]) or '')",
    "  if runtimeRaw ~= ARGV[4] then return {-6, mode, pending, processing} end",
    "  local reconcileRaw = redis.call('GET', KEYS[9])",
    "  if not reconcileRaw then return {-7, mode, pending, processing} end",
    "  local ok, report = pcall(cjson.decode, reconcileRaw)",
    "  if not ok then return {-7, mode, pending, processing} end",
    "  local status = tostring(report['status'] or '')",
    "  local reasons = report['reasons'] or {}",
    "  local actual = report['actual'] or {}",
    "  if type(reasons) ~= 'table' or type(actual) ~= 'table' then return {-7, mode, pending, processing} end",
    "  if report['failClosed'] ~= false or (status ~= 'CLEAN_REAL' and status ~= 'CLEAN_IDLE') or #reasons > 0 then return {-7, mode, pending, processing} end",
    "  if tonumber(actual['positions'] or -1) ~= 0 or tonumber(actual['orders'] or -1) ~= 0 then return {-7, mode, pending, processing} end",
    "end",
    "redis.call('SET', KEYS[1], 'PAUSED')",
    "redis.call('LPUSH', KEYS[4], ARGV[5])",
    "redis.call('LTRIM', KEYS[4], 0, 199)",
    "return {1, 'PAUSED', 0, 0}"
  ].join('\n');

  const result = await redis([
    'EVAL', finalizeScript, '9',
    KEY_MASTER_MODE,
    KEY_PENDING,
    KEY_PROCESSING,
    KEY_AUDIT,
    KEY_MASTER,
    KEY_MASTER_DEVICE,
    roleAssignmentKey(PREFIX, 'master'),
    KEY_STATE,
    KEY_RECONCILE_LAST,
    String(deviceId || ''),
    String(masterRoleEpochRaw || ''),
    REAL_TRADING_ENABLED ? '1' : '0',
    String(runtimeRaw || ''),
    pauseAudit,
  ]);

  const resultCode = Number(Array.isArray(result) ? result[0] : 0);
  const committedMode = normalizeMasterMode(Array.isArray(result) ? result[1] : 'PAUSE_PENDING');
  const finalPending = Number(Array.isArray(result) ? result[2] : 0) || 0;
  const finalProcessing = Number(Array.isArray(result) ? result[3] : 0) || 0;

  if (resultCode !== 1) {
    const raceBlockers = [];
    if (resultCode === -2) raceBlockers.push('PENDING_COMMAND');
    else if (resultCode === -3) raceBlockers.push('PROCESSING_COMMAND');
    else if (resultCode === -4) raceBlockers.push('MASTER_LEASE_REQUIRED');
    else if (resultCode === -5) raceBlockers.push('MASTER_ROLE_CHANGED');
    else if (resultCode === -6) raceBlockers.push('MASTER_RUNTIME_CHANGED');
    else if (resultCode === -7) raceBlockers.push('BINANCE_RECONCILIATION_CHANGED');

    return {
      transitioned: false,
      masterMode: resultCode === -1 ? committedMode : 'PAUSE_PENDING',
      blockers: raceBlockers,
      activity,
      pendingCommands: finalPending,
      processingCommands: finalProcessing,
    };
  }

  return {
    transitioned: true,
    masterMode: 'PAUSED',
    blockers: [],
    activity,
    pendingCommands: 0,
    processingCommands: 0,
  };
}

async function recoverStaleProcessing(device) {
  const deviceId = String(device?.deviceId || '');
  const rows = await redis(['LRANGE', KEY_PROCESSING, '0', '-1']);
  const now = Date.now();
  let requeued = 0;
  let removedDone = 0;
  let dead = 0;

  for (const raw of Array.isArray(rows) ? rows : []) {
    let command = null;
    try { command = JSON.parse(raw); } catch {
      const removed = await removeProcessingAtomic(raw, device);
      if (removed < 0) return { requeued, removedDone, dead, authorityLost:true, authorityCode:removed };
      if (removed === 1) {
        await pushDeadLetter({ raw, rejectedAt: now, rejectedReason: 'COMMAND_CORRUPT' });
        dead += 1;
      }
      continue;
    }

    if (!commandTypeAllowed(command?.type) || commandExpired(command, now)) {
      const removed = await removeProcessingAtomic(raw, device);
      if (removed < 0) return { requeued, removedDone, dead, authorityLost:true, authorityCode:removed };
      if (removed === 1) {
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
        const removed = await removeProcessingAtomic(raw, device);
        if (removed < 0) return { requeued, removedDone, dead, authorityLost:true, authorityCode:removed };
        if (removed === 1) removedDone += 1;
        continue;
      }
    }

    const claimedAt = Number(command?.claimedAt || 0);
    if (!claimedAt || now - claimedAt <= COMMAND_CLAIM_TTL_MS) continue;

    if (String(command?.type || '').toUpperCase().startsWith('EXEC_')) {
      const halted = await emergencyStopActive();
      const gate = executionGate(command.type, halted);
      if (!gate.allowed) {
        const removed = await removeProcessingAtomic(raw, device);
        if (removed < 0) return { requeued, removedDone, dead, authorityLost:true, authorityCode:removed };
        if (removed === 1) {
          await pushDeadLetter({ raw, rejectedAt: now, rejectedReason: 'EXECUTION_LOCKED_' + gate.reason });
          dead += 1;
        }
        continue;
      }
    }

    const clean = { ...command };
    delete clean.claimedAt;
    delete clean.claimedBy;
    clean.recoveredAt = now;
    clean.recoveredBy = deviceId;
    const moved = await moveProcessingToPendingAtomic(
      raw,
      JSON.stringify(clean),
      device,
      'RPUSH'
    );
    if (moved < 0) return { requeued, removedDone, dead, authorityLost:true, authorityCode:moved };
    if (moved === 1) requeued += 1;
  }

  return { requeued, removedDone, dead, authorityLost:false, authorityCode:0 };
}

async function claimNextCommand(device) {
  const deviceId = String(device?.deviceId || '');
  const sessionCreatedAt = String(Number(device?.createdAt || 0));
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[4]) or '')",
    "if registered ~= ARGV[2] then return '__MASTER_ROLE_CHANGED__' end",
    "local lease = tostring(redis.call('GET', KEYS[5]) or '')",
    "if lease ~= ARGV[2] then return '__MASTER_LEASE_LOST__' end",
    "local roleIssuedAt = tonumber(redis.call('GET', KEYS[6]) or '0') or 0",
    "local sessionCreatedAt = tonumber(ARGV[4]) or 0",
    "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return '__MASTER_SESSION_REVOKED__' end",
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
    'EVAL', script, '6',
    KEY_PENDING,
    KEY_PROCESSING,
    KEY_DEAD,
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    String(Date.now()),
    deviceId,
    String(DEAD_LETTER_MAX),
    sessionCreatedAt,
  ]);
}

async function removeProcessingAtomic(raw, device) {
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registered ~= ARGV[2] then return -1 end",
    "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
    "if lease ~= ARGV[2] then return -2 end",
    "local roleIssuedAt = tonumber(redis.call('GET', KEYS[4]) or '0') or 0",
    "local sessionCreatedAt = tonumber(ARGV[3]) or 0",
    "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
    "return redis.call('LREM', KEYS[1], 1, ARGV[1])"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '4',
    KEY_PROCESSING,
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    raw,
    String(device?.deviceId || ''),
    String(Number(device?.createdAt || 0)),
  ]));
}

async function completeProcessingCommandAtomic(raw, commandId, device) {
  const doneKey = `${PREFIX}:command:done:${commandId || '__none__'}`;
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registered ~= ARGV[2] then return -1 end",
    "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
    "if lease ~= ARGV[2] then return -2 end",
    "local roleIssuedAt = tonumber(redis.call('GET', KEYS[4]) or '0') or 0",
    "local sessionCreatedAt = tonumber(ARGV[3]) or 0",
    "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
    "local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])",
    "if removed <= 0 then return 0 end",
    "if ARGV[4] == '1' then redis.call('SET', KEYS[5], ARGV[5], 'EX', ARGV[6]) end",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '5',
    KEY_PROCESSING,
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    doneKey,
    raw,
    String(device?.deviceId || ''),
    String(Number(device?.createdAt || 0)),
    commandId ? '1' : '0',
    String(Date.now()),
    String(60 * 60 * 24 * 30),
  ]));
}

function masterAuthorityMutationCode(code, suffix = '') {
  if (code === -1) return 'MASTER_ROLE_CHANGED' + suffix;
  if (code === -2) return 'MASTER_LEASE_LOST' + suffix;
  if (code === -3) return 'MASTER_SESSION_REVOKED' + suffix;
  return 'MASTER_AUTHORITY_CHANGED' + suffix;
}

async function rejectClaimedCommand(raw, reason, extra = {}, device) {
  const removed = await removeProcessingAtomic(raw, device);
  if (removed !== 1) return removed;
  await pushDeadLetter({
    raw,
    rejectedAt: Date.now(),
    rejectedReason: String(reason || 'COMMAND_REJECTED'),
    ...extra,
  });
  return 1;
}

async function moveProcessingToPendingAtomic(raw, nextRaw, device, pushMode = 'LPUSH') {
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[3]) or '')",
    "if registered ~= ARGV[3] then return -1 end",
    "local lease = tostring(redis.call('GET', KEYS[4]) or '')",
    "if lease ~= ARGV[3] then return -2 end",
    "local roleIssuedAt = tonumber(redis.call('GET', KEYS[5]) or '0') or 0",
    "local sessionCreatedAt = tonumber(ARGV[4]) or 0",
    "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
    "local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])",
    "if removed <= 0 then return 0 end",
    "if ARGV[5] == 'RPUSH' then",
    "  redis.call('RPUSH', KEYS[2], ARGV[2])",
    "else",
    "  redis.call('LPUSH', KEYS[2], ARGV[2])",
    "end",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '5',
    KEY_PROCESSING,
    KEY_PENDING,
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    raw,
    nextRaw,
    String(device?.deviceId || ''),
    String(Number(device?.createdAt || 0)),
    pushMode === 'RPUSH' ? 'RPUSH' : 'LPUSH',
  ]));
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

async function deferClaimedCommand(raw, command, reason, device, delayMs = 1500) {
  const deviceId = String(device?.deviceId || '');
  const clean = deferredCommandPayload(command, reason, deviceId, Date.now(), delayMs);
  const moved = await moveProcessingToPendingAtomic(
    raw,
    JSON.stringify(clean),
    device,
    'LPUSH'
  );
  return moved === 1;
}

export default async function handler(req, res) {
  const action = String(req.query?.action || 'health');
  const engineBootstrapRequest = action === 'engine-bootstrap' && req.method === 'POST';

  if (!sameOriginMutation(req) && !engineBootstrapRequest) {
    return send(res, 403, { ok: false, code: 'ORIGIN_FORBIDDEN' });
  }

  if (req.method === 'POST') {
    const bodyStatus = requestBodyStatus(req, 768 * 1024);
    if (!bodyStatus.ok) {
      return send(res, 413, { ok:false, code:'REQUEST_BODY_TOO_LARGE', maxBytes:bodyStatus.maxBytes });
    }
    if (!ZENITH_CONTROL_MUTATION_ALLOWED) {
      return send(res, 423, { ok:false, code:'NON_PRODUCTION_CONTROL_MUTATION' });
    }
  }

  if (action === 'health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      service: 'zenith-sync',
    });
  }

  try {

    if (action === 'engine-reenable' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller']);
      if (!device) return;
      if (!(await verifyMasterAdminCode(req, res, device))) return;

      const at = Date.now();
      const audit = JSON.stringify({
        at,
        kind:'ENGINE_ADMIN_REENABLED',
        requestedByDeviceId:device.deviceId,
      });
      const script = [
        "local controller = tostring(redis.call('GET', KEYS[1]) or '')",
        "if controller ~= ARGV[1] then return -1 end",
        "local controllerEpoch = tonumber(redis.call('GET', KEYS[2]) or '0') or 0",
        "local createdAt = tonumber(ARGV[2]) or 0",
        "if controllerEpoch > 0 and createdAt < controllerEpoch then return -2 end",
        "if tostring(redis.call('GET', KEYS[3]) or '') ~= '' then return -3 end",
        "if tostring(redis.call('GET', KEYS[4]) or '') ~= '' then return -4 end",
        "if tostring(redis.call('GET', KEYS[5]) or 'PAUSED') ~= 'PAUSED' then return -5 end",
        "if tostring(redis.call('GET', KEYS[6]) or '') ~= '1' then return -6 end",
        "if redis.call('LLEN', KEYS[7]) > 0 then return -7 end",
        "if redis.call('LLEN', KEYS[8]) > 0 then return -8 end",
        "if redis.call('GET', KEYS[9]) then return -9 end",
        "local disabled = tostring(redis.call('GET', KEYS[10]) or '')",
        "if disabled ~= '1' then return 2 end",
        "redis.call('DEL', KEYS[10])",
        "redis.call('LPUSH', KEYS[11], ARGV[3])",
        "redis.call('LTRIM', KEYS[11], 0, 199)",
        "return 1"
      ].join('\n');
      const result = Number(await redis([
        'EVAL', script, '11',
        KEY_CONTROLLER_DEVICE,
        roleAssignmentKey(PREFIX, 'controller'),
        KEY_MASTER_DEVICE,
        KEY_MASTER,
        KEY_MASTER_MODE,
        KEY_EMERGENCY_STOP,
        KEY_PENDING,
        KEY_PROCESSING,
        KEY_USER_STREAM_MUTATION_LOCK,
        KEY_ENGINE_DISABLED,
        KEY_AUDIT,
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
        audit,
      ]));
      if (result === -1 || result === -2) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok:false,
          code:result === -2 ? 'CONTROLLER_SESSION_REVOKED' : 'CONTROLLER_ROLE_CHANGED',
        });
      }
      if (result < 0) {
        const blocker = result === -3 ? 'MASTER_STILL_REGISTERED'
          : result === -4 ? 'MASTER_LEASE_ACTIVE'
          : result === -5 ? 'MASTER_MUST_BE_PAUSED'
          : result === -6 ? 'EMERGENCY_STOP_MUST_BE_ACTIVE'
          : result === -7 ? 'PENDING_COMMAND'
          : result === -8 ? 'PROCESSING_COMMAND'
          : 'USER_STREAM_MUTATION_IN_FLIGHT';
        return send(res, 409, { ok:false, code:'ENGINE_REENABLE_BLOCKED', blocker });
      }
      return send(res, 200, {
        ok:true,
        engineReenabled:true,
        alreadyEnabled:result === 2,
        masterMode:'PAUSED',
        emergencyStopActive:true,
      });
    }

    if (action === 'engine-bootstrap' && req.method === 'POST') {
      if (!(await engineBootstrapRateAllowed(req))) {
        return send(res, 429, { ok:false, code:'ENGINE_BOOTSTRAP_RATE_LIMIT' });
      }
      if (!(await verifyEngineBootstrapSecret(req, res))) return;

      const instanceId = String(req.body?.instanceId || '').trim();
      if (!validEngineInstanceId(instanceId)) {
        return send(res, 400, { ok:false, code:'ENGINE_INSTANCE_ID_INVALID' });
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = sha256(token);
      const createdAt = Date.now();
      const record = {
        deviceId: ENGINE_MASTER_DEVICE_ID,
        role: 'master',
        principal: 'engine',
        engineInstanceId: instanceId,
        deviceName: 'Zenith 24/7 Server Engine',
        createdAt,
        lastSeenAt: createdAt,
      };
      const audit = {
        at: createdAt,
        kind: 'ENGINE_MASTER_BOOTSTRAPPED',
        masterDeviceId: ENGINE_MASTER_DEVICE_ID,
        engineInstanceHash: sha256(instanceId).slice(0, 16),
      };

      const bootstrapScript = [
        "local disabled = tostring(redis.call('GET', KEYS[17]) or '')",
        "if disabled == '1' then return {-7, '', 0, 0, 0} end",
        "local registeredMaster = tostring(redis.call('GET', KEYS[1]) or '')",
        "if registeredMaster ~= '' and registeredMaster ~= ARGV[1] then return {-1, registeredMaster, 0, 0, 0} end",
        "local currentInstance = tostring(redis.call('GET', KEYS[4]) or '')",
        "local currentLease = tostring(redis.call('GET', KEYS[5]) or '')",
        "if currentLease ~= '' and currentLease ~= ARGV[1] then return {-3, currentLease, 0, 0, 0} end",
        "if currentInstance ~= '' and currentInstance ~= ARGV[5] and currentLease == ARGV[1] then return {-2, '', 0, 0, 0} end",
        "local streamLock = tostring(redis.call('GET', KEYS[16]) or '')",
        "if registeredMaster ~= '' and streamLock ~= '' then return {-6, '', 0, 0, 0} end",
        "local mode = tostring(redis.call('GET', KEYS[6]) or 'PAUSED')",
        "local panic = tostring(redis.call('GET', KEYS[7]) or '')",
        "if registeredMaster == '' and mode ~= 'PAUSED' then return {-4, mode, 0, 0, 0} end",
        "if registeredMaster == '' and panic ~= '1' then return {-5, panic, 0, 0, 0} end",
        "local oldRoleEpoch = tostring(redis.call('GET', KEYS[2]) or '')",
        "local authorized = 0",
        "if registeredMaster == ARGV[1] then",
        "  local authorizationRaw = redis.call('GET', KEYS[9])",
        "  if authorizationRaw then",
        "    local authOk, authorization = pcall(cjson.decode, authorizationRaw)",
        "    if authOk and tonumber(authorization['version'] or 0) == 1 and tostring(authorization['masterDeviceId'] or '') == ARGV[1] then authorized = 1 end",
        "  end",
        "end",
        "local armCarried = 0",
        "local failClosed = 0",
        "if authorized == 1 then",
        "  redis.call('SET', KEYS[5], ARGV[1], 'EX', ARGV[8])",
        "  local armRaw = redis.call('GET', KEYS[10])",
        "  if armRaw and ARGV[9] ~= '' and oldRoleEpoch ~= '' then",
        "    local armOk, arm = pcall(cjson.decode, armRaw)",
        "    if armOk and tonumber(arm['version'] or 0) == 1 and tostring(arm['masterDeviceId'] or '') == ARGV[1] and tostring(arm['masterRoleEpoch'] or '') == oldRoleEpoch and tostring(arm['deploymentSha'] or '') == ARGV[9] then",
        "      arm['masterRoleEpoch'] = tonumber(ARGV[2])",
        "      redis.call('SET', KEYS[10], cjson.encode(arm))",
        "      armCarried = 1",
        "    end",
        "  end",
        "  if armCarried == 0 and mode == 'RUNNING' then",
        "    redis.call('SET', KEYS[7], '1')",
        "    redis.call('SET', KEYS[6], 'PAUSE_PENDING')",
        "    failClosed = 1",
        "  end",
        "else",
        "  if registeredMaster == '' then",
        "    redis.call('DEL', KEYS[9])",
        "    redis.call('DEL', KEYS[10])",
        "  end",
        "end",
        "redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[6])",
        "redis.call('SET', KEYS[1], ARGV[1])",
        "redis.call('SET', KEYS[2], ARGV[2])",
        "redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])",
        "redis.call('DEL', KEYS[11])",
        "redis.call('DEL', KEYS[12])",
        "redis.call('DEL', KEYS[13])",
        "redis.call('DEL', KEYS[14])",
        "redis.call('DEL', KEYS[15])",
        "redis.call('LPUSH', KEYS[8], ARGV[7])",
        "redis.call('LTRIM', KEYS[8], 0, 199)",
        "if registeredMaster == '' then return {1, ARGV[1], authorized, armCarried, failClosed} end",
        "return {2, ARGV[1], authorized, armCarried, failClosed}"
      ].join('\n');

      const result = await redis([
        'EVAL', bootstrapScript, '17',
        KEY_MASTER_DEVICE,
        roleAssignmentKey(PREFIX, 'master'),
        `${PREFIX}:device:${tokenHash}`,
        KEY_ENGINE_INSTANCE,
        KEY_MASTER,
        KEY_MASTER_MODE,
        KEY_EMERGENCY_STOP,
        KEY_AUDIT,
        KEY_ENGINE_AUTHORIZED,
        KEY_REAL_EXECUTION_ARMED,
        KEY_MASTER_HEARTBEAT,
        KEY_MASTER_CONFIG_ACK,
        KEY_RECONCILE_LAST,
        KEY_STATE,
        KEY_USER_STREAM_SESSION,
        KEY_USER_STREAM_MUTATION_LOCK,
        KEY_ENGINE_DISABLED,
        ENGINE_MASTER_DEVICE_ID,
        String(createdAt),
        JSON.stringify(record),
        String(DEVICE_SESSION_MAX_AGE_SECONDS),
        instanceId,
        String(ENGINE_INSTANCE_TTL_SECONDS),
        JSON.stringify(audit),
        String(MASTER_TTL_SECONDS),
        DEPLOYMENT_SHA,
      ]);
      const code = Number(Array.isArray(result) ? result[0] : 0);
      const restartAuthorized = Number(Array.isArray(result) ? result[2] : 0) === 1;
      const realExecutionArmCarried = Number(Array.isArray(result) ? result[3] : 0) === 1;
      const restartFailClosed = Number(Array.isArray(result) ? result[4] : 0) === 1;
      if (code === -1) {
        return send(res, 409, {
          ok:false,
          code:'ENGINE_CUTOVER_REQUIRED',
          registeredMaster:String(result?.[1] || ''),
        });
      }
      if (code === -2) {
        return send(res, 409, { ok:false, code:'ENGINE_INSTANCE_ACTIVE' });
      }
      if (code === -3) {
        return send(res, 409, { ok:false, code:'MASTER_LEASE_CONFLICT' });
      }
      if (code === -4 || code === -5) {
        return send(res, 423, {
          ok:false,
          code:'ENGINE_INITIAL_CUTOVER_NOT_SAFE',
          blocker:code === -4 ? 'MASTER_MUST_BE_PAUSED' : 'EMERGENCY_STOP_MUST_BE_ACTIVE',
        });
      }
      if (code === -6) {
        return send(res, 409, { ok:false, code:'ENGINE_RESTART_MUTATION_IN_FLIGHT' });
      }
      if (code === -7) {
        return send(res, 423, { ok:false, code:'ENGINE_ADMIN_REENABLE_REQUIRED' });
      }
      if (![1,2].includes(code)) {
        return send(res, 500, { ok:false, code:'ENGINE_BOOTSTRAP_FAILED' });
      }

      setDeviceSessionCookie(res, token);
      return send(res, 200, {
        ok:true,
        sessionReady:true,
        engine:true,
        initialRegistration:code === 1,
        restartAuthorized,
        realExecutionArmCarried,
        restartFailClosed,
        masterDeviceId:ENGINE_MASTER_DEVICE_ID,
        engineInstanceId:instanceId,
        roleEpoch:createdAt,
        instanceTtlSeconds:ENGINE_INSTANCE_TTL_SECONDS,
      });
    }

    if (action === 'pair' && req.method === 'POST') {
      if (PAIRING_DISABLED) return send(res, 403, { ok: false, code: 'PAIRING_DISABLED' });
      if (!(await pairRateAllowed(req))) return send(res, 429, { ok: false, code: 'PAIRING_RATE_LIMIT' });

      const supplied = String(req.body?.pairingCode || '');
      if (supplied.length > AUTH_SECRET_INPUT_MAX_CHARS) {
        return send(res, 400, { ok: false, code: 'PAIRING_CODE_INPUT_TOO_LARGE' });
      }
      const deviceId = String(req.body?.deviceId || '').trim();
      const role = String(req.body?.role || '').trim();
      const deviceName = String(req.body?.deviceName || '').trim().slice(0, 80);

      if (!validDeviceId(deviceId) || !['controller', 'master'].includes(role)) {
        return send(res, 400, { ok: false, code: 'PAIRING_REQUEST_INVALID' });
      }

      const expectedPairingCode = role === 'master' ? MASTER_PAIRING_CODE : PAIRING_CODE;
      if (!expectedPairingCode) {
        return send(res, 503, {
          ok: false,
          code: role === 'master' ? 'MASTER_PAIRING_NOT_CONFIGURED' : 'PAIRING_NOT_CONFIGURED'
        });
      }

      const pairingPolicyBlockers = pairingSecretPolicyBlockers({ role });
      if (pairingPolicyBlockers.length) {
        return send(res, 503, {
          ok: false,
          code: 'PAIRING_SECURITY_POLICY_BLOCKED',
          blockers: pairingPolicyBlockers,
        });
      }

      if (!timingSafeEqualText(supplied, expectedPairingCode)) {
        return send(res, 401, { ok: false, code: 'PAIRING_CODE_INVALID' });
      }

      const claimedDeviceId = await roleDeviceId(role);
      if (claimedDeviceId && claimedDeviceId !== deviceId) {
        return send(res, 409, { ok: false, code: 'ROLE_DEVICE_CONFLICT' });
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = sha256(token);
      const createdAt = Date.now();
      const record = {
        deviceId,
        role,
        deviceName,
        createdAt,
        lastSeenAt: createdAt,
      };
      const pairSessionScript = [
        "local current = redis.call('GET', KEYS[1])",
        "if current and current ~= ARGV[1] then return 0 end",
        "redis.call('SET', KEYS[1], ARGV[1])",
        "redis.call('SET', KEYS[2], ARGV[2])",
        "redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])",
        "return 1"
      ].join('\n');
      const pairResult = Number(await redis([
        'EVAL', pairSessionScript, '3',
        roleDeviceKey(role),
        roleAssignmentKey(PREFIX, role),
        `${PREFIX}:device:${tokenHash}`,
        String(deviceId),
        String(createdAt),
        JSON.stringify(record),
        String(DEVICE_SESSION_MAX_AGE_SECONDS),
      ]));
      if (pairResult !== 1) {
        return send(res, 409, { ok: false, code: 'ROLE_DEVICE_CONFLICT' });
      }
      setDeviceSessionCookie(res, token);
      return send(res, 201, { ok: true, sessionReady: true, device: record });
    }

    if (action === 'controller-replacement-authorize' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'MASTER_LEASE_REQUIRED' });
      }

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
      const audit = {
        at: createdAt,
        kind: 'CONTROLLER_REPLACEMENT_AUTHORIZED',
        masterDeviceId: device.deviceId,
        oldControllerDeviceId,
        expiresAt,
      };
      const replacementAuthorizeScript = [
        "local registeredMaster = tostring(redis.call('GET', KEYS[2]) or '')",
        "if registeredMaster ~= ARGV[1] then return -1 end",
        "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
        "if lease ~= ARGV[1] then return -2 end",
        "local roleIssuedAt = tonumber(redis.call('GET', KEYS[4]) or '0') or 0",
        "local sessionCreatedAt = tonumber(ARGV[2]) or 0",
        "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
        "local currentController = tostring(redis.call('GET', KEYS[5]) or '')",
        "if currentController ~= ARGV[3] then return -4 end",
        "redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5])",
        "redis.call('LPUSH', KEYS[6], ARGV[6])",
        "redis.call('LTRIM', KEYS[6], 0, 199)",
        "return 1"
      ].join('\n');
      const replacementAuthorizeResult = Number(await redis([
        'EVAL', replacementAuthorizeScript, '6',
        replacementKey(recoveryCode),
        KEY_MASTER_DEVICE,
        KEY_MASTER,
        roleAssignmentKey(PREFIX, 'master'),
        KEY_CONTROLLER_DEVICE,
        KEY_AUDIT,
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
        String(oldControllerDeviceId),
        JSON.stringify(record),
        String(CONTROLLER_REPLACEMENT_TTL_SECONDS),
        JSON.stringify(audit),
      ]));
      if (replacementAuthorizeResult !== 1) {
        if (replacementAuthorizeResult === -1 || replacementAuthorizeResult === -3) clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: replacementAuthorizeResult === -1 ? 'MASTER_ROLE_CHANGED'
            : replacementAuthorizeResult === -2 ? 'MASTER_LEASE_REQUIRED'
            : replacementAuthorizeResult === -3 ? 'MASTER_SESSION_REVOKED'
            : 'CONTROLLER_ROLE_CHANGED',
        });
      }

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
      if (recoveryCode.length > REPLACEMENT_CODE_INPUT_MAX_CHARS) {
        return send(res, 400, { ok: false, code: 'CONTROLLER_REPLACEMENT_CODE_INPUT_TOO_LARGE' });
      }
      const newDeviceId = String(req.body?.deviceId || '').trim();
      const deviceName = String(req.body?.deviceName || 'iPhone contrôleur Zenith').trim().slice(0, 80);

      if (!validDeviceId(newDeviceId) || normalizeReplacementCode(recoveryCode).length < 12) {
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
        "local pendingCount = redis.call('LLEN', KEYS[5])",
        "local processingCount = redis.call('LLEN', KEYS[6])",
        "if pendingCount > 0 or processingCount > 0 then",
        "  return {-3, currentController, oldController, tostring(pendingCount), tostring(processingCount)}",
        "end",
        "redis.call('SET', KEYS[2], ARGV[1])",
        "redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])",
        "redis.call('SET', KEYS[4], ARGV[4])",
        "redis.call('DEL', KEYS[1])",
        "return {1, oldController, ARGV[1]}"
      ].join('\n');

      const result = await redis([
        'EVAL', script, '6',
        replacementKey(recoveryCode),
        KEY_CONTROLLER_DEVICE,
        `${PREFIX}:device:${tokenHash}`,
        roleAssignmentKey(PREFIX, 'controller'),
        KEY_PENDING,
        KEY_PROCESSING,
        newDeviceId,
        JSON.stringify(deviceRecord),
        String(DEVICE_SESSION_MAX_AGE_SECONDS),
        String(createdAt),
      ]);

      const code = Number(Array.isArray(result) ? result[0] : 0);
      if (code === 0) {
        return send(res, 410, { ok: false, code: 'CONTROLLER_REPLACEMENT_CODE_EXPIRED' });
      }
      if (code === -1) {
        return send(res, 409, { ok: false, code: 'CONTROLLER_REPLACEMENT_CONFLICT' });
      }
      if (code === -3) {
        return send(res, 409, {
          ok: false,
          code: 'CONTROLLER_REPLACEMENT_DRAIN_REQUIRED',
          pendingCommands: Number(Array.isArray(result) ? result[3] : 0) || 0,
          processingCommands: Number(Array.isArray(result) ? result[4] : 0) || 0,
        });
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


    if (action === 'controller-recovery-admin' && req.method === 'POST') {
      if (!(await controllerAdminRecoveryRateAllowed(req))) {
        return send(res, 429, { ok: false, code: 'CONTROLLER_ADMIN_RECOVERY_RATE_LIMIT' });
      }
      if (!(await verifyControllerRecoveryAdminCode(req, res))) return;

      const newDeviceId = String(req.body?.deviceId || '').trim();
      const deviceName = String(req.body?.deviceName || 'iPhone contrôleur Zenith').trim().slice(0, 80);
      if (!validDeviceId(newDeviceId)) {
        return send(res, 400, { ok: false, code: 'CONTROLLER_RECOVERY_REQUEST_INVALID' });
      }

      const oldControllerDeviceId = await roleDeviceId('controller');
      if (!oldControllerDeviceId) {
        return send(res, 409, { ok: false, code: 'CONTROLLER_NOT_REGISTERED' });
      }
      if (String(oldControllerDeviceId) === newDeviceId) {
        return send(res, 409, { ok: false, code: 'CONTROLLER_RECOVERY_DEVICE_UNCHANGED' });
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
      const audit = {
        at: createdAt,
        kind: 'CONTROLLER_RECOVERED_BY_ADMIN',
        oldControllerDeviceId,
        newControllerDeviceId: newDeviceId,
      };

      const recoveryScript = [
        "local currentController = tostring(redis.call('GET', KEYS[1]) or '')",
        "if currentController ~= ARGV[1] then return {-1, currentController, 0, 0} end",
        "local pendingCount = tonumber(redis.call('LLEN', KEYS[4]) or '0') or 0",
        "local processingCount = tonumber(redis.call('LLEN', KEYS[5]) or '0') or 0",
        "if pendingCount > 0 or processingCount > 0 then",
        "  return {-3, currentController, pendingCount, processingCount}",
        "end",
        "redis.call('SET', KEYS[1], ARGV[2])",
        "redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])",
        "redis.call('SET', KEYS[3], ARGV[5])",
        "redis.call('LPUSH', KEYS[6], ARGV[6])",
        "redis.call('LTRIM', KEYS[6], 0, 199)",
        "return {1, currentController, 0, 0}"
      ].join('\n');

      const result = await redis([
        'EVAL', recoveryScript, '6',
        KEY_CONTROLLER_DEVICE,
        `${PREFIX}:device:${tokenHash}`,
        roleAssignmentKey(PREFIX, 'controller'),
        KEY_PENDING,
        KEY_PROCESSING,
        KEY_AUDIT,
        String(oldControllerDeviceId),
        newDeviceId,
        JSON.stringify(deviceRecord),
        String(DEVICE_SESSION_MAX_AGE_SECONDS),
        String(createdAt),
        JSON.stringify(audit),
      ]);

      const code = Number(Array.isArray(result) ? result[0] : 0);
      if (code === -1) {
        return send(res, 409, { ok: false, code: 'CONTROLLER_RECOVERY_CONFLICT' });
      }
      if (code === -3) {
        return send(res, 409, {
          ok: false,
          code: 'CONTROLLER_RECOVERY_DRAIN_REQUIRED',
          pendingCommands: Number(Array.isArray(result) ? result[2] : 0) || 0,
          processingCommands: Number(Array.isArray(result) ? result[3] : 0) || 0,
        });
      }
      if (code !== 1) {
        return send(res, 500, { ok: false, code: 'CONTROLLER_RECOVERY_FAILED' });
      }

      let state = null;
      try {
        const controllerRaw = await redis(['GET', KEY_CONTROLLER_STATE]);
        state = controllerRaw ? JSON.parse(controllerRaw) : null;
      } catch {}

      setDeviceSessionCookie(res, token);
      return send(res, 200, {
        ok: true,
        sessionReady: true,
        device: deviceRecord,
        state,
        previousControllerDeviceId: String(result[1] || oldControllerDeviceId),
      });
    }

    if (action === 'whoami' && req.method === 'GET') {
      // One-time legacy migration: an old Bearer token is accepted only here.
      // The legacy token is atomically replaced by a fresh HttpOnly cookie token.
      const device = await requireDevice(req, res, undefined, { allowBearer: true, rotateBearer: true });
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
      if (!(await verifyMasterAdminCode(req, res, device))) return;

      const masterDevice = await roleDeviceId('master');
      if (!masterDevice) {
        return send(res, 409, { ok: false, code: 'MASTER_NOT_REGISTERED' });
      }

      const at = Date.now();
      const activationAudit = {
        at,
        kind: 'MASTER_ACTIVATION_AUTHORIZED',
        deviceId: device.deviceId,
        masterDeviceId: masterDevice,
        ttlSeconds: MASTER_ACTIVATION_TTL_SECONDS,
      };
      const activationScript = [
        "local registeredMaster = tostring(redis.call('GET', KEYS[2]) or '')",
        "if registeredMaster ~= ARGV[1] then return -1 end",
        "local currentController = tostring(redis.call('GET', KEYS[3]) or '')",
        "if currentController ~= ARGV[2] then return -2 end",
        "local controllerEpoch = tonumber(redis.call('GET', KEYS[4]) or '0') or 0",
        "local sessionCreatedAt = tonumber(ARGV[3]) or 0",
        "if controllerEpoch > 0 and sessionCreatedAt < controllerEpoch then return -3 end",
        "redis.call('SET', KEYS[1], '1', 'EX', ARGV[4])",
        "redis.call('LPUSH', KEYS[5], ARGV[5])",
        "redis.call('LTRIM', KEYS[5], 0, 199)",
        "return 1"
      ].join('\n');
      const activationResult = Number(await redis([
        'EVAL', activationScript, '5',
        masterActivationKey(masterDevice),
        KEY_MASTER_DEVICE,
        KEY_CONTROLLER_DEVICE,
        roleAssignmentKey(PREFIX, 'controller'),
        KEY_AUDIT,
        String(masterDevice),
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
        String(MASTER_ACTIVATION_TTL_SECONDS),
        JSON.stringify(activationAudit),
      ]));
      if (activationResult !== 1) {
        if (activationResult === -2 || activationResult === -3) clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: activationResult === -1 ? 'MASTER_ROLE_CHANGED'
            : activationResult === -3 ? 'CONTROLLER_SESSION_REVOKED'
            : 'CONTROLLER_ROLE_CHANGED',
        });
      }

      return send(res, 200, {
        ok: true,
        masterDeviceId: masterDevice,
        expiresInSeconds: MASTER_ACTIVATION_TTL_SECONDS,
      });
    }

    if (action === 'master-heartbeat' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;

      const lease = await acquireOrRenewMaster(device);
      if (lease.roleChanged || lease.sessionRevoked) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: lease.sessionRevoked ? 'MASTER_SESSION_REVOKED' : 'MASTER_ROLE_CHANGED',
        });
      }
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
      const heartbeatCommit = await commitMasterHeartbeat(heartbeat, device);
      if (heartbeatCommit !== 1) {
        if (heartbeatCommit === -1 || heartbeatCommit === -3) clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: heartbeatCommit === -2 ? 'MASTER_LEASE_REQUIRED'
            : heartbeatCommit === -3 ? 'MASTER_SESSION_REVOKED'
            : 'MASTER_ROLE_CHANGED',
        });
      }

      let engineRestartAuthorization = null;
      if (device.principal === 'engine') {
        const instanceRenewal = await renewEngineInstance(device);
        if (!instanceRenewal.ok) {
          clearDeviceSessionCookie(res);
          return send(res, 409, {
            ok:false,
            code:instanceRenewal.reason,
            masterMode:currentMode,
          });
        }
        engineRestartAuthorization = await persistEngineRestartAuthorization(device, lease.acquired === true);
        if (!engineRestartAuthorization.ok) {
          clearDeviceSessionCookie(res);
          return send(res, 409, {
            ok:false,
            code:engineRestartAuthorization.reason,
            masterMode:currentMode,
          });
        }
      }

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
        engineRestartAuthorized:engineRestartAuthorization?.authorized === true,
        engineRestartAuthorizationCreated:engineRestartAuthorization?.created === true,
        ttlSeconds: MASTER_TTL_SECONDS,
      });
    }

    if (action === 'master' && req.method === 'GET') {
      const device = await requireDevice(req, res);
      if (!device) return;
      return send(res, 200, { ok: true, currentMaster: await masterDeviceId() });
    }

    if (action === 'master-revoke' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller']);
      if (!device) return;
      if (!(await verifyMasterAdminCode(req, res, device))) return;

      const [registeredMaster, currentMaster] = await Promise.all([
        roleDeviceId('master'),
        masterDeviceId(),
      ]);

      // Compromise response is fail-closed immediately, before any remote check.
      await assertEmergencyStop();
      await setMasterMode('PAUSE_PENDING');

      const revokedAt = Date.now();

      if (!registeredMaster) {
        const alreadyRevokedScript = [
          "local controller = tostring(redis.call('GET', KEYS[1]) or '')",
          "if controller ~= ARGV[1] then return -1 end",
          "local controllerEpoch = tonumber(redis.call('GET', KEYS[2]) or '0') or 0",
          "local sessionCreatedAt = tonumber(ARGV[2]) or 0",
          "if controllerEpoch > 0 and sessionCreatedAt < controllerEpoch then return -2 end",
          "redis.call('DEL', KEYS[3])",
          "redis.call('DEL', KEYS[4])",
          "redis.call('SET', KEYS[5], ARGV[3])",
          "redis.call('DEL', KEYS[6])",
          "redis.call('DEL', KEYS[7])",
          "return 1"
        ].join('\n');
        const alreadyRevokedResult = Number(await redis([
          'EVAL', alreadyRevokedScript, '7',
          KEY_CONTROLLER_DEVICE,
          roleAssignmentKey(PREFIX, 'controller'),
          KEY_REAL_EXECUTION_ARMED,
          KEY_MASTER,
          roleAssignmentKey(PREFIX, 'master'),
          KEY_ENGINE_AUTHORIZED,
          KEY_ENGINE_INSTANCE,
          String(device.deviceId),
          String(Number(device.createdAt || 0)),
          String(revokedAt),
        ]));
        if (alreadyRevokedResult !== 1) {
          clearDeviceSessionCookie(res);
          return send(res, 409, {
            ok: false,
            code: alreadyRevokedResult === -2
              ? 'CONTROLLER_SESSION_REVOKED'
              : 'CONTROLLER_ROLE_CHANGED',
            emergencyStopActive: true,
            masterMode: 'PAUSE_PENDING',
          });
        }
        const pauseCompletion = await tryFinalizePendingPause('', 'PAUSE_PENDING');
        return send(res, 200, {
          ok: true,
          masterRevoked: true,
          alreadyRevoked: true,
          emergencyStopActive: true,
          masterMode: pauseCompletion.masterMode,
          pauseQueued: pauseCompletion.masterMode === 'PAUSE_PENDING',
          blockers: pauseCompletion.blockers || [],
          activity: pauseCompletion.activity || { activePositions: 0, openOrders: 0 },
          pendingCommands: Number(pauseCompletion.pendingCommands || 0),
          processingCommands: Number(pauseCompletion.processingCommands || 0),
        });
      }

      if (currentMaster && String(currentMaster) !== String(registeredMaster)) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_LEASE_CONFLICT',
          emergencyStopActive: true,
          masterMode: 'PAUSE_PENDING',
          currentMaster,
          registeredMaster,
        });
      }

      const pauseTransition = await tryFinalizePendingPause(registeredMaster, 'PAUSE_PENDING');
      if (pauseTransition.masterMode !== 'PAUSED') {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_REVOKE_DRAIN_REQUIRED',
          emergencyStopActive: true,
          masterMode: 'PAUSE_PENDING',
          blockers: pauseTransition.blockers || [],
          activity: pauseTransition.activity || { activePositions: 0, openOrders: 0 },
          pendingCommands: Number(pauseTransition.pendingCommands || 0),
          processingCommands: Number(pauseTransition.processingCommands || 0),
        });
      }

      let liveActivity = null;
      try {
        liveActivity = await fetchLiveBinanceActivity();
      } catch (e) {
        await setMasterMode('PAUSE_PENDING');
        return send(res, 503, {
          ok: false,
          code: e?.code || 'BINANCE_ACTIVITY_CHECK_FAILED',
          emergencyStopActive: true,
          masterMode: 'PAUSE_PENDING',
        });
      }

      if (liveActivity.activePositions > 0 || liveActivity.openOrders > 0) {
        await setMasterMode('PAUSE_PENDING');
        return send(res, 409, {
          ok: false,
          code: 'MASTER_REVOKE_DRAIN_REQUIRED',
          emergencyStopActive: true,
          masterMode: 'PAUSE_PENDING',
          blockers: [
            ...(liveActivity.activePositions > 0 ? ['ACTIVE_POSITION'] : []),
            ...(liveActivity.openOrders > 0 ? ['OPEN_ORDER'] : []),
          ],
          activity: liveActivity,
        });
      }

      const [pendingCommands, processingCommands, reconciliation] = await Promise.all([
        redis(['LLEN', KEY_PENDING]),
        redis(['LLEN', KEY_PROCESSING]),
        freshCleanReconciliation(),
      ]);

      const finalBlockers = [];
      if (Number(pendingCommands || 0) > 0) finalBlockers.push('PENDING_COMMAND');
      if (Number(processingCommands || 0) > 0) finalBlockers.push('PROCESSING_COMMAND');
      if (!reconciliation.ok) finalBlockers.push(reconciliation.reason);

      if (finalBlockers.length) {
        await setMasterMode('PAUSE_PENDING');
        return send(res, 409, {
          ok: false,
          code: 'MASTER_REVOKE_DRAIN_REQUIRED',
          emergencyStopActive: true,
          masterMode: 'PAUSE_PENDING',
          blockers: finalBlockers,
          activity: liveActivity,
          pendingCommands: Number(pendingCommands || 0),
          processingCommands: Number(processingCommands || 0),
        });
      }

      const revokeScript = [
        "local controller = tostring(redis.call('GET', KEYS[17]) or '')",
        "if controller ~= ARGV[3] then return -6 end",
        "local controllerEpoch = tonumber(redis.call('GET', KEYS[18]) or '0') or 0",
        "local controllerCreatedAt = tonumber(ARGV[4]) or 0",
        "if controllerEpoch > 0 and controllerCreatedAt < controllerEpoch then return -7 end",
        "local registered = tostring(redis.call('GET', KEYS[1]) or '')",
        "if registered == '' then return 2 end",
        "if registered ~= ARGV[1] then return -1 end",
        "if tostring(redis.call('GET', KEYS[3]) or '') ~= 'PAUSED' then return -2 end",
        "if redis.call('LLEN', KEYS[13]) > 0 then return -3 end",
        "if redis.call('LLEN', KEYS[14]) > 0 then return -4 end",
        "if redis.call('GET', KEYS[16]) then return -5 end",
        "redis.call('SET', KEYS[2], '1')",
        "redis.call('SET', KEYS[3], 'PAUSED')",
        "redis.call('DEL', KEYS[4])",
        "redis.call('DEL', KEYS[5])",
        "redis.call('DEL', KEYS[6])",
        "redis.call('DEL', KEYS[7])",
        "redis.call('DEL', KEYS[8])",
        "redis.call('DEL', KEYS[9])",
        "redis.call('DEL', KEYS[10])",
        "redis.call('DEL', KEYS[11])",
        "redis.call('DEL', KEYS[12])",
        "redis.call('SET', KEYS[15], ARGV[2])",
        "redis.call('DEL', KEYS[19])",
        "redis.call('DEL', KEYS[20])",
        "if registered == ARGV[5] then redis.call('SET', KEYS[21], '1') end",
        "redis.call('DEL', KEYS[1])",
        "return 1"
      ].join('\n');

      const result = Number(await redis([
        'EVAL', revokeScript, '21',
        KEY_MASTER_DEVICE,
        KEY_EMERGENCY_STOP,
        KEY_MASTER_MODE,
        KEY_REAL_EXECUTION_ARMED,
        KEY_MASTER,
        KEY_MASTER_HEARTBEAT,
        KEY_MASTER_CONFIG_ACK,
        KEY_RECONCILE_LAST,
        KEY_STATE,
        KEY_USER_STREAM_SESSION,
        masterActivationKey(registeredMaster),
        `${PREFIX}:master-admin-fail:${sha256(registeredMaster)}`,
        KEY_PENDING,
        KEY_PROCESSING,
        roleAssignmentKey(PREFIX, 'master'),
        KEY_USER_STREAM_MUTATION_LOCK,
        KEY_CONTROLLER_DEVICE,
        roleAssignmentKey(PREFIX, 'controller'),
        KEY_ENGINE_AUTHORIZED,
        KEY_ENGINE_INSTANCE,
        KEY_ENGINE_DISABLED,
        String(registeredMaster),
        String(revokedAt),
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
        ENGINE_MASTER_DEVICE_ID,
      ]));

      if (result === -1) {
        return send(res, 409, {
          ok: false,
          code: 'MASTER_ROLE_CHANGED_DURING_REVOKE',
          emergencyStopActive: true,
        });
      }

      if (result === -6 || result === -7) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: result === -7
            ? 'CONTROLLER_SESSION_REVOKED_DURING_REVOKE'
            : 'CONTROLLER_ROLE_CHANGED_DURING_REVOKE',
          emergencyStopActive: true,
          masterMode: 'PAUSED',
        });
      }

      if (result <= -2) {
        await setMasterMode('PAUSE_PENDING');
        const blocker = result === -2
          ? 'MASTER_MUST_BE_PAUSED'
          : result === -3
            ? 'PENDING_COMMAND'
            : result === -4
              ? 'PROCESSING_COMMAND'
              : 'USER_STREAM_MUTATION_IN_FLIGHT';
        return send(res, 409, {
          ok: false,
          code: 'MASTER_REVOKE_DRAIN_REQUIRED',
          emergencyStopActive: true,
          masterMode: 'PAUSE_PENDING',
          blockers: [blocker],
        });
      }

      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at: revokedAt,
        kind: 'MASTER_REVOKED',
        requestedByDeviceId: device.deviceId,
        previousMasterDeviceId: registeredMaster,
        previousLeaseActive: Boolean(currentMaster),
        liveActivity,
        pendingCommands: 0,
        processingCommands: 0,
        masterRoleEpochAdvancedAt: revokedAt,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        masterRevoked: true,
        alreadyRevoked: result === 2,
        previousMasterDeviceId: registeredMaster,
        emergencyStopActive: true,
        masterMode: 'PAUSED',
        liveActivity,
        pendingCommands: 0,
        processingCommands: 0,
        requiresPairingReopen: PAIRING_DISABLED,
      });
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

      const [currentMaster, registeredMaster, currentMode, masterRoleEpochRaw] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('master'),
        masterMode(),
        redis(['GET', roleAssignmentKey(PREFIX, 'master')]),
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

      const runningTransition = await trySetMasterRunningFrom(
        'PAUSE_PENDING',
        currentMaster,
        String(masterRoleEpochRaw || '0'),
        device
      );
      if (!runningTransition.ok) {
        if (runningTransition.reason === 'REQUESTER_ROLE_CHANGED' ||
            runningTransition.reason === 'REQUESTER_SESSION_REVOKED') {
          clearDeviceSessionCookie(res);
        }
        const requesterCode = device.role === 'controller'
          ? (runningTransition.reason === 'REQUESTER_SESSION_REVOKED'
              ? 'CONTROLLER_SESSION_REVOKED'
              : 'CONTROLLER_ROLE_CHANGED')
          : (runningTransition.reason === 'REQUESTER_SESSION_REVOKED'
              ? 'MASTER_SESSION_REVOKED'
              : 'MASTER_ROLE_CHANGED');
        const code = runningTransition.reason === 'EMERGENCY_STOP_ACTIVE'
          ? 'EMERGENCY_STOP_ACTIVE'
          : runningTransition.reason === 'MASTER_LEASE_REQUIRED'
            ? 'MASTER_LEASE_REQUIRED'
            : runningTransition.reason === 'MASTER_ROLE_CHANGED'
              ? 'MASTER_ROLE_CHANGED'
              : runningTransition.reason === 'REQUESTER_ROLE_CHANGED' ||
                runningTransition.reason === 'REQUESTER_SESSION_REVOKED'
                ? requesterCode
                : 'MASTER_PAUSE_NOT_PENDING';
        return send(res, code === 'EMERGENCY_STOP_ACTIVE' ? 423 : 409, {
          ok: false,
          code,
          masterMode: runningTransition.masterMode,
        });
      }
      const mode = runningTransition.masterMode;
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
      if (!VERCEL_PRODUCTION_WRITE_ALLOWED) return send(res, 423, { ok:false, code:'NON_PRODUCTION_DEPLOYMENT' });
      if (!PAIRING_DISABLED) return send(res, 423, { ok:false, code:'PAIRING_MUST_BE_DISABLED' });
      if (!DEPLOYMENT_SHA) return send(res, 423, { ok:false, code:'REAL_EXECUTION_DEPLOYMENT_SHA_MISSING' });

      const [currentMaster, registeredMaster, currentMode, halted, pending, processing, runtimeRaw, masterRoleEpochRaw] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('master'),
        masterMode(),
        emergencyStopActive(),
        redis(['LLEN', KEY_PENDING]),
        redis(['LLEN', KEY_PROCESSING]),
        redis(['GET', KEY_STATE]),
        redis(['GET', roleAssignmentKey(PREFIX, 'master')]),
      ]);
      const blockers = [
        ...adminSecretPolicyBlockers(),
        ...binanceCredentialSeparationBlockers(),
      ];
      if (!currentMaster || !registeredMaster || String(currentMaster) !== String(registeredMaster)) blockers.push('MASTER_LEASE_REQUIRED');
      const masterRoleEpoch = Number(masterRoleEpochRaw || 0);
      if (!Number.isFinite(masterRoleEpoch) || masterRoleEpoch <= 0) blockers.push('MASTER_ROLE_EPOCH_REQUIRED');
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

      let apiPermissions = null;
      if (!blockers.length) {
        try {
          apiPermissions = await fetchBinanceApiPermissions();
          blockers.push(...binanceApiPermissionBlockers(apiPermissions));
        } catch (e) {
          blockers.push(e?.code || 'BINANCE_API_PERMISSION_CHECK_FAILED');
        }
      }

      if (blockers.length) {
        return send(res, 409, { ok:false, code:'REAL_EXECUTION_ARM_BLOCKED', blockers });
      }

      const requesterRole = String(device.role || '').toLowerCase();
      const record = {
        version:1,
        armedAt:Date.now(),
        masterDeviceId:currentMaster,
        masterRoleEpoch,
        controllerRevision:configSync.status.controllerRevision,
        deploymentSha:DEPLOYMENT_SHA,
        reconciliationObservedAt:Number(reconciliation?.report?.observedAt || 0),
        binanceApiPermissionsVerifiedAt:Date.now(),
        binanceApiIpRestricted:apiPermissions?.ipRestrict === true,
        adminSecretPolicyVersion:1,
      };
      const armCommitScript = [
        "local registered = tostring(redis.call('GET', KEYS[1]) or '')",
        "if registered ~= ARGV[1] then return -1 end",
        "local lease = tostring(redis.call('GET', KEYS[2]) or '')",
        "if lease ~= ARGV[1] then return -2 end",
        "local mode = tostring(redis.call('GET', KEYS[3]) or 'PAUSED')",
        "if mode ~= 'PAUSED' then return -3 end",
        "local panic = tostring(redis.call('GET', KEYS[4]) or '')",
        "if panic ~= '1' then return -4 end",
        "if redis.call('LLEN', KEYS[5]) > 0 or redis.call('LLEN', KEYS[6]) > 0 then return -5 end",
        "local roleEpoch = tostring(redis.call('GET', KEYS[7]) or '')",
        "if roleEpoch ~= ARGV[2] then return -6 end",
        "local requester = tostring(redis.call('GET', KEYS[9]) or '')",
        "if requester ~= ARGV[4] then return -7 end",
        "local requesterEpoch = tonumber(redis.call('GET', KEYS[10]) or '0') or 0",
        "local requesterCreatedAt = tonumber(ARGV[5]) or 0",
        "if requesterEpoch > 0 and requesterCreatedAt < requesterEpoch then return -8 end",
        "redis.call('SET', KEYS[8], ARGV[3])",
        "return 1"
      ].join('\n');
      const armCommitResult = Number(await redis([
        'EVAL', armCommitScript, '10',
        KEY_MASTER_DEVICE,
        KEY_MASTER,
        KEY_MASTER_MODE,
        KEY_EMERGENCY_STOP,
        KEY_PENDING,
        KEY_PROCESSING,
        roleAssignmentKey(PREFIX, 'master'),
        KEY_REAL_EXECUTION_ARMED,
        roleDeviceKey(requesterRole),
        roleAssignmentKey(PREFIX, requesterRole),
        String(currentMaster),
        String(masterRoleEpoch),
        JSON.stringify(record),
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
      ]));
      if (armCommitResult !== 1) {
        const reason = armCommitResult === -1
          ? 'MASTER_ROLE_CHANGED_DURING_ARM'
          : armCommitResult === -2
            ? 'MASTER_LEASE_CHANGED_DURING_ARM'
            : armCommitResult === -3
              ? 'MASTER_MUST_BE_PAUSED'
              : armCommitResult === -4
                ? 'EMERGENCY_STOP_MUST_BE_ACTIVE'
                : armCommitResult === -5
                  ? 'COMMAND_QUEUE_CHANGED_DURING_ARM'
                  : armCommitResult === -6
                    ? 'MASTER_ROLE_EPOCH_CHANGED_DURING_ARM'
                    : armCommitResult === -7
                      ? 'REQUESTER_ROLE_CHANGED_DURING_ARM'
                      : armCommitResult === -8
                        ? 'REQUESTER_SESSION_REVOKED_DURING_ARM'
                        : 'REAL_EXECUTION_ARM_COMMIT_FAILED';
        if (armCommitResult === -7 || armCommitResult === -8) clearDeviceSessionCookie(res);
        return send(res, 409, { ok:false, code:'REAL_EXECUTION_ARM_RACE_BLOCKED', blockers:[reason] });
      }
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
      const [currentMaster, registeredMaster, currentMode, masterRoleEpochRaw] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('master'),
        masterMode(),
        redis(['GET', roleAssignmentKey(PREFIX, 'master')]),
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
      if (currentMode !== 'PAUSED') blockers.push('MASTER_MUST_BE_PAUSED');
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

      const runningTransition = await trySetMasterRunningFrom(
        'PAUSED',
        currentMaster,
        String(masterRoleEpochRaw || '0'),
        device
      );
      if (!runningTransition.ok) {
        if (runningTransition.reason === 'REQUESTER_ROLE_CHANGED' ||
            runningTransition.reason === 'REQUESTER_SESSION_REVOKED') {
          clearDeviceSessionCookie(res);
        }
        const requesterReason = device.role === 'controller'
          ? (runningTransition.reason === 'REQUESTER_SESSION_REVOKED'
              ? 'CONTROLLER_SESSION_REVOKED'
              : 'CONTROLLER_ROLE_CHANGED')
          : (runningTransition.reason === 'REQUESTER_SESSION_REVOKED'
              ? 'MASTER_SESSION_REVOKED'
              : 'MASTER_ROLE_CHANGED');
        return send(res, 409, {
          ok: false,
          code: 'MASTER_RESUME_BLOCKED',
          blockers: [
            runningTransition.reason === 'REQUESTER_ROLE_CHANGED' ||
            runningTransition.reason === 'REQUESTER_SESSION_REVOKED'
              ? requesterReason
              : runningTransition.reason
          ],
          pendingCommands: Number(pending || 0),
          processingCommands: Number(processing || 0),
        });
      }
      const mode = runningTransition.masterMode;
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

    if (action === 'engine-protection-high-water' && req.method === 'GET') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (device.principal !== 'engine') {
        return send(res, 403, { ok:false, code:'ENGINE_PRINCIPAL_REQUIRED' });
      }

      const readScript = [
        "local currentInstance = tostring(redis.call('GET', KEYS[1]) or '')",
        "if currentInstance ~= ARGV[1] then return {-1, '', ''} end",
        "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
        "if registered ~= ARGV[2] then return {-2, '', ''} end",
        "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
        "if lease ~= ARGV[2] then return {-3, '', ''} end",
        "local epoch = tostring(redis.call('GET', KEYS[4]) or '')",
        "if epoch ~= ARGV[3] then return {-4, '', ''} end",
        "local authorization = tostring(redis.call('GET', KEYS[5]) or '')",
        "if authorization == '' then return {-5, '', ''} end",
        "local highWater = tostring(redis.call('GET', KEYS[6]) or '')",
        "return {1, authorization, highWater}"
      ].join('\n');

      const result = await redis([
        'EVAL', readScript, '6',
        KEY_ENGINE_INSTANCE,
        KEY_MASTER_DEVICE,
        KEY_MASTER,
        roleAssignmentKey(PREFIX, 'master'),
        KEY_ENGINE_AUTHORIZED,
        KEY_ENGINE_PROTECTION_HIGH_WATER,
        String(device.engineInstanceId || ''),
        String(device.deviceId || ''),
        String(Number(device.createdAt || 0)),
      ]);
      const code = Number(Array.isArray(result) ? result[0] : 0);
      if (code !== 1) {
        return send(res, 409, {
          ok:false,
          code: code === -1 ? 'ENGINE_INSTANCE_FENCED'
            : code === -2 ? 'MASTER_ROLE_CHANGED'
            : code === -3 ? 'MASTER_LEASE_REQUIRED'
            : code === -4 ? 'MASTER_SESSION_REVOKED'
            : code === -5 ? 'ENGINE_RESTART_AUTHORIZATION_REQUIRED'
            : 'ENGINE_HIGH_WATER_READ_FAILED',
        });
      }

      const authorization = parseStoredJson(Array.isArray(result) ? result[1] : '');
      const authorizationAt = Number(authorization?.authorizedAt || 0);
      if (authorization?.version !== 1 ||
          String(authorization?.masterDeviceId || '') !== String(device.deviceId || '') ||
          !Number.isFinite(authorizationAt) || authorizationAt <= 0) {
        return send(res, 409, { ok:false, code:'ENGINE_RESTART_AUTHORIZATION_INVALID' });
      }

      const stored = parseStoredJson(Array.isArray(result) ? result[2] : '');
      const sameScope = Boolean(
        stored?.version === 1 &&
        Number(stored?.authorizationAt || 0) === authorizationAt &&
        plainJsonObject(stored?.entries)
      );
      return send(res, 200, {
        ok:true,
        authorizationAt,
        entries:sameScope ? stored.entries : {},
        staleScope:Boolean(stored && !sameScope),
        updatedAt:sameScope ? Number(stored.updatedAt || 0) : 0,
      });
    }

    if (action === 'engine-protection-high-water' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (device.principal !== 'engine') {
        return send(res, 403, { ok:false, code:'ENGINE_PRINCIPAL_REQUIRED' });
      }

      const authorizationAt = Number(req.body?.authorizationAt);
      const entries = req.body?.entries;
      if (!Number.isSafeInteger(authorizationAt) || authorizationAt <= 0 || !plainJsonObject(entries)) {
        return send(res, 400, { ok:false, code:'ENGINE_HIGH_WATER_INVALID' });
      }
      const keys = Object.keys(entries);
      if (keys.length > 20) {
        return send(res, 413, { ok:false, code:'ENGINE_HIGH_WATER_TOO_MANY_ENTRIES', maxEntries:20 });
      }
      const cleanEntries = {};
      for (const key of keys) {
        if (!/^[A-Za-z0-9._:+-]{8,200}$/.test(key)) {
          return send(res, 400, { ok:false, code:'ENGINE_HIGH_WATER_KEY_INVALID' });
        }
        const value = Number(entries[key]);
        if (!Number.isFinite(value) || Math.abs(value) > 1e9) {
          return send(res, 400, { ok:false, code:'ENGINE_HIGH_WATER_VALUE_INVALID' });
        }
        cleanEntries[key] = value;
      }
      const entriesRaw = JSON.stringify(cleanEntries);
      if (Buffer.byteLength(entriesRaw, 'utf8') > 16 * 1024) {
        return send(res, 413, { ok:false, code:'ENGINE_HIGH_WATER_TOO_LARGE' });
      }
      const updatedAt = Date.now();

      const writeScript = [
        "local currentInstance = tostring(redis.call('GET', KEYS[1]) or '')",
        "if currentInstance ~= ARGV[1] then return {-1, ''} end",
        "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
        "if registered ~= ARGV[2] then return {-2, ''} end",
        "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
        "if lease ~= ARGV[2] then return {-3, ''} end",
        "local epoch = tostring(redis.call('GET', KEYS[4]) or '')",
        "if epoch ~= ARGV[3] then return {-4, ''} end",
        "local authorizationRaw = redis.call('GET', KEYS[5])",
        "if not authorizationRaw then return {-5, ''} end",
        "local ok, authorization = pcall(cjson.decode, authorizationRaw)",
        "if not ok or tonumber(authorization['version'] or 0) ~= 1 then return {-6, ''} end",
        "if tostring(authorization['masterDeviceId'] or '') ~= ARGV[2] then return {-6, ''} end",
        "if tonumber(authorization['authorizedAt'] or 0) ~= tonumber(ARGV[4]) then return {-7, ''} end",
        "local incomingOk, incoming = pcall(cjson.decode, ARGV[5])",
        "if not incomingOk or type(incoming) ~= 'table' then return {-8, ''} end",
        "local previous = {}",
        "local previousRaw = redis.call('GET', KEYS[6])",
        "if previousRaw then",
        "  local previousOk, decoded = pcall(cjson.decode, previousRaw)",
        "  if previousOk and tonumber(decoded['version'] or 0) == 1 and tonumber(decoded['authorizationAt'] or 0) == tonumber(ARGV[4]) and type(decoded['entries']) == 'table' then",
        "    previous = decoded['entries']",
        "  end",
        "end",
        "local merged = {}",
        "for key, value in pairs(incoming) do",
        "  local nextValue = tonumber(value)",
        "  local oldValue = tonumber(previous[key])",
        "  if oldValue and oldValue > nextValue then nextValue = oldValue end",
        "  merged[key] = nextValue",
        "end",
        "local record = {version=1, authorizationAt=tonumber(ARGV[4]), updatedAt=tonumber(ARGV[6]), entries=merged}",
        "local encoded = cjson.encode(record)",
        "redis.call('SET', KEYS[6], encoded)",
        "return {1, encoded}"
      ].join('\n');

      const result = await redis([
        'EVAL', writeScript, '6',
        KEY_ENGINE_INSTANCE,
        KEY_MASTER_DEVICE,
        KEY_MASTER,
        roleAssignmentKey(PREFIX, 'master'),
        KEY_ENGINE_AUTHORIZED,
        KEY_ENGINE_PROTECTION_HIGH_WATER,
        String(device.engineInstanceId || ''),
        String(device.deviceId || ''),
        String(Number(device.createdAt || 0)),
        String(authorizationAt),
        entriesRaw,
        String(updatedAt),
      ]);
      const resultCode = Number(Array.isArray(result) ? result[0] : 0);
      if (resultCode !== 1) {
        return send(res, 409, {
          ok:false,
          code: resultCode === -1 ? 'ENGINE_INSTANCE_FENCED'
            : resultCode === -2 ? 'MASTER_ROLE_CHANGED'
            : resultCode === -3 ? 'MASTER_LEASE_REQUIRED'
            : resultCode === -4 ? 'MASTER_SESSION_REVOKED'
            : resultCode === -5 ? 'ENGINE_RESTART_AUTHORIZATION_REQUIRED'
            : resultCode === -7 ? 'ENGINE_HIGH_WATER_AUTHORIZATION_CHANGED'
            : resultCode === -8 ? 'ENGINE_HIGH_WATER_INVALID'
            : 'ENGINE_RESTART_AUTHORIZATION_INVALID',
        });
      }
      const storedRecord = parseStoredJson(Array.isArray(result) ? result[1] : '');
      return send(res, 200, {
        ok:true,
        authorizationAt,
        updatedAt:Number(storedRecord?.updatedAt || updatedAt),
        entryCount:plainJsonObject(storedRecord?.entries) ? Object.keys(storedRecord.entries).length : keys.length,
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
      const appliedAudit = {
        at: applied.appliedAt,
        kind: 'MASTER_CONFIG_APPLIED',
        deviceId: device.deviceId,
        revision,
        stateHash,
      };
      const ackScript = [
        "local registered = tostring(redis.call('GET', KEYS[3]) or '')",
        "if registered ~= ARGV[3] then return -1 end",
        "local lease = tostring(redis.call('GET', KEYS[4]) or '')",
        "if lease ~= ARGV[3] then return -2 end",
        "local roleIssuedAt = tonumber(redis.call('GET', KEYS[5]) or '0') or 0",
        "local sessionCreatedAt = tonumber(ARGV[4]) or 0",
        "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
        "local controllerRaw = redis.call('GET', KEYS[6])",
        "if not controllerRaw then return -4 end",
        "local ok, controller = pcall(cjson.decode, controllerRaw)",
        "if not ok then return -4 end",
        "if tonumber(controller['revision'] or 0) ~= tonumber(ARGV[5]) then return -5 end",
        "if tostring(controller['stateHash'] or '') ~= ARGV[6] then return -5 end",
        "redis.call('SET', KEYS[1], ARGV[1])",
        "redis.call('LPUSH', KEYS[2], ARGV[2])",
        "redis.call('LTRIM', KEYS[2], 0, 199)",
        "return 1"
      ].join('\n');
      const ackCommit = Number(await redis([
        'EVAL', ackScript, '6',
        KEY_MASTER_CONFIG_ACK,
        KEY_AUDIT,
        KEY_MASTER_DEVICE,
        KEY_MASTER,
        roleAssignmentKey(PREFIX, 'master'),
        KEY_CONTROLLER_STATE,
        JSON.stringify(applied),
        JSON.stringify(appliedAudit),
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
        String(revision),
        stateHash,
      ]));
      if (ackCommit !== 1) {
        if (ackCommit === -1 || ackCommit === -3) clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: ackCommit === -2 ? 'MASTER_LEASE_REQUIRED'
            : ackCommit === -3 ? 'MASTER_SESSION_REVOKED'
            : ackCommit === -4 ? 'NO_CONTROLLER_STATE'
            : ackCommit === -5 ? 'MASTER_CONFIG_REVISION_CHANGED'
            : 'MASTER_ROLE_CHANGED',
        });
      }

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

      try {
        if (!(await controllerStateWriteRateAllowed(device.deviceId))) {
          const retryAfter = controllerStateRetryAfterSeconds();
          res.setHeader('Retry-After', String(retryAfter));
          return send(res, 429, {
            ok: false,
            code: 'CONTROLLER_STATE_WRITE_RATE_LIMIT',
            retryAfterSeconds: retryAfter,
          });
        }
      } catch (e) {
        return send(res, 503, {
          ok: false,
          code: e?.code || 'RATE_LIMIT_BACKEND_ERROR',
        });
      }

      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        return send(res, 400, { ok: false, code: 'EXPECTED_REVISION_REQUIRED' });
      }

      const data = req.body?.data;
      if (!plainJsonObject(data)) {
        return send(res, 400, { ok: false, code: 'CONTROLLER_STATE_INVALID' });
      }

      const safeData = {};
      for (const field of ['settings', 'tokenSettings', 'manualTokens', 'validated']) {
        const value = data[field];
        if (value == null) {
          safeData[field] = {};
          continue;
        }
        if (!plainJsonObject(value)) {
          return send(res, 400, {
            ok: false,
            code: 'CONTROLLER_STATE_BLOCK_INVALID',
            field,
          });
        }
        safeData[field] = value;
      }

      if (JSON.stringify(safeData).length > 250000) {
        return send(res, 413, { ok: false, code: 'CONTROLLER_STATE_TOO_LARGE' });
      }
      const controllerStructure = jsonStructureStatus(safeData, {
        maxDepth: 16,
        maxNodes: 20000,
        maxArrayLength: 2000,
        maxObjectKeys: 2000,
      });
      if (!controllerStructure.ok) {
        return send(res, 400, {
          ok: false,
          code: 'CONTROLLER_STATE_STRUCTURE_INVALID',
          reason: controllerStructure.reason,
        });
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
        "local currentController = tostring(redis.call('GET', KEYS[4]) or '')",
        "if currentController ~= ARGV[4] then return {-2, currentController, ''} end",
        "local roleIssuedAt = tonumber(redis.call('GET', KEYS[5]) or '0') or 0",
        "local sessionCreatedAt = tonumber(ARGV[5]) or 0",
        "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return {-3, tostring(roleIssuedAt), ''} end",
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
        'EVAL', script, '5',
        KEY_CONTROLLER_STATE, KEY_CONTROLLER_REV, KEY_AUDIT,
        KEY_CONTROLLER_DEVICE, roleAssignmentKey(PREFIX, 'controller'),
        String(expectedRevision),
        JSON.stringify(snapshotTemplate),
        JSON.stringify(auditTemplate),
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
      ]);

      const resultCode = Number(Array.isArray(result) ? result[0] : 0);
      const applied = resultCode === 1;
      const currentRevision = Number(Array.isArray(result) ? result[1] : 0) || 0;
      const rawState = String(Array.isArray(result) ? result[2] || '' : '');

      if (resultCode === -2 || resultCode === -3) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: resultCode === -2 ? 'CONTROLLER_ROLE_CHANGED' : 'CONTROLLER_SESSION_REVOKED',
        });
      }

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
      if (!plainJsonObject(data)) {
        return send(res, 400, { ok: false, code: 'RUNTIME_STATE_INVALID' });
      }
      if (JSON.stringify(data).length > 500000) {
        return send(res, 413, { ok: false, code: 'RUNTIME_STATE_TOO_LARGE' });
      }
      const runtimeStructure = jsonStructureStatus(data, {
        maxDepth: 20,
        maxNodes: 40000,
        maxArrayLength: 10000,
        maxObjectKeys: 5000,
      });
      if (!runtimeStructure.ok) {
        return send(res, 400, {
          ok: false,
          code: 'RUNTIME_STATE_STRUCTURE_INVALID',
          reason: runtimeStructure.reason,
        });
      }
      const snapshot = {
        version: 2,
        updatedAt: Date.now(),
        masterDeviceId: device.deviceId,
        controllerRevision: Math.max(0, Number(req.body?.controllerRevision || 0)),
        appliedRevision: Math.max(0, Number(req.body?.appliedRevision || 0)),
        data,
      };
      const stateCommitScript = [
        "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
        "if registered ~= ARGV[2] then return -1 end",
        "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
        "if lease ~= ARGV[2] then return -2 end",
        "local roleIssuedAt = tonumber(redis.call('GET', KEYS[4]) or '0') or 0",
        "local sessionCreatedAt = tonumber(ARGV[3]) or 0",
        "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return -3 end",
        "redis.call('SET', KEYS[1], ARGV[1])",
        "return 1"
      ].join('\n');
      const stateCommit = Number(await redis([
        'EVAL', stateCommitScript, '4',
        KEY_STATE,
        KEY_MASTER_DEVICE,
        KEY_MASTER,
        roleAssignmentKey(PREFIX, 'master'),
        JSON.stringify(snapshot),
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
      ]));
      if (stateCommit !== 1) {
        if (stateCommit === -1 || stateCommit === -3) clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: stateCommit === -2 ? 'MASTER_LEASE_REQUIRED'
            : stateCommit === -3 ? 'MASTER_SESSION_REVOKED'
            : 'MASTER_ROLE_CHANGED',
        });
      }
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
        "local currentController = tostring(redis.call('GET', KEYS[5]) or '')",
        "if currentController ~= ARGV[6] then return {-5, currentController} end",
        "local roleIssuedAt = tonumber(redis.call('GET', KEYS[6]) or '0') or 0",
        "local sessionCreatedAt = tonumber(ARGV[7]) or 0",
        "if roleIssuedAt > 0 and sessionCreatedAt < roleIssuedAt then return {-6, tostring(roleIssuedAt)} end",
        "local existing = redis.call('GET', KEYS[1])",
        "if existing then return {0, existing} end",
        "local total = redis.call('LLEN', KEYS[2]) + redis.call('LLEN', KEYS[4])",
        "if total >= tonumber(ARGV[5]) then return {-4, tostring(total)} end",
        "redis.call('LPUSH', KEYS[2], ARGV[2])",
        "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])",
        "return {1, ARGV[1]}"
      ].join('\n');

      const result = await redis([
        'EVAL', script, '6',
        dedupeKey, KEY_PENDING, KEY_MASTER_MODE, KEY_PROCESSING,
        KEY_CONTROLLER_DEVICE, roleAssignmentKey(PREFIX, 'controller'),
        command.id, raw, String(COMMAND_DEDUPE_TTL_SECONDS),
        allowedWhilePending ? '1' : '0', String(COMMAND_QUEUE_MAX),
        String(device.deviceId), String(Number(device.createdAt || 0))
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
      if (resultCode === -5 || resultCode === -6) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok: false,
          code: resultCode === -5 ? 'CONTROLLER_ROLE_CHANGED' : 'CONTROLLER_SESSION_REVOKED',
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

      const recovery = await recoverStaleProcessing(device);
      if (recovery.authorityLost) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok:false,
          code:masterAuthorityMutationCode(recovery.authorityCode, '_DURING_RECOVERY'),
          recovery,
        });
      }
      const raw = await claimNextCommand(device);
      if (!raw) return send(res, 200, { ok: true, command: null, recovery });
      if (raw === '__MASTER_ROLE_CHANGED__' || raw === '__MASTER_LEASE_LOST__' || raw === '__MASTER_SESSION_REVOKED__') {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok:false,
          code: raw === '__MASTER_ROLE_CHANGED__'
            ? 'MASTER_ROLE_CHANGED_DURING_CLAIM'
            : raw === '__MASTER_LEASE_LOST__'
              ? 'MASTER_LEASE_LOST_DURING_CLAIM'
              : 'MASTER_SESSION_REVOKED_DURING_CLAIM',
          recovery,
        });
      }
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
        await rejectClaimedCommand(raw, 'COMMAND_TYPE_NOT_ALLOWED', {}, device);
        return send(res, 200, { ok: true, command: null, typeRejected: true, recovery });
      }
      if (String(command.type || '').toUpperCase() === 'EXEC_CLOSE_POSITION') {
        const payloadStatus = execClosePayloadStatus(command.payload);
        if (!payloadStatus.ok) {
          await rejectClaimedCommand(raw, 'COMMAND_PAYLOAD_INVALID', { payloadReason:payloadStatus.reason }, device);
          return send(res, 200, { ok:true, command:null, payloadRejected:true, payloadReason:payloadStatus.reason, recovery });
        }
      }

      if (commandExpired(command)) {
        await rejectClaimedCommand(raw, 'COMMAND_EXPIRED', {
          createdAt: Number(command.createdAt || 0),
          expiresAt: Number(command.expiresAt || 0),
        }, device);
        return send(res, 200, { ok: true, command: null, expiredRejected: true, recovery });
      }

      const modeNow = await masterMode();
      if (modeNow === 'PAUSED') {
        await rejectClaimedCommand(raw, 'MASTER_PAUSED_AFTER_CLAIM', {}, device);
        return send(res, 200, { ok: true, command: null, pausedRejected: true, recovery });
      }
      if (modeNow === 'PAUSE_PENDING' && !commandAllowedDuringPausePending(command.type)) {
        await rejectClaimedCommand(raw, 'MASTER_PAUSE_PENDING_UNSAFE_COMMAND', {}, device);
        return send(res, 200, { ok: true, command: null, pausePendingRejected: true, recovery });
      }

      const currentController = await roleDeviceId('controller');
      if (String(command.deviceId || '') !== String(currentController || '')) {
        await rejectClaimedCommand(raw, 'STALE_CONTROLLER_COMMAND', {
          currentControllerDeviceId: currentController,
        }, device);
        return send(res, 200, { ok: true, command: null, staleRejected: true, recovery });
      }

      const configSync = await readMasterConfigSync(device.deviceId);
      if (!configSync.status.synchronized && !commandAllowedDuringPausePending(command.type)) {
        await rejectClaimedCommand(raw, 'MASTER_CONFIG_OUT_OF_SYNC', {
          controllerRevision: configSync.status.controllerRevision,
          appliedRevision: configSync.status.appliedRevision,
        }, device);
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
          }, device);
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
            device
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
      const recovery = await recoverStaleProcessing(device);
      if (recovery.authorityLost) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok:false,
          code:masterAuthorityMutationCode(recovery.authorityCode, '_DURING_RECOVERY'),
          recovery,
        });
      }
      return send(res, 200, { ok: true, recovery });
    }

    if (action === 'command-ack' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const rawStatus = commandRawStatus(req.body?.raw);
      if (!rawStatus.ok) {
        return send(res, rawStatus.reason === 'COMMAND_RAW_TOO_LARGE' ? 413 : 400, {
          ok:false,
          code:rawStatus.reason,
          ...(rawStatus.maxBytes ? { maxBytes:rawStatus.maxBytes } : {}),
        });
      }
      const raw = rawStatus.value;
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
        const expectedProofPrefix = commandType === 'EXEC_UPDATE_EXIT'
          ? 'zth-EXI-'
          : payloadStatus.protectionKind === 'MAX_LOSS'
            ? 'zth-MAX-'
            : 'zth-PRO-';
        if (!/^zth-(?:EXI|PRO|MAX)-[a-f0-9]{24}$/.test(newClientId) ||
            !newClientId.startsWith(expectedProofPrefix)) {
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

      const completed = await completeProcessingCommandAtomic(raw, commandId, device);
      if (completed < 0) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok:false,
          code:masterAuthorityMutationCode(completed, '_DURING_ACK'),
          commandId,
        });
      }
      if (completed !== 1) {
        return send(res, 409, { ok:false, code:'COMMAND_ACK_NOT_PROCESSING', commandId });
      }
      return send(res, 200, { ok:true, commandId });
    }

    if (action === 'command-fail' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) return send(res, 409, { ok:false, code:'NOT_MASTER' });
      const rawStatus = commandRawStatus(req.body?.raw);
      const reason = String(req.body?.reason || 'EXECUTION_FAILED').toUpperCase();
      if (!rawStatus.ok) {
        return send(res, rawStatus.reason === 'COMMAND_RAW_TOO_LARGE' ? 413 : 400, {
          ok:false,
          code:rawStatus.reason,
          ...(rawStatus.maxBytes ? { maxBytes:rawStatus.maxBytes } : {}),
        });
      }
      if (!/^[A-Z0-9_:-]{3,96}$/.test(reason)) return send(res, 400, { ok:false, code:'FAIL_REASON_INVALID' });
      const raw = rawStatus.value;
      let command = null;
      try { command = JSON.parse(raw); } catch {}
      const removed = await removeProcessingAtomic(raw, device);
      if (removed < 0) {
        clearDeviceSessionCookie(res);
        return send(res, 409, {
          ok:false,
          code:masterAuthorityMutationCode(removed, '_DURING_FAIL'),
        });
      }
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

      const rawStatus = commandRawStatus(req.body?.raw);
      if (!rawStatus.ok) {
        return send(res, rawStatus.reason === 'COMMAND_RAW_TOO_LARGE' ? 413 : 400, {
          ok:false,
          code:rawStatus.reason,
          ...(rawStatus.maxBytes ? { maxBytes:rawStatus.maxBytes } : {}),
        });
      }
      const raw = rawStatus.value;

      let command = null;
      try { command = JSON.parse(raw); } catch {}
      if (!command || !commandTypeAllowed(command.type)) {
        await rejectClaimedCommand(raw, 'COMMAND_TYPE_NOT_ALLOWED', {}, device);
        return send(res, 200, { ok: true, requeued: false, rejected: true });
      }
      if (commandExpired(command)) {
        await rejectClaimedCommand(raw, 'COMMAND_EXPIRED', {}, device);
        return send(res, 200, { ok: true, requeued: false, expired: true });
      }

      const commandId = String(command.id || '');
      if (commandId) {
        const done = await redis(['GET', `${PREFIX}:command:done:${commandId}`]);
        if (done) {
          const removed = await removeProcessingAtomic(raw, device);
          if (removed < 0) {
            clearDeviceSessionCookie(res);
            return send(res, 409, {
              ok:false,
              code:masterAuthorityMutationCode(removed, '_DURING_REQUEUE'),
            });
          }
          return send(res, 200, { ok: true, requeued: false, alreadyDone: true });
        }
      }

      const modeNow = await masterMode();
      if (modeNow === 'PAUSED' ||
          (modeNow === 'PAUSE_PENDING' && !commandAllowedDuringPausePending(command.type))) {
        await rejectClaimedCommand(raw, modeNow === 'PAUSED' ? 'MASTER_PAUSED' : 'MASTER_PAUSE_PENDING_UNSAFE_COMMAND', {}, device);
        return send(res, 200, { ok: true, requeued: false, paused: true, masterMode: modeNow });
      }

      if (String(command.type || '').toUpperCase().startsWith('EXEC_')) {
        const halted = await emergencyStopActive();
        const gate = executionGate(command.type, halted);
        if (!gate.allowed) {
          await rejectClaimedCommand(raw, 'EXECUTION_LOCKED_' + gate.reason, {}, device);
          return send(res, 200, { ok: true, requeued: false, executionRejected: true, executionReason: gate.reason });
        }
        const readiness = await realExecutionReadiness(device.deviceId);
        if (!readiness.ok) {
          const deferred = await deferClaimedCommand(
            raw,
            command,
            'EXECUTION_NOT_READY_' + readiness.reason,
            device
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
        const deferred = await deferClaimedCommand(raw, command, reason, device, requestedDelayMs);
        return send(res, 200, {
          ok: true,
          requeued: deferred,
          deferred,
          retryAfterMs: requestedDelayMs,
        });
      }

      const clean = { ...command };
      delete clean.claimedAt;
      delete clean.claimedBy;
      clean.requeuedAt = Date.now();
      clean.requeuedBy = device.deviceId;
      const moved = await moveProcessingToPendingAtomic(
        raw,
        JSON.stringify(clean),
        device,
        'LPUSH'
      );
      return send(res, 200, { ok: true, requeued: moved === 1 });
    }

    if (action === 'emergency-stop' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['controller', 'master']);
      if (!device) return;

      const [wasActive, currentMode] = await Promise.all([
        emergencyStopActive(),
        masterMode(),
      ]);
      const panicEpoch = await assertEmergencyStop();

      // PANIC must always remain immediately available, but repeated presses must not flood audit history.
      if (wasActive && currentMode !== 'RUNNING') {
        return send(res, 200, {
          ok: true,
          emergencyStopActive: true,
          alreadyActive: true,
          executionMode: 'STOPPED',
          masterMode: currentMode,
          blockers: [],
          panicEpoch,
        });
      }

      const at = Date.now();

      // PANIC blocks new entries immediately but keeps close/protection work available.
      await setMasterMode('PAUSE_PENDING');
      const currentMaster = await masterDeviceId();
      const transition = await tryFinalizePendingPause(currentMaster, 'PAUSE_PENDING');

      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: wasActive ? 'EMERGENCY_STOP_REASSERTED' : 'EMERGENCY_STOP_SET',
        deviceId: device.deviceId,
        role: device.role,
        masterMode: transition.masterMode,
        blockers: transition.blockers || [],
        panicEpoch,
      })]);
      await redis(['LTRIM', KEY_AUDIT, '0', '199']);

      return send(res, 200, {
        ok: true,
        emergencyStopActive: true,
        alreadyActive: wasActive,
        executionMode: 'STOPPED',
        masterMode: transition.masterMode,
        blockers: transition.blockers || [],
        panicEpoch,
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

      const [currentMaster, registeredMaster, currentMode, panicEpochRaw] = await Promise.all([
        masterDeviceId(),
        roleDeviceId('master'),
        masterMode(),
        redis(['GET', KEY_EMERGENCY_STOP_EPOCH]),
      ]);
      const panicEpoch = String(panicEpochRaw || '0');
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

      const clearScript = [
        "local epoch = tostring(redis.call('GET', KEYS[2]) or '0')",
        "if epoch ~= ARGV[1] then return -1 end",
        "local panic = tostring(redis.call('GET', KEYS[1]) or '')",
        "if panic == '0' then return -2 end",
        "local mode = tostring(redis.call('GET', KEYS[3]) or 'PAUSED')",
        "if mode ~= 'PAUSED' then return -3 end",
        "local lease = tostring(redis.call('GET', KEYS[4]) or '')",
        "local registered = tostring(redis.call('GET', KEYS[5]) or '')",
        "if lease ~= ARGV[2] or registered ~= ARGV[2] then return -4 end",
        "local requester = tostring(redis.call('GET', KEYS[6]) or '')",
        "if requester ~= ARGV[3] then return -5 end",
        "local requesterEpoch = tonumber(redis.call('GET', KEYS[7]) or '0') or 0",
        "local requesterCreatedAt = tonumber(ARGV[4]) or 0",
        "if requesterEpoch > 0 and requesterCreatedAt < requesterEpoch then return -6 end",
        "redis.call('SET', KEYS[1], '0')",
        "return 1"
      ].join('\n');
      const clearResult = Number(await redis([
        'EVAL', clearScript, '7',
        KEY_EMERGENCY_STOP,
        KEY_EMERGENCY_STOP_EPOCH,
        KEY_MASTER_MODE,
        KEY_MASTER,
        KEY_MASTER_DEVICE,
        roleDeviceKey(device.role),
        roleAssignmentKey(PREFIX, device.role),
        panicEpoch,
        String(currentMaster),
        String(device.deviceId),
        String(Number(device.createdAt || 0)),
      ]));
      if (clearResult !== 1) {
        if (clearResult === -5 || clearResult === -6) clearDeviceSessionCookie(res);
        const requesterCode = device.role === 'controller'
          ? (clearResult === -6 ? 'CONTROLLER_SESSION_REVOKED' : 'CONTROLLER_ROLE_CHANGED')
          : (clearResult === -6 ? 'MASTER_SESSION_REVOKED' : 'MASTER_ROLE_CHANGED');
        const code = clearResult === -1
          ? 'EMERGENCY_STOP_CHANGED_DURING_CLEAR'
          : clearResult === -2
            ? 'EMERGENCY_STOP_NOT_ACTIVE'
            : clearResult === -3
              ? 'MASTER_MUST_BE_PAUSED'
              : clearResult === -4
                ? 'MASTER_LEASE_REQUIRED'
                : requesterCode;
        return send(res, 409, {
          ok: false,
          code,
          emergencyStopActive: true,
        });
      }
      const at = Date.now();
      await redis(['LPUSH', KEY_AUDIT, JSON.stringify({
        at,
        kind: 'EMERGENCY_STOP_CLEARED',
        deviceId: device.deviceId,
        role: device.role,
        masterDeviceId: currentMaster,
        reconciliationObservedAt: Number(reconciliation.report?.observedAt || 0),
        panicEpoch: Number(panicEpoch || 0),
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
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'MASTER_LEASE_REQUIRED' });
      }

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
      error: 'Zenith sync error',
    });
  }
}

export { binanceApiPermissionBlockers, binanceCredentialSeparationBlockers, adminSecretPolicyBlockers, pairingSecretPolicyBlockers };

export { clientIp };
