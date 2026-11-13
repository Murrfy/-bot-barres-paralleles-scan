// Décision de Walter (13/11/2026) : la perte MAX ne doit plus jamais bloquer Zenith.
// Achats, paliers, vente à l'objectif et fermeture passent toujours, quel que soit
// l'état de la MAX-LOSS sur Binance (absente, en double, non confirmée).
// La marge est isolée : la liquidation Binance borne déjà la perte à la marge.
// Seuls les tests peuvent réactiver l'ancien comportement bloquant (ZENITH_MAX_LOSS_ENFORCED=1).
export function maxLossEnforced(){
  try{
    return globalThis.process?.env?.ZENITH_MAX_LOSS_ENFORCED==='1';
  }catch(_){
    return false;
  }
}

// Raisons de réconciliation qui ne concernent que la présence ou la forme de la MAX-LOSS.
export const MAX_LOSS_ONLY_REASONS=Object.freeze([
  'MISSING_BINANCE_PROTECTION',
  'MISSING_BINANCE_MAX_LOSS_PROTECTION',
  'AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION',
  'CONFIGURED_MAX_LOSS_UNAVAILABLE',
  'MAX_LOSS_EXCEEDS_CONFIGURED_LIMIT',
]);

// Retire d'un rapport de réconciliation tout ce qui ne bloque qu'à cause de la MAX-LOSS.
// Le rapport reste fermé (failClosed) pour toute autre anomalie.
export function neutralizeMaxLossRequirements(result){
  if(maxLossEnforced()||!result||typeof result!=='object')return result;
  const drop=new Set(MAX_LOSS_ONLY_REASONS);
  const reasons=Array.isArray(result.reasons)?result.reasons.filter(reason=>!drop.has(reason)):[];
  result.reasons=reasons;
  const diff=result.differences&&typeof result.differences==='object'?result.differences:(result.differences={});
  diff.missingProtections=[];
  diff.missingMaxLossProtections=[];
  diff.ambiguousMaxLossProtections=[];
  diff.unsafeMaxLossProtections=[];
  diff.configuredMaxLossUnavailable=[];
  result.failClosed=reasons.length>0;
  if(result.failClosed)result.status='MISMATCH';
  else if(result.status==='MISMATCH'){
    result.status=String(result.runtimeMode||'').toUpperCase()==='REAL'?'CLEAN_REAL':'CLEAN_IDLE';
  }
  return result;
}
