import crypto from 'node:crypto';
import { deviceTokenCandidates, sameOriginMutation, deviceSessionRecordActive, roleAssignmentKey, deviceRoleAssignmentActive } from '../lib/device-session.mjs';
import { requestBodyStatus } from '../lib/request-body-limit.mjs';

const BASE = 'https://fapi.binance.com';
const PREFIX = 'zenith:v1';
const KEY_MASTER = `${PREFIX}:master`;
const KEY_MASTER_DEVICE = `${PREFIX}:role-device:master`;
const KEY_STREAM_SESSION = `${PREFIX}:binance-user-stream`;
const KEY_STREAM_MUTATION_LOCK = `${PREFIX}:binance-user-stream:mutation-lock`;
const SESSION_TTL_SECONDS = 70 * 60;
const KEEPALIVE_AFTER_MS = 45 * 60 * 1000;
const USER_STREAM_MUTATION_RATE_LIMIT_PER_MINUTE = 12;
const USER_STREAM_MUTATION_LOCK_TTL_SECONDS = 20;
const VERCEL_PRODUCTION_WRITE_ALLOWED = process.env.VERCEL_ENV === 'production' && process.env.VERCEL_GIT_COMMIT_REF === 'main';

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_REDIS_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
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

async function requireCurrentMaster(req) {
  for (const token of deviceTokenCandidates(req)) {
    const hash = sha256(token);
    const raw = await redis(['GET', `${PREFIX}:device:${hash}`]);
    if (!raw) continue;
    let device = null;
    try { device = JSON.parse(raw); } catch {}
    if (!deviceSessionRecordActive(device) || !device?.deviceId || device.role !== 'master') continue;

    const [registered, lease] = await Promise.all([
      redis(['GET', KEY_MASTER_DEVICE]),
      redis(['GET', KEY_MASTER]),
    ]);
    if (String(registered || '') !== String(device.deviceId)) continue;
    const issuedAt=await redis(['GET',roleAssignmentKey(PREFIX,'master')]);
    if(!deviceRoleAssignmentActive(device,issuedAt))continue;
    if (String(lease || '') !== String(device.deviceId)) {
      const e = new Error('MASTER_LEASE_REQUIRED');
      e.code = 'MASTER_LEASE_REQUIRED';
      throw e;
    }
    return { ...device, roleIssuedAt: String(issuedAt || '0') };
  }
  return null;
}

async function acquireUserStreamMutationLock(master) {
  const token = crypto.randomUUID();
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[1]) or '')",
    "local lease = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registered ~= ARGV[1] or lease ~= ARGV[1] then return -1 end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[3]) or '0')",
    "if roleEpoch ~= ARGV[2] then return -2 end",
    "local locked = redis.call('SET', KEYS[4], ARGV[3], 'EX', ARGV[4], 'NX')",
    "if not locked then return 0 end",
    "return 1"
  ].join('\n');
  const result = Number(await redis([
    'EVAL', script, '4',
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    KEY_STREAM_MUTATION_LOCK,
    String(master?.deviceId || ''),
    String(master?.roleIssuedAt || '0'),
    token,
    String(USER_STREAM_MUTATION_LOCK_TTL_SECONDS),
  ]));
  return {
    ok: result === 1,
    token: result === 1 ? token : '',
    reason: result === -1
      ? 'MASTER_LEASE_REQUIRED'
      : result === -2
        ? 'MASTER_ROLE_CHANGED'
        : result === 0
          ? 'USER_STREAM_MUTATION_BUSY'
          : 'USER_STREAM_MUTATION_FENCE_FAILED',
  };
}

async function releaseUserStreamMutationLock(token) {
  if (!token) return false;
  const script = [
    "if tostring(redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end",
    "redis.call('DEL', KEYS[1])",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '1',
    KEY_STREAM_MUTATION_LOCK,
    String(token),
  ])) === 1;
}

