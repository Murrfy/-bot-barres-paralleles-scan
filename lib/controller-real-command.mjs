function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('SYMBOL_INVALID');
  return symbol;
}

function safeIdPart(value, max = 28) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .slice(0, max);
}

function compactNumber(value) {
  const n = num(value);
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toPrecision(12)));
}

export function realPositionKey(position) {
  const symbol = cleanSymbol(position?.symbol);
  const side = String(position?.positionSide || 'BOTH').toUpperCase();
  const amt = compactNumber(position?.positionAmt);
  return `${symbol}:${safeIdPart(side,8)}:${safeIdPart(amt,24)}`;
}

export function buildControllerRealCloseCommand(position) {
  const symbol = cleanSymbol(position?.symbol);
  const positionSide = String(position?.positionSide || 'BOTH').toUpperCase();
  if (positionSide !== 'BOTH') throw new Error('HEDGE_MODE_UNSUPPORTED');

  const amount = num(position?.positionAmt);
  if (!Number.isFinite(amount) || amount === 0) throw new Error('POSITION_AMOUNT_INVALID');

  const direction = amount > 0 ? 'LONG' : 'SHORT';
  const quantity = Math.abs(amount);
  const entry = compactNumber(position?.entryPrice);
  const stamp = Math.max(0, Math.floor(num(position?.updateTime) || 0));
  const amountPart = safeIdPart(compactNumber(quantity),24);
  const entryPart = safeIdPart(entry || '0',24);
  const rawId = `realclose:${symbol}:${direction}:${amountPart}:${entryPart}:${stamp}`;
  const clientCommandId = rawId.slice(0,128);

  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientCommandId)) throw new Error('CLIENT_COMMAND_ID_INVALID');

  return {
    type: 'EXEC_CLOSE_POSITION',
    clientCommandId,
    payload: {
      symbol,
      direction,
      quantity,
      exitMode: 'PROTECTIVE_IOC',
      attempt: 0,
    },
  };
}
