// Admin API of the workspace service: list, create, duplicate (with its projects) and delete workspaces.
// Spins the real server on a random port with a throwaway data directory.
//   node tests/admin-workspaces.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 18000 + Math.floor(Math.random() * 1000);
const dir = await mkdtemp(join(tmpdir(), 'carver-admin-'));
const server = spawn(process.execPath, ['server/workspace-server.mjs', String(port)], {
  env: { ...process.env, CARVER_ADMIN_SECRET: 'secret', CARVER_ADMIN_USER: 'rezak', CARVER_ADMIN_PASSWORD: 'carver', CARVER_WORKSPACE_DIR: dir, CARVER_PUBLIC_ORIGIN: 'https://example.test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${port}`;
const auth = 'Basic ' + Buffer.from('rezak:carver').toString('base64');
const admin = (path, init = {}) => fetch(base + path, { ...init, headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) } });

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/admin'); if (r.status === 401 || r.status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

try {
  await waitForServer();

  // Unauthenticated access is refused, the page itself renders.
  assert.equal((await fetch(base + '/admin')).status, 401);
  assert.equal((await fetch(base + '/admin/workspaces')).status, 401);
  const page = await admin('/admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Папка|Рабочие пространства/);

  // Empty list.
  let list = await (await admin('/admin/workspaces')).json();
  assert.deepEqual(list.totals, { workspaces: 0, projects: 0, locks: 0, bytes: 0 });

  // Create.
  const created = await (await admin('/admin/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Нейрокурс' }) })).json();
  assert.equal(created.name, 'Нейрокурс');
  assert.match(created.link, /^https:\/\/example\.test\/\?workspace=[\w-]+$/);

  // Put two projects into it through the normal (session) API.
  const token = created.link.split('workspace=')[1];
  const enter = await fetch(base + '/api/workspace/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(enter.status, 204);
  const cookie = enter.headers.get('set-cookie').split(';')[0];
  for (const id of ['p1', 'p2']) {
    const r = await fetch(`${base}/api/workspace/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ data: { id, name: id, words: [] }, revision: 0 }) });
    assert.equal(r.status, 200);
  }

  // Stats reflect the stored projects.
  list = await (await admin('/admin/workspaces')).json();
  assert.equal(list.totals.workspaces, 1);
  assert.equal(list.totals.projects, 2);
  assert.equal(list.workspaces[0].projects, 2);
  assert.equal(list.workspaces[0].name, 'Нейрокурс');
  assert.ok(list.workspaces[0].bytes > 0);
  assert.ok(list.workspaces[0].link.startsWith('https://example.test/?workspace='));

  // Duplicate: a new id and token, the same number of projects, independent ids.
  const copy = await (await admin(`/admin/workspaces/${created.id}/duplicate`, { method: 'POST' })).json();
  assert.notEqual(copy.id, created.id);
  assert.equal(copy.name, 'Нейрокурс (копия)');
  assert.equal(copy.projects, 2);
  assert.notEqual(copy.link, created.link);
  list = await (await admin('/admin/workspaces')).json();
  assert.equal(list.totals.workspaces, 2);
  assert.equal(list.totals.projects, 4);
  const names = list.workspaces.map((w) => w.name).sort();
  assert.deepEqual(names, ['Нейрокурс', 'Нейрокурс (копия)']);

  // The copy is a real workspace: its own link logs in and keeps separate projects with new ids.
  const copyToken = copy.link.split('workspace=')[1];
  const enterCopy = await fetch(base + '/api/workspace/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: copyToken }) });
  assert.equal(enterCopy.status, 204);
  const copyCookie = enterCopy.headers.get('set-cookie').split(';')[0];
  const copyWs = await (await fetch(base + '/api/workspace', { headers: { cookie: copyCookie } })).json();
  assert.equal(copyWs.projects.length, 2);
  const copyIds = copyWs.projects.map((p) => p.id);
  assert.equal(copyIds.includes('p1'), false, 'duplicate projects get fresh ids');
  assert.ok(copyWs.projects.every((p) => p.data.id === p.id && p.data.workspaceId === copy.id), 'project data is re-stamped');
  assert.equal(copyWs.projects.every((p) => p.revision >= 1), true);

  // Deleting the copy leaves the original untouched.
  const del = await admin(`/admin/workspaces/${copy.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  list = await (await admin('/admin/workspaces')).json();
  assert.equal(list.totals.workspaces, 1);
  assert.equal(list.workspaces[0].id, created.id);
  const original = await (await fetch(base + '/api/workspace', { headers: { cookie } })).json();
  assert.equal(original.projects.length, 2);

  // Unknown / malformed ids are rejected without touching anything.
  assert.equal((await admin('/admin/workspaces/..%2F..%2Fetc', { method: 'DELETE' })).status, 404);
  assert.equal((await admin('/admin/workspaces/nope/duplicate', { method: 'POST' })).status, 404);
  assert.equal((await admin('/admin/workspaces/nope', { method: 'DELETE' })).status, 404);

  console.log('admin workspaces: ok');
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
