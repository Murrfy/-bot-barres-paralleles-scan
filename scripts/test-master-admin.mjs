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
  const state = { role, mode, offline: false, lease: true };
  const context = vm.createContext({
    document: { hidden: false, getElementById: id => elements[id], addEventListener() {} },
    localStorage: {
      getItem: () => 'paired-test-token',
      setItem: () => assert.fail('ADMIN code must not be persisted'),
      removeItem() {},
    },
    setInterval() {},
    fetch: async (url, init) => {
      if (state.offline) throw new Error('offline');
      const action = new URL(url, 'https://zenith.test').searchParams.get('action');
      if (init.method === 'POST') {
        posts.push({ action, body: JSON.parse(init.body) });
        if (action === 'master-pause') state.mode = 'PAUSE_PENDING';
        if (action === 'master-pause-cancel') state.mode = 'RUNNING';
        return { ok: true, json: async () => ({ ok: true, masterMode: state.mode }) };
      }
      return { ok: true, json: async () => action === 'whoami'
        ? { ok: true, device: { role: state.role } }
        : { ok: true, masterMode: state.mode, masterLeaseActive: state.lease } };
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
    assert.equal(p.elements.replaceBtn.hidden, role !== 'master');
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
  for (const id of ['pauseBtn', 'cancelPauseBtn', 'resumeBtn', 'replaceBtn']) assert.equal(p.elements[id].disabled, true);
});
test('resume requires an active lease; controller has no recovery action', async () => {
  const p = page('controller', 'PAUSED'); p.state.lease = false;
  await p.run('verifyMaster()');
  assert.equal(p.elements.resumeBtn.disabled, true);
  p.elements.adminCode.value = 'test-admin';
  await p.run('authorizeReplacement()');
  assert.equal(p.posts.length, 0);
});

test('MASTER without an active lease cannot authorize controller replacement', async () => {
  const p = page('master', 'PAUSED'); p.state.lease = false;
  await p.run('verifyMaster()');
  assert.equal(p.elements.replaceBtn.hidden, false);
  assert.equal(p.elements.replaceBtn.disabled, true);
  p.elements.adminCode.value = 'test-admin';
  await p.run('authorizeReplacement()');
  assert.equal(p.posts.length, 0);
});
