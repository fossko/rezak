// Sessions must survive a service restart (a deploy used to log every open tab out), and a project body
// larger than nginx's default 1 MB must still be saved (that was the «Failed to fetch» on save).
//   node tests/workspace-sessions.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'carver-sessions-'));
const port = 21000 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
let server;

function start() {
  server = spawn(process.execPath, ['server/workspace-server.mjs', String(port)], {
    env: { ...process.env, CARVER_ADMIN_SECRET: 's', CARVER_ADMIN_PASSWORD: 'carver', CARVER_WORKSPACE_DIR: dir, CARVER_PUBLIC_ORIGIN: 'https://example.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    server.stdout.on('data', (chunk) => { if (String(chunk).includes('Workspace service')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited: ' + code)); });
  });
}
async function stop() {
  if (!server) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  server = null;
}
async function enter(token) {
  const r = await fetch(base + '/api/workspace/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(r.status, 204);
  return r.headers.get('set-cookie').split(';')[0];
}

try {
  await start();
  const made = await (await fetch(base + '/admin/workspaces', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('rezak:carver').toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Сессии' }) })).json();
  const token = made.link.split('workspace=')[1];
  const cookie = await enter(token);

  // 1. A big project (3.4 MB) is accepted: nginx is not involved here, but the service limit must allow it.
  const big = { id: 'big', name: 'big', words: Array.from({ length: 14000 }, (_, i) => ({ text: 'слово'.repeat(20), start: i, end: i + 0.5 })) };
  const put = await fetch(`${base}/api/workspace/projects/big`, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ data: big, revision: 0 }) });
  assert.equal(put.status, 200, 'a multi-megabyte project is saved');
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 3_000_000, 'the payload really is multi-megabyte');

  // 2. The session file is written, and the cookie keeps working after a restart.
  const saved = JSON.parse(await readFile(join(dir, 'sessions.dat'), 'utf8'));
  assert.ok(Object.values(saved).includes(made.id), 'the session is persisted');

  await stop();
  await start();

  const manifest = await fetch(base + '/api/workspace/manifest', { headers: { cookie } });
  assert.equal(manifest.status, 200, 'the old cookie still works after a restart');
  const body = await manifest.json();
  assert.equal(body.projects.length, 1);

  // 3. A stale cookie gets a distinguishable error so the client can re-enter instead of showing a network error.
  const stale = await fetch(base + '/api/workspace/manifest', { headers: { cookie: 'carver_workspace=gone' } });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error, 'SESSION_EXPIRED');

  console.log('workspace sessions: ok');
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}
