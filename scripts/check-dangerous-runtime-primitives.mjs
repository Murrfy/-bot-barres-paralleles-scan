import fs from 'node:fs';
import path from 'node:path';

const API_DIR = path.join(process.cwd(), 'api');
const files = fs.readdirSync(API_DIR)
  .filter(name => name.endsWith('.js'))
  .map(name => path.join('api', name));

const rules = [
  { name: 'child_process import', re: /(?:node:)?child_process/ },
  { name: 'eval()', re: /(^|[^\w])eval\s*\(/ },
  { name: 'new Function()', re: /new\s+Function\s*\(/ },
  { name: 'node:vm import', re: /(?:node:)?vm(?:['"`;]|\/)/ },
  { name: 'worker_threads import', re: /(?:node:)?worker_threads/ },
  { name: 'dynamic non-literal import', re: /import\s*\(\s*[^'"`]/ },
  { name: 'shell/process execution', re: /\b(?:exec|execFile|spawn|fork)\s*\(/ },
];

const failures = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const rule of rules) {
    if (rule.re.test(source)) failures.push({ file, rule: rule.name });
  }
}

if (failures.length) {
  console.error('Dangerous runtime primitive guard FAILED.');
  for (const failure of failures) {
    console.error('- ' + failure.file + ' — ' + failure.rule);
  }
  process.exit(1);
}

console.log('Dangerous runtime primitive guard passed for ' + files.length + ' API files.');
