import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const apiDir = path.join(process.cwd(), 'api');
const files = fs.readdirSync(apiDir).filter(name => name.endsWith('.js'));

test('public API error fields never expose raw internal exception messages or stacks', () => {
  const leaks = [];
  const rawErrorField = /error\s*:\s*(?:String\s*\(\s*)?e\?*\.(?:message|stack)/g;

  for (const file of files) {
    const full = path.join(apiDir, file);
    const source = fs.readFileSync(full, 'utf8');
    for (const match of source.matchAll(rawErrorField)) {
      const line = source.slice(0, match.index || 0).split('\n').length;
      leaks.push(file + ':' + line + ' -> ' + match[0]);
    }
  }

  assert.deepEqual(leaks, []);
});
