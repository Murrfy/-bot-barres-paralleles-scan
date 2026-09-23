export const DEVICE_SESSION_COOKIE = '__Host-zenith_device';
export const DEVICE_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function deviceSessionRemainingSeconds(record, now = Date.now()) {
  const createdAt = Number(record?.createdAt || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 0;
  const absoluteExpiresAt = createdAt + DEVICE_SESSION_MAX_AGE_SECONDS * 1000;
  return Math.max(0, Math.ceil((absoluteExpiresAt - now) / 1000));
}

export function deviceSessionRecordActive(record, now = Date.now()) {
  return deviceSessionRemainingSeconds(record, now) > 0;
}

export function validDeviceId(value) {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(String(value || ''));
}

function header(req, name) {
  const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

export function bearerToken(req) {
  const value = header(req, 'authorization').trim();
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : '';
}

function cookieMap(req) {
  const out = new Map();
  const raw = header(req, 'cookie');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const encoded = part.slice(at + 1).trim();
    if (!key) continue;
    try { out.set(key, decodeURIComponent(encoded)); }
    catch { out.set(key, encoded); }
  }
  return out;
}

export function cookieToken(req) {
  return String(cookieMap(req).get(DEVICE_SESSION_COOKIE) || '');
}

export function deviceTokenCandidates(req) {
  return [...new Set([bearerToken(req), cookieToken(req)].filter(Boolean))];
}

export function buildDeviceSessionCookie(token, maxAgeSeconds = DEVICE_SESSION_MAX_AGE_SECONDS) {
  const value = String(token || '');
  if (!value) throw new Error('DEVICE_SESSION_TOKEN_REQUIRED');
  const maxAge = Math.max(1, Math.floor(Number(maxAgeSeconds) || DEVICE_SESSION_MAX_AGE_SECONDS));
  return [
    `${DEVICE_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Priority=High',
  ].join('; ');
}

export function buildClearDeviceSessionCookie() {
  return [
    `${DEVICE_SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Priority=High',
  ].join('; ');
}

function appendSetCookie(res, cookie) {
  const current = typeof res?.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  const values = Array.isArray(current) ? current.slice() : current ? [String(current)] : [];
  values.push(cookie);
  res.setHeader('Set-Cookie', values);
}

export function setDeviceSessionCookie(res, token, maxAgeSeconds = DEVICE_SESSION_MAX_AGE_SECONDS) {
  appendSetCookie(res, buildDeviceSessionCookie(token, maxAgeSeconds));
}

export function clearDeviceSessionCookie(res) {
  appendSetCookie(res, buildClearDeviceSessionCookie());
}

function normalizedOrigin(value) {
  try { return new URL(String(value || '')).origin; }
  catch { return ''; }
}

export function expectedRequestOrigin(req) {
  const proto = header(req, 'x-forwarded-proto').split(',')[0].trim() || 'https';
  const host = header(req, 'x-forwarded-host').split(',')[0].trim() ||
    header(req, 'host').split(',')[0].trim();
  return host ? normalizedOrigin(`${proto}://${host}`) : '';
}

export function sameOriginMutation(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (['GET','HEAD','OPTIONS'].includes(method)) return true;
  if (bearerToken(req)) return true;

  const expected = expectedRequestOrigin(req);
  if (!expected) return false;

  const origin = header(req, 'origin');
  if (origin) return normalizedOrigin(origin) === expected;

  const referer = header(req, 'referer');
  if (referer) return normalizedOrigin(referer) === expected;

  return header(req, 'sec-fetch-site').toLowerCase() === 'same-origin';
}
