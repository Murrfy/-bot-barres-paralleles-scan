export const EXECUTION_LEDGER_KEY = 'zenith:v1:audit:execution-stream';

const FORBIDDEN_KEY = /(secret|token|authorization|cookie|api[_-]?key|password)/i;

function hasForbiddenKey(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => hasForbiddenKey(v, depth + 1));
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) return true;
    if (hasForbiddenKey(child, depth + 1)) return true;
  }
  return false;
}

export function executionLedgerEventStatus(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok:false, reason:'EXECUTION_LEDGER_EVENT_OBJECT_REQUIRED' };
  }
  if (!Number.isFinite(Number(event.at)) || Number(event.at) <= 0) {
    return { ok:false, reason:'EXECUTION_LEDGER_TIMESTAMP_REQUIRED' };
  }
  if (!/^BINANCE_[A-Z0-9_]{3,80}$/.test(String(event.kind || ''))) {
    return { ok:false, reason:'EXECUTION_LEDGER_KIND_INVALID' };
  }
  if (hasForbiddenKey(event)) {
    return { ok:false, reason:'EXECUTION_LEDGER_SENSITIVE_FIELD_FORBIDDEN' };
  }
  const json = JSON.stringify(event);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > 16 * 1024) {
    return { ok:false, reason:'EXECUTION_LEDGER_EVENT_TOO_LARGE', bytes };
  }
  return { ok:true, json, bytes };
}

export async function appendExecutionLedger(redis, event) {
  if (typeof redis !== 'function') throw new Error('EXECUTION_LEDGER_REDIS_REQUIRED');
  const status = executionLedgerEventStatus(event);
  if (!status.ok) throw new Error(status.reason);
  const id = await redis(['XADD', EXECUTION_LEDGER_KEY, '*', 'event', status.json]);
  if (!id) throw new Error('EXECUTION_LEDGER_APPEND_FAILED');
  return { id:String(id), bytes:status.bytes };
}