async function binanceListenKey(method) {
  const apiKey = process.env.BINANCE_API_KEY;
  if (!apiKey) {
    const e = new Error('BINANCE_API_KEY_MISSING');
    e.code = 'BINANCE_API_KEY_MISSING';
    throw e;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${BASE}/fapi/v1/listenKey`, {
      method,
      headers: { 'X-MBX-APIKEY': apiKey },
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!r.ok || data?.code) {
      const e = new Error(data?.msg || `Binance HTTP ${r.status}`);
      e.code = 'BINANCE_USER_STREAM_FAILED';
      e.status = r.status;
      e.binanceCode = data?.code;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function readSessionWithRaw() {
  const raw = await redis(['GET', KEY_STREAM_SESSION]);
  if (!raw) return { raw:'', record:null };
  try { return { raw:String(raw), record:JSON.parse(raw) }; }
  catch { return { raw:String(raw), record:null }; }
}

async function readSession() {
  return (await readSessionWithRaw()).record;
}

function sessionCommitReason(code) {
  if (code === -1) return 'MASTER_ROLE_CHANGED';
  if (code === -2) return 'MASTER_LEASE_REQUIRED';
  if (code === -3) return 'MASTER_ROLE_EPOCH_CHANGED';
  if (code === -4) return 'USER_STREAM_MUTATION_LOCK_LOST';
  if (code === -5) return 'USER_STREAM_SESSION_CHANGED';
  return 'USER_STREAM_SESSION_COMMIT_FAILED';
}

async function saveSessionAtomic(record, master, mutationLockToken, expectedRaw = null) {
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registered ~= ARGV[1] then return -1 end",
    "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
    "if lease ~= ARGV[1] then return -2 end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[4]) or '0')",
    "if roleEpoch ~= ARGV[2] then return -3 end",
    "local lock = tostring(redis.call('GET', KEYS[5]) or '')",
    "if lock ~= ARGV[3] then return -4 end",
    "if ARGV[6] == '1' then",
    "  local current = tostring(redis.call('GET', KEYS[1]) or '')",
    "  if current ~= ARGV[7] then return -5 end",
    "end",
    "redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5])",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '5',
    KEY_STREAM_SESSION,
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    KEY_STREAM_MUTATION_LOCK,
    String(master?.deviceId || ''),
    String(master?.roleIssuedAt || '0'),
    String(mutationLockToken || ''),
    JSON.stringify(record),
    String(SESSION_TTL_SECONDS),
    expectedRaw === null ? '0' : '1',
    expectedRaw === null ? '' : String(expectedRaw),
  ]));
}

async function deleteSessionAtomic(master, mutationLockToken, expectedRaw) {
  const script = [
    "local registered = tostring(redis.call('GET', KEYS[2]) or '')",
    "if registered ~= ARGV[1] then return -1 end",
    "local lease = tostring(redis.call('GET', KEYS[3]) or '')",
    "if lease ~= ARGV[1] then return -2 end",
    "local roleEpoch = tostring(redis.call('GET', KEYS[4]) or '0')",
    "if roleEpoch ~= ARGV[2] then return -3 end",
    "local lock = tostring(redis.call('GET', KEYS[5]) or '')",
    "if lock ~= ARGV[3] then return -4 end",
    "local current = tostring(redis.call('GET', KEYS[1]) or '')",
    "if current ~= ARGV[4] then return -5 end",
    "redis.call('DEL', KEYS[1])",
    "return 1"
  ].join('\n');
  return Number(await redis([
    'EVAL', script, '5',
    KEY_STREAM_SESSION,
    KEY_MASTER_DEVICE,
    KEY_MASTER,
    roleAssignmentKey(PREFIX, 'master'),
    KEY_STREAM_MUTATION_LOCK,
    String(master?.deviceId || ''),
    String(master?.roleIssuedAt || '0'),
    String(mutationLockToken || ''),
    String(expectedRaw || ''),
  ]));
}

function sendSessionCommitFailure(res, code) {
  return send(res, code === -4 ? 409 : code < 0 ? 409 : 503, {
    ok:false,
    code:sessionCommitReason(code),
    tradingWriteAttempted:false,
  });
}

async function userStreamMutationRateAllowed(masterDeviceId) {
  const bucket = Math.floor(Date.now() / 60000);
  const key = `${PREFIX}:rate:user-stream:${sha256(masterDeviceId)}:${bucket}`;
  const script = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    "return count"
  ].join('\n');
  const count = Number(await redis(['EVAL', script, '1', key, '120'])) || 0;
  return count <= USER_STREAM_MUTATION_RATE_LIMIT_PER_MINUTE;
}

function retryAfterSeconds() {
  return Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
}

function publicSession(record) {
  if (!record) return null;
  return {
    version: Number(record.version || 1),
    masterDeviceId: String(record.masterDeviceId || ''),
    startedAt: Number(record.startedAt || 0),
    keepaliveAt: Number(record.keepaliveAt || 0),
    expiresAt: Number(record.expiresAt || 0),
    keepaliveDueAt: Number(record.keepaliveDueAt || 0),
    hasListenKey: Boolean(record.listenKey),
  };
}

export default async function handler(req, res) {
  if (!sameOriginMutation(req)) {
    return send(res, 403, { ok: false, code: 'ORIGIN_FORBIDDEN' });
  }

  if (req.method === 'POST') {
    const bodyStatus = requestBodyStatus(req, 64 * 1024);
    if (!bodyStatus.ok) {
      return send(res, 413, { ok:false, code:'REQUEST_BODY_TOO_LARGE', maxBytes:bodyStatus.maxBytes, tradingWriteAttempted:false });
    }
  }

  let master = null;
  try {
    master = await requireCurrentMaster(req);
  } catch (e) {
    if (e?.code === 'MASTER_LEASE_REQUIRED') {
      return send(res, 409, { ok: false, code: 'MASTER_LEASE_REQUIRED' });
    }
    return send(res, 503, { ok: false, code: e?.code || 'AUTH_BACKEND_ERROR' });
  }
  if (!master) {
    return send(res, 401, { ok: false, code: 'MASTER_REQUIRED' });
  }

  const action = String(req.query?.action || 'status').toLowerCase();
  const mutation = req.method === 'POST' && ['start', 'keepalive', 'close'].includes(action);

  if (mutation && !VERCEL_PRODUCTION_WRITE_ALLOWED) {
    return send(res, 423, { ok: false, code: 'NON_PRODUCTION_DEPLOYMENT', tradingWriteAttempted: false });
  }

  let mutationLockToken = '';
  if (mutation) {
    try {
      if (!(await userStreamMutationRateAllowed(master.deviceId))) {
        const retryAfter = retryAfterSeconds();
        res.setHeader('Retry-After', String(retryAfter));
        return send(res, 429, {
          ok: false,
          code: 'USER_STREAM_RATE_LIMIT',
          retryAfterSeconds: retryAfter,
          tradingWriteAttempted: false,
        });
      }
      const lock = await acquireUserStreamMutationLock(master);
      if (!lock.ok) {
        const status = lock.reason === 'USER_STREAM_MUTATION_BUSY' ? 409 :
          lock.reason === 'MASTER_LEASE_REQUIRED' || lock.reason === 'MASTER_ROLE_CHANGED' ? 409 : 503;
        return send(res, status, {
          ok: false,
          code: lock.reason,
          tradingWriteAttempted: false,
        });
      }
      mutationLockToken = lock.token;
    } catch (e) {
      return send(res, 503, {
        ok: false,
        code: e?.code || 'USER_STREAM_MUTATION_FENCE_UNAVAILABLE',
        tradingWriteAttempted: false,
      });
    }
  }

  try {
    if (action === 'status' && req.method === 'GET') {
      const session = await readSession();
      const owned = session && String(session.masterDeviceId || '') === String(master.deviceId);
      return send(res, 200, {
        ok: true,
        active: Boolean(owned && session.listenKey),
        session: owned ? publicSession(session) : null,
        keepaliveAfterMs: KEEPALIVE_AFTER_MS,
        tradingWriteAttempted: false,
      });
    }

    if (action === 'start' && req.method === 'POST') {
      const data = await binanceListenKey('POST');
      const listenKey = String(data?.listenKey || '');
      if (!listenKey) {
        return send(res, 502, { ok: false, code: 'BINANCE_LISTEN_KEY_MISSING' });
      }
      const now = Date.now();
      const record = {
        version: 1,
        listenKey,
        masterDeviceId: master.deviceId,
        startedAt: now,
        keepaliveAt: now,
        keepaliveDueAt: now + KEEPALIVE_AFTER_MS,
        expiresAt: now + 60 * 60 * 1000,
      };
      const committed = await saveSessionAtomic(record, master, mutationLockToken);
      if (committed !== 1) return sendSessionCommitFailure(res, committed);
      return send(res, 200, {
        ok: true,
        listenKey,
        session: publicSession(record),
        keepaliveAfterMs: KEEPALIVE_AFTER_MS,
        tradingWriteAttempted: false,
      });
    }

    if (action === 'keepalive' && req.method === 'POST') {
      const existingState = await readSessionWithRaw();
      const existing = existingState.record;
      if (!existing?.listenKey || String(existing.masterDeviceId || '') !== String(master.deviceId)) {
        return send(res, 409, { ok: false, code: 'USER_STREAM_SESSION_REQUIRED' });
      }
      const data = await binanceListenKey('PUT');
      const refreshedListenKey = String(data?.listenKey || existing.listenKey);
      const now = Date.now();
      const record = {
        ...existing,
        listenKey: refreshedListenKey,
        keepaliveAt: now,
        keepaliveDueAt: now + KEEPALIVE_AFTER_MS,
        expiresAt: now + 60 * 60 * 1000,
      };
      const committed = await saveSessionAtomic(record, master, mutationLockToken, existingState.raw);
      if (committed !== 1) return sendSessionCommitFailure(res, committed);
      return send(res, 200, {
        ok: true,
        listenKeyChanged: refreshedListenKey !== existing.listenKey,
        session: publicSession(record),
        tradingWriteAttempted: false,
      });
    }

    if (action === 'close' && req.method === 'POST') {
      const existingState = await readSessionWithRaw();
      const existing = existingState.record;
      if (existing?.listenKey && String(existing.masterDeviceId || '') === String(master.deviceId)) {
        await binanceListenKey('DELETE');
      }
      const committed = await deleteSessionAtomic(master, mutationLockToken, existingState.raw);
      if (committed !== 1) return sendSessionCommitFailure(res, committed);
      return send(res, 200, {
        ok: true,
        closed: true,
        tradingWriteAttempted: false,
      });
    }

    return send(res, 405, { ok: false, code: 'METHOD_OR_ACTION_NOT_ALLOWED' });
  } catch (e) {
    return send(res, e?.status === 401 || e?.status === 403 ? 502 : 503, {
      ok: false,
      code: e?.code || 'USER_STREAM_SESSION_ERROR',
      error: 'Binance user stream session unavailable.',
      binanceCode: e?.binanceCode,
      tradingWriteAttempted: false,
    });
  } finally {
    if (mutationLockToken) {
      try { await releaseUserStreamMutationLock(mutationLockToken); } catch {}
    }
  }
}
