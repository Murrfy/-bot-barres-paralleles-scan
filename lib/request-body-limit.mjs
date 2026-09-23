function numericContentLength(req) {
  const raw = req?.headers?.['content-length'];
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function serializedBodyBytes(req) {
  const body = req?.body;
  if (body === undefined || body === null) return 0;
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function requestBodyStatus(req, maxBytes) {
  const max = Number(maxBytes);
  if (!Number.isFinite(max) || max <= 0) throw new Error('REQUEST_BODY_LIMIT_INVALID');

  const declared = numericContentLength(req);
  if (declared !== null && declared > max) {
    return { ok: false, reason: 'CONTENT_LENGTH', bytes: declared, maxBytes: max };
  }

  const parsed = serializedBodyBytes(req);
  if (parsed > max) {
    return { ok: false, reason: 'PARSED_BODY', bytes: parsed, maxBytes: max };
  }

  return {
    ok: true,
    bytes: Math.max(parsed, declared ?? 0),
    maxBytes: max,
  };
}
