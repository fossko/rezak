// Concurrency regression for the workspace service: simultaneous saves must not lose projects and must never
// expose a half-written file (the "Expected ',' or '}' after property value" error seen in production).
//   node tests/workspace-concurrency.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const serverPath = args.find((x) => x.startsWith('--server='))?.slice(9) || 'server/workspace-server.mjs';
const port = 20100 + Math.floor(Math.random() * 400);
const dir = await mkdtemp(join(tmpdir(), 'carver-concurrency-'));
const server = spawn(process.execPath, [serverPath, String(port)], {
  env: { ...process.env, CARVER_ADMIN_SECRET: 's', CARVER_ADMIN_PASSWORD: 'carver', CARVER_WORKSPACE_DIR: dir, CARVER_PUBLIC_ORIGIN: 'https://example.test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${port}`;
const admin = (path, init = {}) => fetch(base + path, { ...init, headers: { Authorization: 'Basic ' + Buffer.from('rezak:carver').toString('base64'), 'Content-Type': 'application/json', ...(init.headers || {}) } });

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/admin'); if (r.status === 401) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

try {
  await waitForServer();
  const created = await (await admin('/admin/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Стресс' }) })).json();
  const token = created.link.split('workspace=')[1];

  // Several participants: one session each, like several tabs/machines.
  const SESSIONS = 6;
  const cookies = [];
  for (let i = 0; i < SESSIONS; i++) {
    const r = await fetch(base + '/api/workspace/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    cookies.push(r.headers.get('set-cookie').split(';')[0]);
  }

  // 1. Parallel creation of different projects: every one must survive (load-modify-write races used to drop them).
  const PER_SESSION = 8;
  const body = (id) => JSON.stringify({ data: { id, name: id, words: Array.from({ length: 400 }, (_, k) => ({ text: 'слово' + k, start: k, end: k + 0.5 })) }, revision: 0 });
  const creates = [];
  for (let s = 0; s < SESSIONS; s++) {
    for (let k = 0; k < PER_SESSION; k++) {
      const id = `p${s}-${k}`;
      creates.push(fetch(`${base}/api/workspace/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: cookies[s] }, body: body(id) }).then((r) => r.status));
    }
  }
  const statuses = await Promise.all(creates);
  assert.equal(statuses.every((s) => s === 200), true, 'every create succeeded: ' + statuses.join(','));

  const final = await (await fetch(base + '/api/workspace', { headers: { cookie: cookies[0] } })).json();
  assert.equal(final.projects.length, SESSIONS * PER_SESSION, 'no create was lost');

  // 2. A read storm while writes are running: no request may see a partial file.
  const reads = [];
  for (let i = 0; i < 40; i++) {
    reads.push(fetch(base + '/api/workspace', { headers: { cookie: cookies[i % SESSIONS] } }).then(async (r) => ({ status: r.status, ok: await r.text().then((t) => { try { JSON.parse(t); return true; } catch { return false; } }) })));
  }
  const updates = [];
  for (let s = 0; s < SESSIONS; s++) {
    for (let k = 0; k < PER_SESSION; k++) {
      const id = `p${s}-${k}`;
      updates.push(fetch(`${base}/api/workspace/projects/${id}/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookies[s] }, body: JSON.stringify({ kind: 'editor' }) }));
    }
  }
  const readResults = await Promise.all(reads);
  await Promise.all(updates);
  assert.ok(readResults.every((r) => r.status === 200 && r.ok), 'every read got complete JSON');

  // 3. Concurrent heartbeat + save of the same project: the save must not be silently reverted.
  const pid = 'p0-0';
  const current = final.projects.find((p) => p.id === pid);
  await Promise.all([
    fetch(`${base}/api/workspace/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookies[0] }, body: JSON.stringify({ projectIds: [pid] }) }),
    fetch(`${base}/api/workspace/projects/${pid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: cookies[0] }, body: JSON.stringify({ data: { id: pid, name: 'после гонки' }, revision: current.revision }) }),
  ]);
  const afterRace = await (await fetch(base + '/api/workspace', { headers: { cookie: cookies[0] } })).json();
  assert.equal(afterRace.projects.find((p) => p.id === pid).data.name, 'после гонки', 'the save survived the concurrent heartbeat');

  // 4. The file on disk is always valid JSON, and no temporary files are left behind.
  const files = await readdir(dir);
  const workspaceFile = files.find((f) => f === `${created.id}.json`);
  assert.ok(workspaceFile, 'workspace file exists');
  const raw = await readFile(join(dir, workspaceFile), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.projects.length, SESSIONS * PER_SESSION);
  assert.deepEqual(files.filter((f) => f.includes('.tmp-')), [], 'no temporary files left');

  // 4b. The light poll returns revisions without the project bodies.
  const manifest = await (await fetch(base + '/api/workspace/manifest', { headers: { cookie: cookies[0] } })).json();
  assert.equal(manifest.projects.length, SESSIONS * PER_SESSION);
  assert.equal(manifest.projects[0].data, undefined, 'the manifest carries no project bodies');
  assert.ok(manifest.projects.every((p) => typeof p.revision === 'number'));
  assert.ok(Array.isArray(manifest.locks) && Array.isArray(manifest.deleted));
  const one = await fetch(`${base}/api/workspace/projects/${manifest.projects[0].id}`, { headers: { cookie: cookies[0] } });
  assert.equal(one.status, 200);
  assert.equal((await one.json()).data.id, manifest.projects[0].id, 'single project carries its data');
  assert.equal((await fetch(`${base}/api/workspace/projects/nope`, { headers: { cookie: cookies[0] } })).status, 404);
  const manifestBytes = JSON.stringify(manifest).length;
  const fullBytes = (await (await fetch(base + '/api/workspace', { headers: { cookie: cookies[0] } })).text()).length;
  assert.ok(manifestBytes * 10 < fullBytes, `manifest is much smaller (${manifestBytes} vs ${fullBytes} bytes)`);

  // 5. Releasing an editor/batch lease must NOT delete the project (this bug wiped projects on every close).
  const keepId = 'p1-0';
  const keep = afterRace.projects.find((p) => p.id === keepId);
  assert.ok(keep, 'project still present before the lock release');
  const owner = cookies[1];   // step 2 already locked this project from session 1
  const locked = await fetch(`${base}/api/workspace/projects/${keepId}/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: owner }, body: JSON.stringify({ kind: 'editor' }) });
  assert.equal(locked.status, 204);
  const released = await fetch(`${base}/api/workspace/projects/${keepId}/lock`, { method: 'DELETE', headers: { cookie: owner } });
  assert.equal(released.status, 204);
  const afterRelease = await (await fetch(base + '/api/workspace', { headers: { cookie: cookies[0] } })).json();
  assert.ok(afterRelease.projects.some((p) => p.id === keepId), 'releasing the lock keeps the project');
  assert.equal((afterRelease.deleted || []).some((d) => d.id === keepId), false, 'releasing the lock leaves no tombstone');
  // Batch claim/release too.
  await fetch(`${base}/api/workspace/batch/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: owner }, body: JSON.stringify({ queueId: 'q1', projectIds: [keepId] }) });
  await fetch(`${base}/api/workspace/projects/${keepId}/lock`, { method: 'DELETE', headers: { cookie: owner } });
  const afterBatch = await (await fetch(base + '/api/workspace', { headers: { cookie: cookies[0] } })).json();
  assert.ok(afterBatch.projects.some((p) => p.id === keepId), 'batch release keeps the project');

  // Notes are patched in place: only that field changes, for every participant.
  const noteBefore = (await (await fetch(base + '/api/workspace', { headers: { cookie: owner } })).json()).projects.find((p) => p.id === keepId);
  const patched = await fetch(`${base}/api/workspace/projects/${keepId}/notes`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: owner }, body: JSON.stringify({ notes: 'Перепроверить титры' }),
  });
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json();
  assert.equal(patchedBody.data.notes, 'Перепроверить титры');
  assert.equal(patchedBody.revision, noteBefore.revision + 1, 'notes bump the revision');
  assert.equal(patchedBody.data.name, noteBefore.data.name, 'the rest of the project is untouched');
  const otherView = await (await fetch(base + '/api/workspace', { headers: { cookie: cookies[2] } })).json();
  assert.equal(otherView.projects.find((p) => p.id === keepId).data.notes, 'Перепроверить титры', 'notes are visible to another participant');
  assert.equal((await fetch(`${base}/api/workspace/projects/nope/notes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: owner }, body: JSON.stringify({ notes: 'x' }) })).status, 404);
  assert.equal((await fetch(`${base}/api/workspace/projects/${keepId}/notes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'x' }) })).status, 401, 'notes need a session');

  // ...while a real DELETE still removes the project for everyone.
  const removed = await fetch(`${base}/api/workspace/projects/${keepId}`, { method: 'DELETE', headers: { cookie: cookies[0] } });
  assert.equal(removed.status, 204);
  const afterDelete = await (await fetch(base + '/api/workspace', { headers: { cookie: cookies[0] } })).json();
  assert.equal(afterDelete.projects.some((p) => p.id === keepId), false, 'DELETE removes the project');
  assert.equal(afterDelete.deleted.some((d) => d.id === keepId), true, 'DELETE leaves a tombstone');

  console.log('workspace concurrency: ok');
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
