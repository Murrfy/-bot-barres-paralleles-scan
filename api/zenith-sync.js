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
const SYNC_SECRET = process.env.ZENITH_SYNC_SECRET;

const PREFIX = 'zenith:v1';
const KEY_MASTER = `${PREFIX}:master`;
const KEY_STATE = `${PREFIX}:state`;
const KEY_PENDING = `${PREFIX}:commands:pending`;
const KEY_PROCESSING = `${PREFIX}:commands:processing`;
const MASTER_TTL_SECONDS = 20;

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

function authorized(req) {
  if (!SYNC_SECRET) return false;
  const supplied = req.headers['x-zenith-sync-secret'];
  return timingSafeEqualText(supplied, SYNC_SECRET);
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

async function masterDeviceId() {
  const value = await redis(['GET', KEY_MASTER]);
  return value ? String(value) : '';
}

async function hasMasterLease(deviceId) {
  if (!deviceId) return false;
  return (await masterDeviceId()) === String(deviceId);
}

async function acquireOrRenewMaster(deviceId) {
  const script = [
    "local current = redis.call('GET', KEYS[1])",
    "if (not current) or current == ARGV[1] then",
    "  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])",
    "  return 1",
    "end",
    "return 0"
  ].join('\n');
  const ok = await redis(['EVAL', script, '1', KEY_MASTER, String(deviceId), String(MASTER_TTL_SECONDS)]);
  return Number(ok) === 1;
}

export default async function handler(req, res) {
  const action = String(req.query?.action || 'health');

  if (action === 'health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      configured: Boolean(REDIS_URL && REDIS_TOKEN && SYNC_SECRET),
      redisConfigured: Boolean(REDIS_URL && REDIS_TOKEN),
      authConfigured: Boolean(SYNC_SECRET),
      mode: 'SYNC_SAFE_SIMULATION',
      masterTtlSeconds: MASTER_TTL_SECONDS,
    });
  }

  if (!authorized(req)) {
    return send(res, 401, { ok: false, code: 'UNAUTHORIZED' });
  }

  try {
    if (action === 'master-heartbeat' && req.method === 'POST') {
      const deviceId = String(req.body?.deviceId || '').trim();
      if (!deviceId) return send(res, 400, { ok: false, code: 'DEVICE_ID_REQUIRED' });
      const master = await acquireOrRenewMaster(deviceId);
      return send(res, 200, {
        ok: true,
        master,
        currentMaster: await masterDeviceId(),
        ttlSeconds: MASTER_TTL_SECONDS,
      });
    }

    if (action === 'master' && req.method === 'GET') {
      return send(res, 200, { ok: true, currentMaster: await masterDeviceId() });
    }

    if (action === 'state' && req.method === 'GET') {
      const raw = await redis(['GET', KEY_STATE]);
      let state = null;
      try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
      return send(res, 200, { ok: true, state });
    }

    if (action === 'state' && req.method === 'POST') {
      const deviceId = String(req.body?.deviceId || '').trim();
      if (!(await hasMasterLease(deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const snapshot = {
        version: 1,
        updatedAt: Date.now(),
        masterDeviceId: deviceId,
        data: req.body?.data ?? null,
      };
      await redis(['SET', KEY_STATE, JSON.stringify(snapshot)]);
      return send(res, 200, { ok: true, state: snapshot });
    }

    if (action === 'command' && req.method === 'POST') {
      const deviceId = String(req.body?.deviceId || '').trim();
      const type = String(req.body?.type || '').trim();
      if (!deviceId || !type) {
        return send(res, 400, { ok: false, code: 'COMMAND_INVALID' });
      }
      const command = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        deviceId,
        type,
        payload: req.body?.payload ?? null,
      };
      await redis(['RPUSH', KEY_PENDING, JSON.stringify(command)]);
      return send(res, 202, { ok: true, commandId: command.id });
    }

    if (action === 'command-next' && req.method === 'POST') {
      const deviceId = String(req.body?.deviceId || '').trim();
      if (!(await hasMasterLease(deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const raw = await redis(['RPOPLPUSH', KEY_PENDING, KEY_PROCESSING]);
      if (!raw) return send(res, 200, { ok: true, command: null });
      let command = null;
      try { command = JSON.parse(raw); } catch {}
      return send(res, 200, { ok: true, command, raw });
    }

    if (action === 'command-ack' && req.method === 'POST') {
      const deviceId = String(req.body?.deviceId || '').trim();
      const raw = String(req.body?.raw || '');
      if (!(await hasMasterLease(deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      if (!raw) return send(res, 400, { ok: false, code: 'RAW_REQUIRED' });
      await redis(['LREM', KEY_PROCESSING, '1', raw]);
      return send(res, 200, { ok: true });
    }

    if (action === 'command-requeue' && req.method === 'POST') {
      const deviceId = String(req.body?.deviceId || '').trim();
      const raw = String(req.body?.raw || '');
      if (!(await hasMasterLease(deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      if (!raw) return send(res, 400, { ok: false, code: 'RAW_REQUIRED' });
      const removed = await redis(['LREM', KEY_PROCESSING, '1', raw]);
      if (Number(removed) > 0) await redis(['LPUSH', KEY_PENDING, raw]);
      return send(res, 200, { ok: true, requeued: Number(removed) > 0 });
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
