import fs from 'node:fs';

const htmlFiles = [
  'index.html',
  'pair-controller.html',
  'controller-status.html',
  'pair-master.html',
  'master-standby.html',
  'master-admin.html',
  'replace-controller.html',
].filter(fs.existsSync);

let failed = false;

const runtimePolicy = JSON.parse(fs.readFileSync('package.json','utf8'));
if (runtimePolicy?.engines?.node !== '24.x') {
  fail('package.json must pin Zenith to Node 24.x');
}
const safetyWorkflow = fs.readFileSync('.github/workflows/zenith-safety.yml','utf8');
for (const required of [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  "node-version: '24'",
  'persist-credentials: false',
  'allow-unsafe-pr-checkout: false',
  'package-manager-cache: false',
]) {
  if (!safetyWorkflow.includes(required)) fail(`CI runtime/supply-chain hardening missing: ${required}`);
}

if (!fs.existsSync('.github/workflows/codeql.yml')) {
  fail('CodeQL security workflow must exist');
} else {
  const codeqlWorkflow = fs.readFileSync('.github/workflows/codeql.yml','utf8');
  for (const required of [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'github/codeql-action/init@1c5b675653bb5c22dbe9b12b556ec555138e09fd',
    'github/codeql-action/analyze@1c5b675653bb5c22dbe9b12b556ec555138e09fd',
    'security-events: write',
    'security-extended',
    'persist-credentials: false',
    'allow-unsafe-pr-checkout: false',
  ]) {
    if (!codeqlWorkflow.includes(required)) fail(`CodeQL hardening missing: ${required}`);
  }
}
if (!fs.existsSync('.github/dependabot.yml') ||
    !fs.readFileSync('.github/dependabot.yml','utf8').includes('package-ecosystem: "github-actions"')) {
  fail('Dependabot must keep pinned GitHub Actions updated');
}

function fail(message) {
  failed = true;
  console.error('FAIL:', message);
}

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

  scripts.forEach((source, index) => {
    try {
      new Function(source);
    } catch (error) {
      fail(`${file}: inline script ${index + 1} syntax error: ${error.message}`);
    }
  });

  if (/<\/[^>]+>\\n\s*</.test(html)) {
    fail(`${file}: literal \\n found between HTML tags`);
  }
}

const index = fs.readFileSync('index.html', 'utf8');
const deviceSession = fs.readFileSync('lib/device-session.mjs', 'utf8');
for (const required of ["__Host-zenith_device","HttpOnly","Secure","SameSite=Strict","Priority=High","sameOriginMutation","deviceTokenCandidates"]) {
  if (!deviceSession.includes(required)) fail(`device session hardening missing: ${required}`);
}
if (deviceSession.includes('if (bearerToken(req)) return true;')) {
  fail('Bearer device tokens must never bypass same-origin mutation checks');
}
if (deviceSession.includes("header(req, 'x-forwarded-host')")) {
  fail('same-origin security must not trust x-forwarded-host');
}
for (const file of ['pair-controller.html','pair-master.html','replace-controller.html']) {
  const html=fs.readFileSync(file,'utf8');
  if (html.includes('localStorage.setItem(DEVICE_TOKEN_KEY')) fail(`${file} must not store device credentials in localStorage`);
  if (!html.includes('localStorage.removeItem(DEVICE_TOKEN_KEY)')) fail(`${file} must purge legacy localStorage device credentials`);
  if (!html.includes('sessionReady')) fail(`${file} must complete pairing/recovery through the secure server session`);
}
for (const file of ['index.html','master-admin.html','master-standby.html','controller-status.html']) {
  const html=fs.readFileSync(file,'utf8');
  if (!html.includes('localStorage.removeItem(')) fail(`${file} must purge migrated legacy credentials after authenticated session bootstrap`);
}

