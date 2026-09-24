import { deterministicClientOrderId } from './order-intent.mjs';
import { REAL_RISK_LIMITS } from './risk-policy.mjs';

export const ENTRY_INTENT_MAX_AGE_MS = 2 * 60 * 1000;
export const ENTRY_INTENT_ACTIVE_PHASES = Object.freeze([
  'PROTECTION_ARMED',
  'ENTRY_SUBMITTED',
]);

function n(value, fallback = NaN) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function bool(value) {
  return value === true || value === 'true';
}

function sameNumber(a, b) {
  const aa = n(a), bb = n(b);
  if (!Number.isFinite(aa) || !Number.isFinite(bb)) return false;
  return Math.abs(aa - bb) <= Math.max(1e-9, Math.abs(bb) * 1e-10);
}

function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{3,30}$/.test(symbol) ? symbol : '';
}

function cleanCommandId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(id) ? id : '';
}

export function normalizeActiveEntryIntent(intent, now = Date.now()) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null;
  if (Number(intent.version) !== 1) return null;

  const commandId = cleanCommandId(intent.commandId);
  const symbol = cleanSymbol(intent.symbol);
  const side = String(intent.side || '').toUpperCase();
  const phase = String(intent.phase || '').toUpperCase();
  const quantity = n(intent.quantity);
  const limitPrice = n(intent.limitPrice);
  const maxLossUsd = n(intent.maxLossUsd);
  const protectionTriggerPrice = n(intent.protectionTriggerPrice);
  const protectionClientAlgoId = String(intent.protectionClientAlgoId || '');
  const createdAt = Math.floor(n(intent.createdAt));
  const expiresAt = Math.floor(n(intent.expiresAt));

  if (!commandId || !symbol || !['BUY','SELL'].includes(side)) return null;
  if (!ENTRY_INTENT_ACTIVE_PHASES.includes(phase)) return null;
  if (!(quantity > 0) || !(limitPrice > 0) || !(maxLossUsd > 0) || !(protectionTriggerPrice > 0)) return null;
  if (maxLossUsd > REAL_RISK_LIMITS.maxLossUsd + 1e-8) return null;
  if (!(createdAt > 0) || !(expiresAt > createdAt)) return null;
  if (expiresAt - createdAt > ENTRY_INTENT_MAX_AGE_MS) return null;
  if (now < createdAt || now > expiresAt) return null;

  const expectedProtectionId = deterministicClientOrderId({
    commandId,
    symbol,
    leg: 'MAXLOSS_STOP',
  });
  if (protectionClientAlgoId !== expectedProtectionId) return null;

  const protectiveSide = side === 'BUY' ? 'SELL' : 'BUY';
  const lossSide = side === 'BUY'
    ? protectionTriggerPrice < limitPrice
    : protectionTriggerPrice > limitPrice;
  if (!lossSide) return null;

  const impliedLossUsd = side === 'BUY'
    ? (limitPrice - protectionTriggerPrice) * quantity
    : (protectionTriggerPrice - limitPrice) * quantity;
  if (!(impliedLossUsd >= 0) ||
      impliedLossUsd > maxLossUsd + 1e-8 ||
      impliedLossUsd > REAL_RISK_LIMITS.maxLossUsd + 1e-8) return null;

  return {
    version: 1,
    commandId,
    symbol,
    side,
    phase,
    quantity,
    limitPrice,
    maxLossUsd,
    protectionTriggerPrice,
    protectionClientAlgoId,
    protectiveSide,
    impliedLossUsd,
    createdAt,
    expiresAt,
  };
}

export function activeEntryIntents(runtimeState, now = Date.now()) {
  const rows = Array.isArray(runtimeState?.data?.pendingEntryIntents)
    ? runtimeState.data.pendingEntryIntents
    : [];
  const out = [];
  for (const row of rows) {
    try {
      const normalized = normalizeActiveEntryIntent(row, now);
      if (normalized) out.push(normalized);
    } catch {}
  }
  return out;
}

export function stagedEntryProtectionMatchesIntent(order, intent, now = Date.now()) {
  const normalized = normalizeActiveEntryIntent(intent, now);
  if (!normalized || !order || typeof order !== 'object') return false;

  if (String(order.orderClass || '').toUpperCase() !== 'ALGO') return false;
  if (String(order.symbol || '').toUpperCase() !== normalized.symbol) return false;
  if (String(order.side || '').toUpperCase() !== normalized.protectiveSide) return false;
  if (String(order.positionSide || 'BOTH').toUpperCase() !== 'BOTH') return false;
  if (String(order.type || order.orderType || '').toUpperCase() !== 'STOP_MARKET') return false;
  if (!bool(order.closePosition) || bool(order.reduceOnly)) return false;
  if (String(order.clientAlgoId || '') !== normalized.protectionClientAlgoId) return false;

  const triggerPrice = n(order.triggerPrice ?? order.stopPrice);
  if (!sameNumber(triggerPrice, normalized.protectionTriggerPrice)) return false;

  return true;
}

export function stagedEntryProtectionMatchesRuntimeIntent(order, runtimeState, now = Date.now()) {
  return activeEntryIntents(runtimeState, now)
    .some(intent => stagedEntryProtectionMatchesIntent(order, intent, now));
}
