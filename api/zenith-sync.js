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
const PAIRING_DISABLED = process.env.ZENITH_PAIRING_DISABLED === '1';

const PREFIX = 'zenith:v1';
const KEY_MASTER = `${PREFIX}:master`;
const KEY_STATE = `${PREFIX}:state`;
const KEY_PENDING = `${PREFIX}:commands:pending`;
const KEY_PROCESSING = `${PREFIX}:commands:processing`;
const MASTER_TTL_SECONDS = 20;
const PAIR_RATE_LIMIT = 5;

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
      redisConfigured: Boolean(REDIS_URL && REDIS_TOKEN),
      pairingConfigured: Boolean(PAIRING_CODE),
      pairingDisabled: PAIRING_DISABLED,
      mode: 'SYNC_SAFE_SIMULATION',
      masterTtlSeconds: MASTER_TTL_SECONDS,
    });
  }

  try {
    if (action === 'pair' && req.method === 'POST') {
      if (PAIRING_DISABLED) return send(res, 403, { ok: false, code: 'PAIRING_DISABLED' });
      if (!PAIRING_CODE) return send(res, 503, { ok: false, code: 'PAIRING_NOT_CONFIGURED' });
      if (!(await pairRateAllowed(req))) return send(res, 429, { ok: false, code: 'PAIRING_RATE_LIMIT' });

      const supplied = String(req.body?.pairingCode || '');
      const deviceId = String(req.body?.deviceId || '').trim();
      const role = String(req.body?.role || '').trim();
      const deviceName = String(req.body?.deviceName || '').trim().slice(0, 80);

      if (!timingSafeEqualText(supplied, PAIRING_CODE)) {
        return send(res, 401, { ok: false, code: 'PAIRING_CODE_INVALID' });
      }
      if (!deviceId || !['controller', 'master'].includes(role)) {
        return send(res, 400, { ok: false, code: 'PAIRING_REQUEST_INVALID' });
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

    if (action === 'master-heartbeat' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      const master = await acquireOrRenewMaster(device.deviceId);
      return send(res, 200, {
        ok: true,
        master,
        currentMaster: await masterDeviceId(),
        ttlSeconds: MASTER_TTL_SECONDS,
      });
    }

    if (action === 'master' && req.method === 'GET') {
      const device = await requireDevice(req, res);
      if (!device) return;
      return send(res, 200, { ok: true, currentMaster: await masterDeviceId() });
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
      const type = String(req.body?.type || '').trim();
      if (!type) return send(res, 400, { ok: false, code: 'COMMAND_INVALID' });
      const command = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        deviceId: device.deviceId,
        type,
        payload: req.body?.payload ?? null,
      };
      await redis(['RPUSH', KEY_PENDING, JSON.stringify(command)]);
      return send(res, 202, { ok: true, commandId: command.id });
    }

    if (action === 'command-next' && req.method === 'POST') {
      const device = await requireDevice(req, res, ['master']);
      if (!device) return;
      if (!(await hasMasterLease(device.deviceId))) {
        return send(res, 409, { ok: false, code: 'NOT_MASTER' });
      }
      const raw = await redis(['RPOPLPUSH', KEY_PENDING, KEY_PROCESSING]);
      if (!raw) return send(res, 200, { ok: true, command: null });
      let command = null;
      try { command = JSON.parse(raw); } catch {}
      return send(res, 200, { ok: true, command, raw });
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

    return send(res, 404, { ok: false, code: 'UNKNOWN_ACTION' });
  } catch (e) {
    return send(res, 500, {
      ok: false,
      code: e?.code || 'SYNC_ERROR',
      error: e?.message || 'Zenith sync error',
    });
  }
}
