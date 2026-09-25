import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');

function block(start,end){
  const a=html.indexOf(start);
  const b=html.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start+' block missing');
  return html.slice(a,b);
}

test('global protections checkbox only folds the table and never disables protection stages',()=>{
  const visibility=block('function applyProtectionVisibility()','function syncProtectionsToTarget');
  assert.match(visibility,/settings\.showProtections/);
  assert.match(visibility,/details\.hidden=!cb\.checked/);
  assert.doesNotMatch(visibility,/protectionStages|\.enabled|tProtect|protectionDraft/);

  const listener=html.match(/\$\('showProtectionsToggle'\)\.addEventListener\('change',[^\n]+/);
  assert.ok(listener,'showProtectionsToggle change handler missing');
  assert.match(listener[0],/settings\.showProtections=\$\('showProtectionsToggle'\)\.checked/);
  assert.match(listener[0],/applyProtectionVisibility\(\)/);
  assert.doesNotMatch(listener[0],/protectionStages|\.enabled|tProtect|protectionDraft/);
});

test('individual protection checkboxes remain the only UI switches for protection enabled state',()=>{
  const editor=block('function renderProtectionEditor','function applyProtectionVisibility');
  assert.match(editor,/id="tProtect\$\{i\+1\}"/);
  assert.match(editor,/\$\{st\.enabled\?'checked':''\}/);

  const draft=block('function protectionDraft()','function protectionValidationError');
  assert.match(draft,/enabled:\$\(\`tProtect\$\{i\+1\}\`\)\?\.checked!==false/);
});
