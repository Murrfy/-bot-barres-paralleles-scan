import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('../server/zenith-engine-worker.mjs',import.meta.url),'utf8');

function block(startText,endText){
  const start=worker.indexOf(startText);
  const end=worker.indexOf(endText,start);
  assert.ok(start>=0&&end>start,`missing block ${startText}`);
  return worker.slice(start,end);
}

test('engine archives real Binance history autonomously without affecting trading gates',()=>{
  assert.match(worker,/const HISTORY_ARCHIVE_MS=6\*60\*60\*1000/);
  assert.match(worker,/let historyArchiveTimer=null/);

  const refresh=block('async function refreshRealHistoryArchive()','async function publicBinanceJson');
  assert.match(refresh,/binanceApi\('\/api\/binance-history'\)/);
  assert.match(refresh,/response\.ok&&data\?\.ok===true/);
  assert.match(refresh,/REAL_HISTORY_ARCHIVE_REFRESHED/);
  assert.match(refresh,/REAL_HISTORY_ARCHIVE_REFRESH_FAILED/);
  assert.doesNotMatch(refresh,/invalidateStream\(/);
  assert.doesNotMatch(refresh,/throw /);

  const main=block('async function main()','process.on(\'SIGTERM\'');
  assert.match(main,/void refreshRealHistoryArchive\(\)/);
  assert.match(main,/setInterval\(\(\)=>\{void refreshRealHistoryArchive\(\)\},HISTORY_ARCHIVE_MS\)/);

  const shutdown=block('async function shutdown(code=0)','async function main()');
  assert.match(shutdown,/if\(historyArchiveTimer\)clearInterval\(historyArchiveTimer\)/);
});
