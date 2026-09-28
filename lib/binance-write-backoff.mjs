export const BINANCE_WRITE_BACKOFF_KEY = 'zenith:v1:binance:write-backoff';

function positiveInt(value, fallback = 0) {
  const n = Math.ceil(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function binanceBackoffSecondsFromError(error) {
  const status = Number(error?.status || 0);
  if (status !== 429 && status !== 418) return 0;
  const explicit = positiveInt(error?.retryAfterSeconds);
  if (explicit > 0) return explicit;
  // Binance documents Retry-After for IP-limit 429/418. Use a conservative
  // fallback only if an upstream/proxy omitted the header.
  return status === 418 ? 300 : 60;
}

export async function readBinanceWriteBackoff(redis, now = Date.now()) {
  const raw = await redis(['GET', BINANCE_WRITE_BACKOFF_KEY]);
  if (!raw) return { active:false, retryAfterSeconds:0, until:0, status:0 };
  let record = null;
  try { record = JSON.parse(raw); } catch {}
  const until = Number(record?.until || 0);
  const remainingMs = until - now;
  if (!(remainingMs > 0)) {
    await redis(['DEL', BINANCE_WRITE_BACKOFF_KEY]);
    return { active:false, retryAfterSeconds:0, until:0, status:0 };
  }
  return {
    active:true,
    retryAfterSeconds:Math.max(1, Math.ceil(remainingMs / 1000)),
    until,
    status:Number(record?.status || 0),
  };
}

export async function registerBinanceWriteBackoff(redis, error, now = Date.now()) {
  const seconds = binanceBackoffSecondsFromError(error);
  if (!(seconds > 0)) return { active:false, retryAfterSeconds:0, until:0, status:Number(error?.status || 0) };
  const until = now + seconds * 1000;
  const status = Number(error?.status || 0);
  const record = JSON.stringify({ version:1, status, until, recordedAt:now });
  await redis(['SET', BINANCE_WRITE_BACKOFF_KEY, record, 'EX', String(seconds)]);
  return { active:true, retryAfterSeconds:seconds, until, status };
}
