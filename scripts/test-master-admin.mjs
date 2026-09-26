import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('master-admin.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/verifyMaster\(\);\s*$/, '');
function page(role, mode = 'RUNNING') {
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', hidden: false, disabled: true, textContent: '', addEventListener() {},
  }]));
  const posts = [];
  const state = { role, mode, offline: false, lease: true, engineDisabled: false };
  const context = vm.createContext({
    document: { hidden: false, getElementById: id => elements[id], addEventListener() {} },
    localStorage: {
      getItem: () => 'paired-test-token',
      setItem: () => assert.fail('ADMIN code must not be persisted'),
      removeItem() {},
    },
    setInterval() {},
    confirm: () => true,
    fetch: async (url, init) => {
      if (state.offline) throw new Error('offline');
      const action = new URL(url, 'https://zenith.test').searchParams.get('action');
      if (init.method === 'POST') {
        posts.push({ action, body: JSON.parse(init.body) });
        if (action === 'master-pause') state.mode = 'PAUSE_PENDING';
        if (action === 'master-pause-cancel') state.mode = 'RUNNING';
        if (action === 'engine-reenable') state.engineDisabled = false;
        return { ok: true, json: async () => ({ ok: true, masterMode: state.mode, engineReenabled: action === 'engine-reenable' }) };
      }
      return { ok: true, json: async () => action === 'whoami'
        ? { ok: true, device: { role: state.role } }
        : { ok: true, masterMode: state.mode, masterLeaseActive: state.lease, masterRegistered: state.lease, engineDisabled: state.engineDisabled, emergencyStopActive: true, pendingCommands: 0, processingCommands: 0 } };
    },
  });
  vm.runInContext(script, context);
  return { elements, posts, state, run: code => vm.runInContext(code, context) };
}
for (const role of ['controller', 'master']) {
  test(`${role}: ADMIN pause queues and can be cancelled`, async () => {
    const p = page(role);
    await p.run('verifyMaster()');
    assert.equal(p.elements.pauseBtn.disabled, false);
    await p.run("setMasterMode('master-pause')");
    assert.equal(p.posts.length, 0, 'code required');
    p.elements.adminCode.value = 'test-admin';
    await p.run("setMasterMode('master-pause')");
    assert.equal(p.posts[0].body.adminCode, 'test-admin');
    assert.equal(p.elements.adminCode.value, '');
    assert.equal(p.elements.cancelPauseBtn.hidden, false);
    assert.equal(p.elements.cancelPauseBtn.disabled, false);
    assert.equal(p.elements.resumeBtn.disabled, true);
    assert.equal(p.elements.pauseBtn.disabled, true);
    p.elements.adminCode.value = 'test-admin';
    await p.run("setMasterMode('master-pause-cancel')");
    assert.equal(p.elements.cancelPauseBtn.hidden, true);
    assert.equal(p.state.mode, 'RUNNING');
  });
}
test('unverified role cannot send critical actions', async () => {
  const p = page('unknown');
  await p.run('verifyMaster()');
  p.elements.adminCode.value = 'test-admin';
  await p.run("setMasterMode('master-pause')");
  assert.equal(p.posts.length, 0);
  assert.equal(p.elements.pauseBtn.disabled, true);
});
test('connection failure disables actions instead of showing a verified state', async () => {
  const p = page('controller');
  await p.run('verifyMaster()');
  p.state.offline = true;
  await p.run('verifyMaster()');
  for (const id of ['pauseBtn', 'cancelPauseBtn', 'resumeBtn']) assert.equal(p.elements[id].disabled, true);
});
test('resume still requires an active MASTER lease', async () => {
  const p = page('controller', 'PAUSED'); p.state.lease = false;
  await p.run('verifyMaster()');
  assert.equal(p.elements.resumeBtn.disabled, true);
});

test('generic controller recovery remains separate from MASTER JavaScript actions', () => {
  assert.match(html,/id="recoverControllerBtn"/);
  assert.match(html,/action="\/replace-controller\.html"/);
  assert.match(html,/Reprendre le contrôle sur cet appareil/);
  assert.doesNotMatch(html,/Autoriser le remplacement de l’iPhone/);
  assert.doesNotMatch(script,/authorizeReplacement\(/);
  assert.doesNotMatch(script,/controller-replacement-authorize/);
});


test('controller revoke control lives in MASTER administration and remains ADMIN protected', async () => {
  const p = page('controller', 'PAUSED');
  await p.run('verifyMaster()');
  assert.equal(p.elements.revokeBtn.hidden, false);
  p.elements.adminCode.value = '';
  await p.run('revokeMaster()');
  assert.equal(p.posts.length, 0, 'ADMIN code required');
  p.elements.adminCode.value = 'test-admin';
  await p.run('revokeMaster()');
  assert.equal(p.posts.at(-1).action, 'master-revoke');
  assert.equal(p.posts.at(-1).body.adminCode, 'test-admin');
  assert.equal(p.elements.adminCode.value, '');
});

test('MASTER role cannot use controller-only revoke control', async () => {
  const p = page('master', 'PAUSED');
  await p.run('verifyMaster()');
  assert.equal(p.elements.revokeBtn.hidden, true);
  p.elements.adminCode.value = 'test-admin';
  await p.run('revokeMaster()');
  assert.equal(p.posts.length, 0);
});

test('controller can explicitly re-enable Render only from safe paused state', async () => {
  const p = page('controller', 'PAUSED');
  p.state.lease = false;
  p.state.engineDisabled = true;
  await p.run('verifyMaster()');
  assert.equal(p.elements.engineReenableBtn.hidden, false);
  assert.equal(p.elements.engineReenableBtn.disabled, false);
  p.elements.adminCode.value = 'test-admin';
  await p.run('reenableEngine()');
  assert.equal(p.posts.at(-1).action, 'engine-reenable');
  assert.equal(p.posts.at(-1).body.adminCode, 'test-admin');
  assert.equal(p.elements.adminCode.value, '');
  assert.equal(p.state.engineDisabled, false);
});

test('Render re-enable button stays unavailable when MASTER lease is active', async () => {
  const p = page('controller', 'PAUSED');
  p.state.lease = true;
  p.state.engineDisabled = true;
  await p.run('verifyMaster()');
  assert.equal(p.elements.engineReenableBtn.hidden, false);
  assert.equal(p.elements.engineReenableBtn.disabled, true);
});