if (!index.includes('simulation uniquement')) {
  fail('index.html must keep the visible simulation-only marker until real trading is deliberately released');
}
if (!index.includes('startBinanceAccountReadOnly()')) {
  fail('index.html must keep Binance read-only account refresh');
}
if (!index.includes('protectionValidationError') ||
    !index.includes('step="0.1" inputmode="decimal"') ||
    !index.includes('Décimales acceptées avec un point (ex. 7.8)') ||
    !index.includes('le gain protégé doit être inférieur au gain atteint') ||
    !index.includes('le niveau PROTÉGÉ ne peut pas redescendre')) {
  fail('gain protections must support decimal input and reject incoherent protection ladders');
}
if (!index.includes("normalExit:'LIMIT_EXACT_GTC'") ||
    !index.includes("protectiveExit:'LIMIT_IOC_ADAPTIVE'") ||
    !index.includes("primaryPriceMatch:'OPPONENT'") ||
    !index.includes("fallback:'MARKET_LAST_RESORT'")) {
  fail('Zenith must keep LIMIT-first exit execution policy with market only as last resort');
}
for (const file of ['index.html','master-admin.html','master-standby.html','controller-status.html']) {
  const html=fs.readFileSync(file,'utf8');
  const bearerUses=[...html.matchAll(/Authorization\s*:\s*['"`]Bearer\s*['"`]\s*\+\s*(?:token|legacyToken)/g)].length;
  const legacyRead=[...html.matchAll(/localStorage\.getItem\([^\n]*TOKEN_KEY[^\n]*\)/g)].length;
  if (file === 'index.html' && bearerUses > 1) fail('index.html may use Bearer only for one-time legacy session migration');
  if (file === 'master-admin.html' && bearerUses > 1) fail('master-admin.html may use Bearer only for one-time legacy session migration');
  if (file === 'master-standby.html' && bearerUses > 1) fail('master-standby.html may use Bearer only for one-time legacy session migration');
  if (file === 'controller-status.html' && bearerUses > 1) fail('controller-status.html may use Bearer only for one-time legacy session migration');
  if (legacyRead > 1) fail(`${file} must not repeatedly read device credentials from localStorage`);
}

for (const [name, source] of [
  ['api/zenith-sync.js', fs.readFileSync('api/zenith-sync.js', 'utf8')],
  ['api/binance-read.js', fs.readFileSync('api/binance-read.js', 'utf8')],
  ['api/binance-reconcile.js', fs.readFileSync('api/binance-reconcile.js', 'utf8')],
]) {
  for (const secretName of ['BINANCE_API_KEY','BINANCE_API_SECRET','UPSTASH_REDIS_REST_TOKEN']) {
    const literal = new RegExp(secretName + "\\s*=\\s*['\\\"][^'\\\"]+['\\\"]");
    if (literal.test(source)) fail(`${name} contains a hard-coded secret assignment for ${secretName}`);
  }
}
const binanceRead = fs.readFileSync('api/binance-read.js', 'utf8');
for (const forbidden of ['/fapi/v1/order', '/fapi/v1/algoOrder', '/fapi/v1/batchOrders']) {
  if (binanceRead.includes(forbidden)) {
    fail(`api/binance-read.js must remain read-only; forbidden endpoint found: ${forbidden}`);
  }
}
if (!binanceRead.includes("'UNAUTHORIZED_DEVICE'") || !binanceRead.includes('requireZenithDevice')) {
  fail('api/binance-read.js must require a paired Zenith device');
}
if (!binanceRead.includes('role-device:controller') || !binanceRead.includes('role-device:master')) {
  fail('api/binance-read.js must reject tokens from devices that no longer own their Zenith role');
}
if (!binanceRead.includes('BINANCE_READ_RATE_LIMIT_PER_MINUTE = 12') ||
    !binanceRead.includes('binanceReadRateAllowed') ||
    !binanceRead.includes("'BINANCE_READ_RATE_LIMIT'") ||
    !binanceRead.includes("res.setHeader('Retry-After'")) {
  fail('api/binance-read.js must rate-limit authenticated account reads before contacting Binance');
}
if (!binanceRead.includes('/fapi/v1/openAlgoOrders')) {
  fail('api/binance-read.js must count Binance algo TP/SL orders');
}
if (!binanceRead.includes('standardOrderDetails') || !binanceRead.includes('clientOrderId') || !binanceRead.includes('reduceOnly')) {
  fail('api/binance-read.js must expose sanitized standard open-order details for safe controller cancellation');
}

const binancePreflight = fs.readFileSync('api/binance-entry-preflight.js', 'utf8');
for (const forbidden of ['/fapi/v1/order', '/fapi/v1/algoOrder', '/fapi/v1/batchOrders']) {
  if (binancePreflight.includes(forbidden)) {
    fail(`api/binance-entry-preflight.js must remain read-only; forbidden endpoint found: ${forbidden}`);
  }
}
for (const required of ['/fapi/v1/symbolConfig','/fapi/v1/leverageBracket','/fapi/v1/positionSide/dual','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders']) {
  if (!binancePreflight.includes(required)) fail(`api/binance-entry-preflight.js missing required read-only check: ${required}`);
}
if (!binancePreflight.includes("'MASTER_REQUIRED'") ||
    !binancePreflight.includes('requireCurrentMaster') ||
    !binancePreflight.includes("'MASTER_LEASE_REQUIRED'") ||
    !binancePreflight.includes('role-device:master')) {
  fail('api/binance-entry-preflight.js HTTP handler must require the registered leased MASTER');
}
if (!binancePreflight.includes('READ_ONLY_PREFLIGHT') || !binancePreflight.includes('writeAttempted: false')) {
  fail('entry preflight must explicitly remain read-only');
}
if (!binancePreflight.includes('ENTRY_PREFLIGHT_HTTP_RATE_LIMIT_PER_MINUTE = 6') ||
    !binancePreflight.includes('entryPreflightHttpRateAllowed') ||
    !binancePreflight.includes("'ENTRY_PREFLIGHT_HTTP_RATE_LIMIT'") ||
    !binancePreflight.includes("res.setHeader('Retry-After'")) {
  fail('entry preflight HTTP endpoint must rate-limit leased MASTER requests before contacting Binance');
}

const runtimeSnapshotApi = fs.readFileSync('api/binance-runtime-snapshot.js','utf8');
for (const required of ['/fapi/v3/positionRisk','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders',"MASTER_LEASE_REQUIRED","writeAttempted:false"]) {
  if (!runtimeSnapshotApi.includes(required)) fail(`runtime snapshot invariant missing: ${required}`);
}
for (const forbidden of ['/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v1/batchOrders']) {
  if (runtimeSnapshotApi.includes(forbidden)) fail(`runtime snapshot must stay read-only: ${forbidden}`);
}
if (!runtimeSnapshotApi.includes('BINANCE_RUNTIME_SNAPSHOT_RATE_LIMIT_PER_MINUTE = 12') ||
    !runtimeSnapshotApi.includes('runtimeSnapshotRateAllowed') ||
    !runtimeSnapshotApi.includes("'BINANCE_RUNTIME_SNAPSHOT_RATE_LIMIT'") ||
    !runtimeSnapshotApi.includes("res.setHeader('Retry-After'")) {
  fail('runtime snapshot must rate-limit leased MASTER reads before contacting Binance');
}
const userStreamSeed = fs.readFileSync('lib/user-stream-seed.mjs','utf8');
for (const required of ['RECONCILIATION_REQUIRED_AFTER_SEED','standardOrders','algoOrders','positions']) {
  if (!userStreamSeed.includes(required)) fail(`user-stream seed invariant missing: ${required}`);
}

const binanceOrderTest = fs.readFileSync('api/binance-order-test.js','utf8');
for (const required of ["/fapi/v1/order/test","BINANCE_TEST_ORDER_ONLY","matchingEngineSubmitted:false","tradingWriteAttempted:false","TEST_MUST_BE_REDUCE_ONLY","ONLY_ONE_WAY_SUPPORTED"]) {
  if (!binanceOrderTest.includes(required)) fail(`protective Binance test-order invariant missing: ${required}`);
}
if (binanceOrderTest.includes("TEST_ORDER_PATH='/fapi/v1/order'") ||
    binanceOrderTest.includes('TEST_ORDER_PATH="/fapi/v1/order"') ||
    binanceOrderTest.includes('/fapi/v1/algoOrder')) {
  fail('protective order validation endpoint must never target a live standard or conditional order path');
}
if (!binanceOrderTest.includes('BINANCE_ORDER_TEST_RATE_LIMIT_PER_MINUTE=6') ||
    !binanceOrderTest.includes('orderTestRateAllowed') ||
    !binanceOrderTest.includes("'BINANCE_ORDER_TEST_RATE_LIMIT'") ||
    !binanceOrderTest.includes("res.setHeader('Retry-After'")) {
  fail('protective Binance test-order endpoint must rate-limit leased MASTER requests before contacting Binance');
}

const userStreamSession = fs.readFileSync('api/binance-user-stream-session.js', 'utf8');
for (const required of [
  "/fapi/v1/listenKey",
  "binanceListenKey('POST')",
  "binanceListenKey('PUT')",
  "binanceListenKey('DELETE')",
  "'MASTER_LEASE_REQUIRED'",
  "sameOriginMutation(req)",
  "tradingWriteAttempted: false"
]) {
  if (!userStreamSession.includes(required)) fail(`user-stream session invariant missing: ${required}`);
}
for (const forbidden of ['/fapi/v1/order','/fapi/v1/algoOrder','BINANCE_API_SECRET']) {
  if (userStreamSession.includes(forbidden)) fail(`user-stream session must never access trading write/secret path: ${forbidden}`);
}
if (!userStreamSession.includes('USER_STREAM_MUTATION_RATE_LIMIT_PER_MINUTE = 12') ||
    !userStreamSession.includes('userStreamMutationRateAllowed') ||
    !userStreamSession.includes("'USER_STREAM_RATE_LIMIT'") ||
    !userStreamSession.includes("res.setHeader('Retry-After'")) {
  fail('Binance user-stream mutations must be rate-limited before Binance calls');
}

const masterRuntimeInventory = fs.readFileSync('lib/master-runtime-inventory.mjs', 'utf8');
for (const required of ['binancePositions','binanceOrders','openPositions','openOrders','userStream','TERMINAL_ALGO']) {
  if (!masterRuntimeInventory.includes(required)) fail(`MASTER runtime inventory projection missing: ${required}`);
}
if (!masterRuntimeInventory.includes("executionMode: mode") || !masterRuntimeInventory.includes("failClosed: state?.failClosed !== false")) {
  fail('MASTER runtime inventory must preserve execution mode and fail closed on unsafe stream state');
}

const userStreamState = fs.readFileSync('lib/user-stream-state.mjs', 'utf8');
for (const required of ['ORDER_TRADE_UPDATE','ACCOUNT_UPDATE','ALGO_UPDATE','listenKeyExpired','RECONCILIATION_REQUIRED_AFTER_CONNECT','STREAM_EVENT_OUT_OF_ORDER']) {
  if (!userStreamState.includes(required)) fail(`user-stream safety invariant missing: ${required}`);
}
if (!userStreamState.includes('needsReconciliation = true') ||
    !userStreamState.includes('state.failClosed = true')) {
  fail('Binance user-stream state machine must fail closed on reconnect/discontinuity');
}

const controllerRealCommand = fs.readFileSync('lib/controller-real-command.mjs','utf8');
for (const required of ['EXEC_CLOSE_POSITION','EXEC_CANCEL_ENTRY','PROTECTIVE_IOC','HEDGE_MODE_UNSUPPORTED','clientCommandId','CANCEL_TARGET_IS_REDUCE_ONLY','closeAll: true']) {
  if (!controllerRealCommand.includes(required)) fail(`iPhone real-close command invariant missing: ${required}`);
}
if (controllerRealCommand.includes("'EXEC_OPEN_POSITION'")) {
  fail('iPhone real-position control must never construct an entry command');
}
if (!index.includes('Positions réelles Binance') ||
    !index.includes('queueRealPositionClose') ||
    !index.includes('Ordres d’entrée réels en attente') ||
    !index.includes('queueRealEntryCancel') ||
    !index.includes('ANNULER ENTRÉE RÉELLE') ||
    !index.includes("fetch('/api/zenith-sync?action=command'") ||
    !index.includes('FERMER RÉEL · LIMIT IOC') ||
    !index.includes('attend la confirmation Binance')) {
  fail('iPhone controller must show real Binance positions and queue close-only commands without locally faking a fill');
}

const masterCommandDispatch = fs.readFileSync('lib/master-command-dispatch.mjs','utf8');
for (const required of ['masterExecutionEligible','EXEC_CLOSE_POSITION','EXEC_CANCEL_ENTRY','/api/binance-protective-execute','MASTER_COMMAND_NOT_IMPLEMENTED','CLOSE_ALL_REQUIRED','closeAll:true']) {
  if (!masterCommandDispatch.includes(required)) fail(`MASTER command dispatcher invariant missing: ${required}`);
}
if (masterCommandDispatch.includes('EXEC_OPEN_POSITION') && !masterCommandDispatch.includes("supported:false")) {
  fail('MASTER dispatcher must never route entry execution');
}

const binanceOrderWriter = fs.readFileSync('lib/binance-order-writer.mjs','utf8');
for (const required of [
  "queryOrderByClientId",
  "origClientOrderId",
  "disposition: 'WRITE_LOCKED'",
  "RECOVERED_AFTER_AMBIGUOUS_POST",
  "ORDER_RESULT_AMBIGUOUS",
  "cancelEntryOrderIdempotent",
  "CANCEL_TARGET_UNKNOWN",
  "CANCEL_RESULT_AMBIGUOUS",
  "method: 'DELETE'"
]) {
  if (!binanceOrderWriter.includes(required)) fail(`Binance idempotent writer invariant missing: ${required}`);
}
if ((binanceOrderWriter.match(/method: 'POST'/g)||[]).length !== 1) {
  fail('Binance order writer must have exactly one standard-order POST path');
}

const protectiveExecute = fs.readFileSync('api/binance-protective-execute.js','utf8');
for (const required of [
  "ZENITH_REAL_TRADING_ENABLED",
  "ZENITH_BINANCE_WRITE_ENABLED",
  "ZENITH_PAIRING_DISABLED",
  "'EXEC_CLOSE_POSITION'",
  "'EXEC_CANCEL_ENTRY'",
  "'BINANCE_WRITE_LOCKED'",
  "runtimeEntryOrder",
  "cancelEntryOrderIdempotent",
  "'CLOSE_QUANTITY_EXCEEDS_POSITION'",
  "'HEDGE_MODE_UNSUPPORTED'",
  "protectionOnlyMismatchTarget(report)",
  "runtimeDataHash",
  "placeStandardOrderIdempotent",
  "KEY_REAL_EXECUTION_ARMED",
  "REAL_EXECUTION_DEPLOYMENT_SHA_MISSING",
  "REAL_EXECUTION_ARM_MASTER_CHANGED",
  "REAL_EXECUTION_ARM_DEPLOYMENT_CHANGED",
  "protectiveModeReason"
]) {
  if (!protectiveExecute.includes(required)) fail(`protective execution gate missing: ${required}`);
}
if (protectiveExecute.includes('EXEC_OPEN_POSITION')) {
  fail('protective execution API must never open a new position');
}
if (!protectiveExecute.includes("'FULL_CLOSE_QUANTITY_REQUIRED'") ||
    !protectiveExecute.includes("priceMatch:String(req.body?.priceMatch||'OPPONENT')")) {
  fail('protective execution must be full-close only and pass audited adaptive priceMatch into the order planner');
}

const protectiveCloseState = fs.readFileSync('lib/protective-close-state.mjs','utf8');
for (const required of ["OPPONENT_5","OPPONENT_10","MARKET_LAST_RESORT","safeToRetry","inconsistentFilled","terminalSeen"]) {
  if (!protectiveCloseState.includes(required)) fail(`protective close state invariant missing: ${required}`);
}

const orderIntent = fs.readFileSync('lib/order-intent.mjs', 'utf8');
for (const required of ['deterministicClientOrderId','CLIENT_ORDER_ID_MAX_LENGTH = 36',"writeAllowed: false","reduceOnly: 'true'","priceMatch = 'OPPONENT'"]) {
  if (!orderIntent.includes(required)) fail(`order planning safety invariant missing: ${required}`);
}
if (!orderIntent.includes("ENTRY_PREFLIGHT_MAX_AGE_MS = 5000") ||
    !orderIntent.includes("'ENTRY_PREFLIGHT_STALE'") ||
    !orderIntent.includes("'POSITION_MODE_NOT_ONE_WAY'") ||
    !orderIntent.includes("'MARGIN_TYPE_NOT_ISOLATED'")) {
  fail('entry order planning must require a fresh one-way isolated risk snapshot');
}

const riskPolicy = fs.readFileSync('lib/risk-policy.mjs', 'utf8');
const entryProtectionGate = fs.readFileSync('lib/entry-protection-gate.mjs','utf8');
if (!entryProtectionGate.includes("import { REAL_RISK_LIMITS } from './risk-policy.mjs'") ||
    !entryProtectionGate.includes("/^zth-MAX-[A-Za-z0-9._:-]+$/.test(String(order?.clientAlgoId || ''))") ||
    !entryProtectionGate.includes('impliedLossUsd > REAL_RISK_LIMITS.maxLossUsd + 1e-8')) {
  fail('future real-entry protection gate must require a Zenith-managed emergency stop within the shared $400 cap');
}
if (!riskPolicy.includes('maxActivePositions: 3') ||
    !riskPolicy.includes('maxLeverage: 10') ||
    !riskPolicy.includes('maxMarginUsdt: 1000') ||
    !riskPolicy.includes('maxNotionalUsdt: 10000') ||
    !riskPolicy.includes('maxLossUsd: 400') ||
    !riskPolicy.includes('POSITION_MODE_HEDGE_UNSUPPORTED') ||
    !riskPolicy.includes('MARGIN_TYPE_NOT_ISOLATED')) {
  fail('real-entry risk policy must enforce server-side position, leverage, margin, notional, loss, position-mode and isolated-margin gates');
}

const realProtectionLevels = fs.readFileSync('lib/real-protection-levels.mjs','utf8');
for (const required of [
  'buildRealProtectionLevels',
  'validateMaxLossTrigger',
  'REAL_RISK_LIMITS.maxLossUsd',
  'grossPricePnlOnly: true'
]) {
  if (!realProtectionLevels.includes(required)) fail(`real protection level invariant missing: ${required}`);
}
const protectiveCommand = fs.readFileSync('lib/protective-command.mjs','utf8');
const protectiveUpdateIntent = fs.readFileSync('lib/protective-update-intent.mjs','utf8');
if (!protectiveUpdateIntent.includes("params.type='STOP'") ||
    !protectiveUpdateIntent.includes("params.timeInForce='GTC'") ||
    !protectiveUpdateIntent.includes("params.price=String(limit)") ||
    protectiveUpdateIntent.includes("params.priceMatch='OPPONENT'")) {
  fail('progressive gain protection must be STOP + explicit LIMIT GTC at the protected price, never OPPONENT');
}
if (!realProtectionLevels.includes('highestReachedProtectionStage') ||
    !realProtectionLevels.includes('observed + 1e-8 < armProfitUsd') ||
    !realProtectionLevels.includes('buildProgressiveProtectionLevel')) {
  fail('real progressive protection must arm only at/above ATTEINT and select the highest crossed stage');
}

if (!protectiveUpdateIntent.includes("workingType:'CONTRACT_PRICE'") ||
    !index.includes("@aggTrade") ||
    !index.includes("onMark(s,n(q.p))") ||
    !index.includes("/fapi/v1/ticker/price") ||
    index.includes("@markPrice")) {
  fail('ATTEINT monitoring and Binance protection triggers must stay aligned on CONTRACT_PRICE');
}

const protectiveUpdateExecute = fs.readFileSync('api/binance-protective-update-execute.js','utf8');
if (!protectiveUpdateExecute.includes('validateMaxLossTrigger({') ||
    !protectiveUpdateExecute.includes('hardMaxLossUsd:REAL_RISK_LIMITS.maxLossUsd') ||
    !protectiveUpdateExecute.includes('MAX_LOSS_TRIGGER_INVALID')) {
  fail('real MAX-LOSS updates must be revalidated server-side against the hard $400 loss cap');
}

if (!protectiveUpdateExecute.includes('impliedLossUsd<=REAL_RISK_LIMITS.maxLossUsd+1e-8') ||
    !index.includes('function masterHasSingleMaxLoss(position,orders,hardMaxLossUsd=400)') ||
    !index.includes('return impliedLossUsd<=cap+1e-8')) {
  fail('progressive protection must accept only an emergency MAX-LOSS that is itself within the hard $400 cap');
}

if (!index.includes('id="tMaxLoss" type="number" min="2" max="400" step="1"') ||
    !index.includes('requestedMaxLoss>=2&&requestedMaxLoss<=400') ||
    !index.includes('maxLoss:requestedMaxLoss') ||
    !index.includes('settings.maxLoss=Math.min(400,Math.max(2,n(settings.maxLoss,400)))')) {
  fail('controller MAX-LOSS settings must expose, validate and migrate to the same hard $400 real-trading cap');
}

if (!protectiveUpdateExecute.includes('NEW_PROGRESSIVE_PROTECTION_NOT_CONFIRMED') ||
    !protectiveUpdateExecute.includes('allowedIds.push(update.previousClientAlgoId)') ||
    !index.includes('if(maxLoss||progressive)') ||
    !index.includes("phase:'CANCEL_OLD',newClientAlgoId:clientId")) {
  fail('progressive protection replacement must confirm the new STOP+LIMIT before canceling the old protection');
}
if (!index.includes("import('/lib/real-protection-levels.mjs')") ||
    !index.includes('OBJECTIF AUTO') ||
    !index.includes('PERTE MAX AUTO')) {
  fail('iPhone controller must expose automatic real objective and max-loss levels from the shared calculator');
}

const binanceReconcile = fs.readFileSync('api/binance-reconcile.js', 'utf8');
for (const forbidden of ['/fapi/v1/order', '/fapi/v1/algoOrder', '/fapi/v1/batchOrders']) {
  if (binanceReconcile.includes(forbidden)) {
    fail(`api/binance-reconcile.js must remain read-only; forbidden endpoint found: ${forbidden}`);
  }
}
if (!binanceReconcile.includes("'MASTER_REQUIRED'") ||
    !binanceReconcile.includes('requireCurrentMaster') ||
    !binanceReconcile.includes("'MASTER_LEASE_REQUIRED'") ||
    !binanceReconcile.includes('role-device:master')) {
  fail('api/binance-reconcile.js must require the registered leased MASTER');
}
if (!binanceReconcile.includes("'MISMATCH'") || !binanceReconcile.includes('failClosed')) {
  fail('api/binance-reconcile.js must fail closed on Binance/runtime mismatches');
}
if (!binanceReconcile.includes('BINANCE_RECONCILE_RATE_LIMIT_PER_MINUTE = 30') ||
    !binanceReconcile.includes('reconciliationRateAllowed') ||
    !binanceReconcile.includes("'BINANCE_RECONCILE_RATE_LIMIT'") ||
    !binanceReconcile.includes("res.setHeader('Retry-After'")) {
  fail('Binance reconciliation must rate-limit leased MASTER reads before contacting Binance');
}
if (!binanceReconcile.includes('/fapi/v1/openAlgoOrders')) {
  fail('api/binance-reconcile.js must reconcile Binance algo TP/SL orders');
}
if (!binanceReconcile.includes('runtimeDataHash') || !binanceReconcile.includes('stableStringify(runtimeState?.data ?? null)')) {
  fail('Binance reconciliation must hash canonical runtime data separately from heartbeat timestamps');
}

if (!binanceReconcile.includes("import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs'") ||
    !binanceReconcile.includes('unsafeMaxLossProtections') ||
    !binanceReconcile.includes('impliedLossUsd > REAL_RISK_LIMITS.maxLossUsd + 1e-8')) {
  fail('Binance reconciliation must reject emergency MAX-LOSS orders whose implied loss exceeds the shared $400 hard cap');
}

if (!binanceReconcile.includes('ORPHAN_ZENITH_PROTECTIVE_ORDER') ||
    !binanceReconcile.includes('zenithManagedOrderId(order)') ||
    !binanceReconcile.includes('orphanZenithProtectiveOrders')) {
  fail('Binance reconciliation must fail closed on Zenith protective orders left open without a matching position');
}
if (!protectiveUpdateExecute.includes('EXEC_CLEAN_ORPHAN_PROTECTION') ||
    !protectiveUpdateExecute.includes("path:'/fapi/v3/positionRisk'") ||
    !protectiveUpdateExecute.includes('ORPHAN_CLEANUP_POSITION_NOT_FLAT') ||
    !protectiveUpdateExecute.includes('cancelReduceOnlyOrderIdempotent') ||
    !protectiveUpdateExecute.includes('cancelAlgoOrderIdempotent')) {
  fail('orphan cleanup must cancel only after direct Binance flat-position proof using idempotent cancel primitives');
}
if (!index.includes('orphanZenithCleanupOrders(q.report)') ||
    !index.includes('ORPHAN_CLEANUP_STREAM_NOT_CONFIRMED') ||
    !index.includes('COMPTE BINANCE INACCESSIBLE') ||
    index.includes('BINANCE HORS LIGNE')) {
  fail('MASTER must auto-clean confirmed Zenith orphans and UI must distinguish private account access from public Binance market data');
}

if (!protectiveCommand.includes('AMBIGUOUS_BINANCE_MAX_LOSS_PROTECTION') ||
    !protectiveCommand.includes("'ambiguousMaxLossProtections'") ||
    !index.includes('await publishMasterStreamState();') ||
    !index.includes('newClientId=await placeNew();') ||
    !index.includes('await cancelOld(newClientId)') ||
    !protectiveUpdateExecute.includes("phase==='CANCEL_OLD'&&update.protectionKind==='MAX_LOSS'")) {
  fail('place-first protection replacement must explicitly reconcile the old+new transition before retiring the old protection');
}

if (!index.includes('async function awaitMasterReconciliation(timeoutMs=5000)') ||
    !index.includes("'RECONCILIATION_BUSY_TIMEOUT'") ||
    !index.includes("const reconciled=await awaitMasterReconciliation();") ||
    !index.includes("throw new Error('RECONCILIATION_NOT_READY')")) {
  fail('critical MASTER mutations must serialize reconciliation and must not ACK a full close without reconciled stream readiness');
}

if (!index.includes("navigator.wakeLock.request('screen')") ||
    !index.includes('function masterWakeLockWanted()') ||
    !index.includes("mode==='RUNNING'||mode==='PAUSE_PENDING'") ||
    !index.includes("releaseMasterWakeLock();invalidateMasterStream('PAGE_HIDDEN')") ||
    !index.includes('ÉCRAN MASTER · ÉVEILLÉ')) {
  fail('iPad MASTER must request a screen wake lock only while active while preserving PAGE_HIDDEN fail-closed behavior');
}

const masterAutoProtection = fs.readFileSync('lib/master-auto-protection.mjs','utf8');
if (!masterAutoProtection.includes('STANDARD_REDUCE_ONLY_LIMIT_ALREADY_OPEN') ||
    !masterAutoProtection.includes('managedExitId(order?.clientOrderId)') ||
    !protectiveUpdateExecute.includes('samePurpose = !managedExitId(id)') ||
    !protectiveUpdateExecute.includes("o?.clientAlgoId||o?.clientOrderId||o?.orderId")) {
  fail('progressive protection must not be recreated over an unknown standard reduce-only LIMIT while normal zth-EXI targets remain allowed');
}

if (!userStreamSeed.includes('positionLifecycleAt:Number(p.updateTime||snapshot.observedAt||0)') ||
    !userStreamState.includes('positionLifecycleAt=sameCore') ||
    !masterRuntimeInventory.includes('lifecycleAt: Number(p.positionLifecycleAt || p.eventTime || 0)') ||
    !index.includes('pruneMasterAutoProtectionHighWater') ||
    !index.includes('position?.lifecycleAt??position?.positionLifecycleAt??position?.updateTime')) {
  fail('MASTER progressive high-water must be isolated to one stable Binance position lifecycle and pruned after flat positions');
}

if (!index.includes("String(o?.timeInForce||'').toUpperCase()==='GTC'") ||
    !index.includes('realNumberMatches(oq,qty)') ||
    !index.includes('realNumberMatches(px,trigger)') ||
    !index.includes("protectedSide&&(!o?.priceMatch||String(o.priceMatch).toUpperCase()==='NONE')") ||
    !index.includes("const lossSide=direction==='LONG'?trigger<entry:trigger>entry")) {
  fail('iPhone protection inventory must classify exit/progressive/MAX-LOSS orders with strict identity and price-side rules');
}

if (!protectiveUpdateExecute.includes("/^zth-[A-Za-z0-9._:-]+$/.test(clientAlgoId)") ||
    !binanceReconcile.includes('if (!zenithManagedOrderId(order)) continue;') ||
    !index.includes('if(!zenithManagedRealId(o?.clientAlgoId))return false;') ||
    !index.includes('const emergencyReady=Boolean(inv.managedMaxLoss)&&inv.maxLossConflict!==true') ||
    !index.includes('aucune protection MAX-LOSS Zenith unique et confirmée')) {
  fail('protective execution, reconciliation, MASTER and controller must require a unique Zenith-managed MAX-LOSS');
}

const sync = fs.readFileSync('api/zenith-sync.js', 'utf8');
const deviceSessionSource = fs.readFileSync('lib/device-session.mjs', 'utf8');
if (!sync.includes("import { REAL_RISK_LIMITS } from '../lib/risk-policy.mjs'") ||
    !sync.includes('function runtimeEmergencyProtection(runtimeState, symbol, direction, entryPrice, quantity, excludeClientAlgoId') ||
    !sync.includes("/^zth-MAX-[A-Za-z0-9._:-]+$/.test(String(order?.clientAlgoId || ''))") ||
    !sync.includes('impliedLossUsd <= REAL_RISK_LIMITS.maxLossUsd + 1e-8')) {
  fail('central execution ACK must independently require a Zenith-managed emergency stop within the shared $400 cap');
}
if (!sync.includes('sameOriginMutation(req)') || !sync.includes("'ORIGIN_FORBIDDEN'") ||
    !sync.includes('setDeviceSessionCookie(res, token)') || !sync.includes('deviceTokenCandidates(req')) {
  fail('zenith-sync must use secure device sessions and same-origin mutation protection');
}
const legacyMigrationStart = sync.indexOf('async function migrateLegacyBearerSession');
const legacyMigrationEnd = legacyMigrationStart >= 0 ? sync.indexOf('async function masterDeviceId()', legacyMigrationStart) : -1;
const legacyMigrationBlock = legacyMigrationStart >= 0 && legacyMigrationEnd > legacyMigrationStart
  ? sync.slice(legacyMigrationStart, legacyMigrationEnd)
  : '';
if (!deviceSessionSource.includes('allowBearer = false') ||
    !sync.includes("action === 'whoami' && req.method === 'GET'") ||
    !legacyMigrationBlock.includes('bearerToken(req)') ||
    (sync.match(/bearerToken\(req\)/g) || []).length !== 1 ||
    sync.includes('{ allowBearer: true }')) {
  fail('legacy Bearer must be accepted only inside the one-time rotating whoami migration; normal Zenith API auth must be cookie-only');
}
if (!sync.includes('function deviceSessionRemainingSeconds(device, now = Date.now())') ||
    !sync.includes('absoluteExpiresAt = createdAt + DEVICE_SESSION_MAX_AGE_SECONDS * 1000') ||
    !sync.includes("'DEVICE_SESSION_EXPIRED'") ||
    !sync.includes('setDeviceSessionCookie(res, device.sessionToken, session.remainingSeconds)')) {
  fail('Zenith device sessions must have an absolute server-enforced lifetime and matching cookie TTL');
}
if (!sync.includes('validDeviceId(deviceId)') ||
    !sync.includes('validDeviceId(newDeviceId)')) {
  fail('pairing and controller replacement must reject malformed or oversized device IDs');
}
for (const file of [
  'api/binance-read.js',
  'api/binance-reconcile.js',
  'api/binance-entry-preflight.js',
  'api/binance-entry-execute.js',
  'api/binance-protective-execute.js',
  'api/binance-protective-update-execute.js',
  'api/binance-runtime-snapshot.js',
  'api/binance-user-stream-session.js',
  'api/binance-order-test.js',
]) {
  const source=fs.readFileSync(file,'utf8');
  if (!source.includes('deviceTokenCandidates(req)')) fail(`${file} must accept the secure device session cookie`);
  if (source.includes('allowBearer: true')) fail(`${file} must never accept legacy Bearer migration credentials`);
  if (!source.includes('deviceSessionRecordActive(device)')) fail(`${file} must reject absolutely expired Zenith device sessions`);
}

const auditStart = sync.indexOf("if (action === 'audit' && req.method === 'GET')");
const auditEnd = auditStart >= 0 ? sync.indexOf("return send(res, 404, { ok: false, code: 'UNKNOWN_ACTION' })", auditStart) : -1;
const auditBlock = auditStart >= 0 && auditEnd > auditStart ? sync.slice(auditStart, auditEnd) : '';
if (!auditBlock ||
    !auditBlock.includes("requireDevice(req, res, ['master'])") ||
    !auditBlock.includes('hasMasterLease(device.deviceId)') ||
    !auditBlock.includes("'MASTER_LEASE_REQUIRED'")) {
  fail('Zenith audit log must be restricted to the currently leased MASTER');
}

if (!sync.includes("process.env.ZENITH_REAL_TRADING_ENABLED === '1'") ||
    !sync.includes("process.env.ZENITH_BINANCE_WRITE_ENABLED === '1'") ||
    !sync.includes("'BINANCE_WRITE_DISABLED'")) {
  fail('api/zenith-sync.js must keep both explicit real-trading and Binance-write environment locks');
}
if (!sync.includes("'SIMULATION_LOCKED'")) {
  fail('api/zenith-sync.js must expose SIMULATION_LOCKED when real trading is not armed');
}
if (!sync.includes("KEY_EMERGENCY_STOP")) {
  fail('api/zenith-sync.js must keep the persistent emergency-stop key');
}
if (!sync.includes("'EXECUTION_LOCKED'")) {
  fail('api/zenith-sync.js must reject future execution commands while locked');
}
if (!sync.includes("'MASTER_ACTIVATION_REQUIRED'") || !sync.includes("action === 'master-authorize'")) {
  fail('api/zenith-sync.js must require controller authorization before first MASTER lease');
}
if (!sync.includes("ZENITH_MASTER_ADMIN_CODE") ||
    !sync.includes("action === 'controller-replacement-authorize'") ||
    !sync.includes("action === 'controller-replacement-redeem'")) {
  fail('api/zenith-sync.js must keep secure controller replacement recovery');
}
const replacementAuthStart = sync.indexOf("if (action === 'controller-replacement-authorize' && req.method === 'POST')");
const replacementAuthEnd = replacementAuthStart >= 0
  ? sync.indexOf("if (action === 'controller-replacement-redeem' && req.method === 'POST')", replacementAuthStart)
  : -1;
const replacementAuthBlock = replacementAuthStart >= 0 && replacementAuthEnd > replacementAuthStart
  ? sync.slice(replacementAuthStart, replacementAuthEnd)
  : '';
if (!replacementAuthBlock ||
    !replacementAuthBlock.includes("requireDevice(req, res, ['master'])") ||
    !replacementAuthBlock.includes('hasMasterLease(device.deviceId)') ||
    !replacementAuthBlock.includes("'MASTER_LEASE_REQUIRED'")) {
  fail('controller replacement authorization must require the currently leased MASTER');
}
if (!sync.includes('CONTROLLER_REPLACEMENT_TTL_SECONDS = 10 * 60') ||
    !sync.includes("redis.call('DEL', KEYS[1])")) {
  fail('controller replacement code must remain short-lived and one-time use');
}
if (!sync.includes("'STALE_CONTROLLER_COMMAND'") || !sync.includes("'CONTROLLER_REPLACED'")) {
  fail('api/zenith-sync.js must reject/quarantine commands from a replaced controller');
}
if (!sync.includes("const KEY_MASTER_MODE") ||
    !sync.includes("action === 'master-pause'") ||
    !sync.includes("action === 'master-resume'")) {
  fail('api/zenith-sync.js must keep protected MASTER pause/resume');
}
if (!sync.includes("await setMasterMode('PAUSE_PENDING')") ||
    !sync.includes("'ACTIVE_POSITION'") ||
    !sync.includes("'OPEN_ORDER'") ||
    !sync.includes("'PENDING_COMMAND'") ||
    !sync.includes("'PROCESSING_COMMAND'") ||
    !sync.includes("'MASTER_RUNTIME_STALE'")) {
  fail('MASTER pause must block new entries immediately and remain pending until activity is safely drained');
}
if (!sync.includes("'MASTER_PAUSED'") ||
    !sync.includes("modeBeforeClaim === 'PAUSED'") ||
    !sync.includes("modeNow === 'PAUSED'")) {
  fail('MASTER command consumption must stop while paused, including a post-claim race check');
}
if (!sync.includes('freshCleanReconciliation') ||
    !sync.includes("'BINANCE_RECONCILIATION_REQUIRED'") ||
    !sync.includes('reconciliationRuntimeMatches') ||
    !sync.includes('report.runtimeDataHash || report.runtimeHash')) {
  fail('real MASTER resume must require fresh clean Binance reconciliation and tolerate heartbeat-only runtime timestamp changes');
}
if (!sync.includes("requireDevice(req, res, ['controller', 'master'])")) {
  fail('MASTER pause/resume must be callable by both controller and MASTER');
}
if (!sync.includes("'PAUSE_PENDING'") ||
    !sync.includes("action === 'master-pause-cancel'") ||
    !sync.includes("'MASTER_PAUSE_QUEUED'") ||
    !sync.includes("'MASTER_PAUSE_COMPLETED'")) {
  fail('MASTER must support queued pause after active positions close');
}
if (!sync.includes('PAUSE_PENDING_ALLOWED_COMMANDS') ||
    !sync.includes("'MASTER_PAUSE_PENDING_UNSAFE_COMMAND'")) {
  fail('queued pause must block new entry commands while allowing explicit close/protection commands');
}
if (!index.includes('masterCancelPauseBtn') ||
    !index.includes("controllerMasterAction('master-pause-cancel')")) {
  fail('iPhone controller UI must allow cancelling a queued MASTER pause');
}
if (!index.includes('masterPauseBtn') ||
    !index.includes('masterResumeBtn') ||
    !index.includes("controllerMasterAction('master-pause')") ||
    !index.includes("controllerMasterAction('master-resume')")) {
  fail('iPhone controller UI must expose protected MASTER pause/resume controls');
}

const masterAdmin = fs.readFileSync('master-admin.html', 'utf8');
if (!masterAdmin.includes('cancelPauseBtn') ||
    !masterAdmin.includes("setMasterMode('master-pause-cancel')")) {
  fail('iPad MASTER admin UI must allow cancelling a queued pause');
}

if (!sync.includes('KEY_MASTER_CONFIG_ACK') ||
    !sync.includes('KEY_MASTER_HEARTBEAT') ||
    !sync.includes("action === 'master-config-status'") ||
    !sync.includes("action === 'master-config-ack'") ||
    !sync.includes("'MASTER_CONFIG_OUT_OF_SYNC'") ||
    !sync.includes("'MASTER_CONFIG_APPLY_DEFERRED'")) {
  fail('MASTER must heartbeat, apply central revisions, acknowledge them, and fail closed on desynchronization');
}

const masterStandby = fs.readFileSync('master-standby.html', 'utf8');
if (!masterStandby.includes("api('master-heartbeat','POST'") ||
    !masterStandby.includes("api('master-config-status'") ||
    !masterStandby.includes("api('master-config-ack','POST'") ||
    !masterStandby.includes('CONTROLLER_STATE_HASH_MISMATCH')) {
  fail('MASTER standby page must verify, apply, and acknowledge controller revisions');
}
if (!index.includes('masterAppliedRevision') ||
    !index.includes('MASTER DÉSYNCHRONISÉ') ||
    !index.includes("stableStringify(remoteState?.data||{})===stableStringify(payload)")) {
  fail('iPhone must show MASTER applied revision and avoid no-op controller revisions');
}

if (!sync.includes('stableStringify') ||
    !sync.includes('MASTER_RUNTIME_UNAVAILABLE') ||
    !sync.includes('RUNTIME_STATE_INVALID')) {
  fail('MASTER synchronization must use canonical hashes and validated runtime snapshots');
}
if (!index.includes("role==='master'") ||
    !index.includes("masterRuntimeApi('master-heartbeat','POST'") ||
    !index.includes("masterRuntimeApi('state','POST'") ||
    !index.includes("masterRuntimeApi('master-config-status'") ||
    !index.includes("masterRuntimeApi('master-config-ack','POST'") ||
    !index.includes('masterLocalEntryAllowed()') ||
    !index.includes('CONTROLLER_STATE_HASH_MISMATCH')) {
  fail('iPad MASTER engine must heartbeat, publish runtime, apply revisions and block unsafe local entries');
}
if (!index.includes('masterExecutionCycle') ||
    !index.includes("masterRuntimeApi('command-next','POST'") ||
    !index.includes("masterCommandDisposition('command-ack'") ||
    !index.includes("masterCommandDisposition('command-requeue'") ||
    !index.includes("masterCommandDisposition('command-fail'") ||
    !index.includes("fetch('/api/binance-protective-execute'") ||
    !index.includes('evaluateFullProtectiveClose') ||
    !index.includes('PROTECTIVE_CLOSE_ATTEMPTS') ||
    !index.includes('MARKET_CLOSE_NOT_CONFIRMED') ||
    !index.includes("setInterval(masterExecutionCycle,750)")) {
  fail('iPad MASTER must confirm protective closes from live inventory, escalate LIMIT-first, and never ACK on dispatch alone');
}
if (!sync.includes('deferReason') || !sync.includes('requestedDelayMs') || !sync.includes('Math.min(30000')) {
  fail('MASTER command requeue must support bounded retry backoff without extending command expiry');
}

if (!index.includes("wss://fstream.binance.com/ws/") ||
    index.includes("wss://fstream.binance.com/private/ws/") ||
    !index.includes("import('/lib/user-stream-state.mjs')") ||
    !index.includes("import('/lib/master-runtime-inventory.mjs')") ||
    !index.includes("import('/lib/user-stream-seed.mjs')") ||
    !index.includes("fetch('/api/binance-runtime-snapshot'") ||
    !index.includes('STREAM_SEED_BUFFER_OVERFLOW') ||
    !index.includes("masterUserStreamApi('start','POST')") ||
    !index.includes("masterUserStreamApi('keepalive','POST')") ||
    !index.includes("reconcileMasterUserStream") ||
    !index.includes("45*60*1000") ||
    !index.includes("23*60*60*1000") ||
    !index.includes('reconcileDebounceTimer') ||
    !index.includes('reconcileInterval') ||
    !index.includes("masterUserStream.reconcileInterval=setInterval(()=>reconcileMasterUserStream(),15000)")) {
  fail('iPad MASTER must maintain the official Binance private user stream with independent keepalive, reconnect and REST reconciliation timers');
}
if (!index.includes("invalidateMasterStream('PAGE_HIDDEN')") ||
    !index.includes("STREAM_EVENT_OUT_OF_ORDER") ||
    !index.includes("LISTEN_KEY_EXPIRED") ||
    !index.includes("STREAM_INVENTORY_CHANGED")) {
  fail('MASTER user stream must fail closed on backgrounding, expiry, ordering gaps and inventory changes');
}

if (!index.includes('applyMasterReadOnlyPolicy') ||
    !index.includes('IPAD MASTER LECTURE SEULE') ||
    !index.includes('MASTER_APPLIED_CONFIG_HASH_MISMATCH') ||
    !index.includes('MASTER_LOCAL_CONFIG_DRIFT_ACTIVE') ||
    !index.includes("stableStringify(controllerCloudStatePayload())")) {
  fail('iPad MASTER must be read-only and detect local configuration drift before allowing new entries');
}
if (!masterStandby.includes('stableStringify(state.data)')) {
  fail('MASTER standby must verify controller state with the canonical hash');
}

if (sync.includes('claimOrVerifyRoleDevice') ||
    !sync.includes('async function claimRoleDevice') ||
    !sync.includes('async function verifyRoleDevice') ||
    !sync.includes('await claimRoleDevice(role, deviceId)') ||
    !sync.includes('await verifyRoleDevice(device.role, device.deviceId)')) {
  fail('authenticated devices must never auto-claim a missing controller or MASTER role');
}
if (!sync.includes('MASTER_ADMIN_FAILURE_LIMIT = 5') ||
    !sync.includes('MASTER_ADMIN_LOCK_SECONDS = 15 * 60') ||
    !sync.includes('verifyMasterAdminCode') ||
    !sync.includes("'MASTER_ADMIN_LOCKED'")) {
  fail('MASTER admin code must be protected against repeated guessing');
}
if (!sync.includes("'PAIRING_MUST_BE_DISABLED'") || !sync.includes('pairingDisabled: PAIRING_DISABLED')) {
  fail('real execution must remain locked while device pairing is open');
}
if (!sync.includes("action === 'emergency-stop-clear'") ||
    !sync.includes("'MASTER_MUST_BE_PAUSED'") ||
    !sync.includes("'EMERGENCY_STOP_CLEARED'") ||
    !sync.includes("blockers.push('EMERGENCY_STOP_ACTIVE')")) {
  fail('PANIC reset must require ADMIN, paused MASTER, clean re-arm checks and block real resume while still active');
}
if (!sync.includes("await setMasterMode('PAUSE_PENDING')") ||
    !sync.includes("kind: 'EMERGENCY_STOP_SET'")) {
  fail('PANIC STOP must immediately block new entries while preserving the PAUSE_PENDING protective drain path');
}
if (!index.includes('panicStopBtn') || !index.includes('panicClearBtn') ||
    !index.includes('controllerPanicStop') || !index.includes('controllerClearPanic')) {
  fail('iPhone controller must expose PANIC STOP and protected re-arm controls');
}
if (!masterAdmin.includes('panicBtn') || !masterAdmin.includes('clearPanicBtn') ||
    !masterAdmin.includes('panicStop') || !masterAdmin.includes('clearPanic')) {
  fail('MASTER admin must expose PANIC STOP and protected re-arm controls');
}
if (!index.includes('escapeHtml') || !index.includes('escapeHtml(h.reason)') || !index.includes('escapeHtml(p.symbol)')) {
  fail('dynamic trading UI strings must be HTML-escaped');
}
if (!index.includes('data-refresh="${escapeHtml(p.symbol)}"') ||
    !index.includes('data-close="${escapeHtml(p.symbol)}"')) {
  fail('dynamic position symbols must be escaped inside HTML data attributes');
}

const vercelConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const securityHeaders = JSON.stringify(vercelConfig.headers || []);
for (const requiredHeader of ['Content-Security-Policy','X-Content-Type-Options','X-Frame-Options','Referrer-Policy','Permissions-Policy']) {
  if (!securityHeaders.includes(requiredHeader)) fail(`vercel.json missing security header: ${requiredHeader}`);
}
if (!securityHeaders.includes("frame-ancestors 'none'") || !securityHeaders.includes("connect-src 'self' https://fapi.binance.com wss://fstream.binance.com")) {
  fail('Content Security Policy must prevent framing and restrict outbound connections');
}
if (!sync.includes('COMMAND_MAX_AGE_MS = 2 * 60 * 1000') ||
    !sync.includes('COMMAND_QUEUE_MAX = 100') ||
    !sync.includes('COMMAND_PAYLOAD_MAX_BYTES = 16 * 1024') ||
    !sync.includes('COMMAND_RAW_MAX_BYTES = 64 * 1024') ||
    !sync.includes("'COMMAND_RAW_TOO_LARGE'") ||
    !sync.includes('commandRawStatus(req.body?.raw)') ||
    !sync.includes('DEAD_LETTER_MAX = 500')) {
  fail('command queue must bound age, depth, payloads, MASTER raw command strings and dead-letter retention');
}
if (!sync.includes('ALLOWED_COMMAND_TYPES') ||
    !sync.includes("'COMMAND_TYPE_NOT_ALLOWED'") ||
    sync.includes("'EXEC_OPEN_POSITION'")) {
  fail('command queue must use a protective-only allowlist until real entry execution is audited');
}
if (!sync.includes("'COMMAND_EXPIRED'") ||
    !sync.includes("'COMMAND_QUEUE_FULL'") ||
    !sync.includes("'__DEFERRED__:'") ||
    !sync.includes('deferredCommandPayload') ||
    !sync.includes('deferClaimedCommand') ||
    !sync.includes('executionDeferred') ||
    !sync.includes('modeBeforeClaim') ||
    !sync.includes('modeNow') ||
    !sync.includes('executionGate(command.type, halted)') ||
    !sync.includes('realExecutionReadiness') ||
    !sync.includes('freshConsistentReconciliation') ||
    !sync.includes("'EXECUTION_NOT_READY'")) {
  fail('MASTER must revalidate age, mode, execution lock, private stream readiness and fresh reconciliation before any EXEC command');
}
if (!sync.includes('KEY_REAL_EXECUTION_ARMED') ||
    !sync.includes("action === 'real-execution-arm'") ||
    !sync.includes("'REAL_EXECUTION_ARM_BLOCKED'") ||
    !sync.includes('DEPLOYMENT_SHA') ||
    !sync.includes("'REAL_EXECUTION_DEPLOYMENT_SHA_MISSING'") ||
    !sync.includes("'REAL_EXECUTION_ARM_DEPLOYMENT_CHANGED'")) {
  fail('real execution must require an explicit admin arm bound to the current MASTER and deployment');
}
if (!sync.includes("BINANCE_API_RESTRICTIONS_PATH = '/sapi/v1/account/apiRestrictions'") ||
    !sync.includes('fetchBinanceApiPermissions') ||
    !sync.includes('binanceApiPermissionBlockers') ||
    !sync.includes("'BINANCE_API_IP_RESTRICTION_REQUIRED'") ||
    !sync.includes("'BINANCE_API_WITHDRAWALS_MUST_BE_DISABLED'") ||
    !sync.includes("'BINANCE_API_FUTURES_REQUIRED'")) {
  fail('real execution arm must verify IP-restricted safe Binance API permissions before arming');
}
if (!index.includes("masterRuntimeState.realExecutionArmed===true?'REAL':'SIMULATION'") ||
    !index.includes("hb.q.realExecutionArmed===true")) {
  fail('iPad MASTER must publish REAL runtime only after server-side real-execution arm');
}
if (!masterAdmin.includes('armRealBtn') || !masterAdmin.includes('armRealExecution')) {
  fail('MASTER admin must expose guarded real-execution arming only when the real env is present');
}

if (!sync.includes("'MASTER_RUNTIME_NOT_REAL'") ||
    !sync.includes("'USER_STREAM_NOT_READY'") ||
    !sync.includes("'USER_STREAM_FAIL_CLOSED'") ||
    !sync.includes("'USER_STREAM_RECONCILIATION_REQUIRED'") ||
    !sync.includes('protectionOnlyMismatchTarget(report)') ||
    !sync.includes('protectiveRepairTarget(type, req.body?.payload)') ||
    !sync.includes('protectiveRepairTarget(command.type, command.payload)')) {
  fail('real execution must fail closed unless runtime/stream are ready and reconciliation is CLEAN_REAL, except the exact missing-protection repair target');
}
if (!sync.includes('pushDeadLetter') || !sync.includes("redis(['LTRIM', KEY_DEAD")) {
  fail('dead-letter queue must be bounded');
}
if (!sync.includes('execClosePayloadStatus') ||
    !sync.includes("'CLOSE_ALL_REQUIRED'") ||
    !sync.includes("'COMMAND_PAYLOAD_INVALID'") ||
    !sync.includes("action === 'command-fail'") ||
    !sync.includes("'EXECUTION_ACK_NOT_CONFIRMED'") ||
    !sync.includes('runtimeClosePositionQuantity') ||
    !sync.includes('freshConsistentReconciliation(device.deviceId)')) {
  fail('EXEC_CLOSE_POSITION must be full-close only and require fresh reconciled zero-position proof before ACK');
}

const replaceController = fs.readFileSync('replace-controller.html', 'utf8');
if (!replaceController.includes('restoreCentralState') ||
    !replaceController.includes('zenith_controller_revision_v1')) {
  fail('replace-controller.html must restore central configuration and revision before opening Zenith');
}

const realEntryExecuteRate = fs.readFileSync('api/binance-entry-execute.js','utf8');
if (!realEntryExecuteRate.includes('ENTRY_EXECUTION_RATE_LIMIT_PER_MINUTE=6') ||
    !realEntryExecuteRate.includes('entryExecutionRateAllowed') ||
    !realEntryExecuteRate.includes("'ENTRY_EXECUTION_RATE_LIMIT'") ||
    !realEntryExecuteRate.includes("res.setHeader('Retry-After'")) {
  fail('real entry execution must be rate-limited before Binance without affecting protective exits');
}

const authenticatedApiFiles = fs.readdirSync('api')
  .filter(name => name.endsWith('.js'))
  .map(name => 'api/' + name);
for (const file of authenticatedApiFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('deviceTokenCandidates')) continue;
  const verifiesRoleOwner =
    source.includes('role-device:controller') ||
    source.includes('role-device:master') ||
    source.includes('KEY_MASTER_DEVICE');
  if (!verifiesRoleOwner) {
    fail(`${file} accepts Zenith device tokens without revalidating current role ownership`);
  }
}

const requireDeviceStart = sync.indexOf('async function requireDevice');
const requireDeviceEnd = sync.indexOf('async function masterDeviceId', requireDeviceStart);
const requireDeviceBlock = requireDeviceStart >= 0 && requireDeviceEnd > requireDeviceStart
  ? sync.slice(requireDeviceStart, requireDeviceEnd)
  : '';
if (!requireDeviceBlock.includes("code: 'ROLE_DEVICE_CONFLICT'") ||
    !requireDeviceBlock.includes('clearDeviceSessionCookie(res)')) {
  fail('role ownership conflicts must clear the stale secure device cookie');
}

const syncTrustedIp = fs.readFileSync('api/zenith-sync.js','utf8');
if (!syncTrustedIp.includes("headers['x-vercel-forwarded-for']") ||
    !syncTrustedIp.includes("process.env.VERCEL === '1'") ||
    !syncTrustedIp.includes("headers['x-forwarded-for']")) {
  fail('Zenith auth rate limits must prefer Vercel trusted forwarded IP while retaining cloud fallback');
}

const boundedAuthSource = fs.readFileSync('api/zenith-sync.js','utf8');
if (!boundedAuthSource.includes('AUTH_SECRET_INPUT_MAX_CHARS = 256') ||
    !boundedAuthSource.includes('REPLACEMENT_CODE_INPUT_MAX_CHARS = 64') ||
    !boundedAuthSource.includes("'PAIRING_CODE_INPUT_TOO_LARGE'") ||
    !boundedAuthSource.includes("'MASTER_ADMIN_CODE_INPUT_TOO_LARGE'") ||
    !boundedAuthSource.includes("'CONTROLLER_REPLACEMENT_CODE_INPUT_TOO_LARGE'")) {
  fail('pairing, admin and controller replacement secret inputs must remain explicitly bounded');
}

const safetyWorkflowRunner = fs.readFileSync('.github/workflows/zenith-safety.yml','utf8');
if (!safetyWorkflowRunner.includes('runs-on: ubuntu-24.04') ||
    safetyWorkflowRunner.includes('runs-on: ubuntu-latest')) {
  fail('Zenith safety CI runner must stay pinned to Ubuntu 24.04');
}

const syncAdminSecretPolicy = fs.readFileSync('api/zenith-sync.js','utf8');
for (const required of [
  'MASTER_ADMIN_CODE_TOO_WEAK',
  'MASTER_ADMIN_CODE_REUSED',
  'adminSecretPolicyBlockers',
  'adminSecretPolicyVersion:1'
]) {
  if (!syncAdminSecretPolicy.includes(required)) fail(`MASTER admin secret policy invariant missing: ${required}`);
}

const legacyBearerRotation = fs.readFileSync('api/zenith-sync.js','utf8');
for (const required of [
  'migrateLegacyBearerSession',
  'LEGACY_SESSION_MIGRATION_CONFLICT',
  "redis.call('DEL', KEYS[1])",
  "crypto.randomBytes(32).toString('base64url')"
]) {
  if (!legacyBearerRotation.includes(required)) fail(`legacy Bearer rotation invariant missing: ${required}`);
}

if (failed) process.exit(1);
console.log('Zenith safety checks passed.');
