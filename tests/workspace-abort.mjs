// Regression: a client that disconnects in the middle of a PUT body must not wedge the workspace's
// write queue forever (production once returned 504 on every request until the service was restarted).
//   node tests/workspace-abort.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const port = 20600 + Math.floor(Math.random() * 300);
const dir = await mkdtemp(join(tmpdir(), 'carver-abort-'));
const server = spawn(process.execPath, ['server/workspace-server.mjs', String(port)], {
  env: { ...process.env, CARVER_ADMIN_SECRET: 's', CARVER_ADMIN_PASSWORD: 'carver', CARVER_WORKSPACE_DIR: dir, CARVER_PUBLIC_ORIGIN: 'https://example.test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${port}`;
const admin = (path, init = {}) => fetch(base + path, { ...init, headers: { Authorization: 'Basic ' + Buffer.from('rezak:carver').toString('base64'), 'Content-Type': 'application/json', ...(init.headers || {}) } });
const waitForServer = async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/admin')).status === 401) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};
const timed = async (promise, ms, label) => {
  const result = await Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms))]);
  return result;
};

try {
  await waitForServer();
  const created = await (await admin('/admin/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Abort' }) })).json();
  const token = created.link.split('workspace=')[1];
  const entered = await fetch(base + '/api/workspace/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = entered.headers.get('set-cookie').split(';')[0];

  // A PUT whose body stops halfway and whose socket is then dropped.
  const partial = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { partial.once('connect', resolve); partial.once('error', reject); });
  partial.write(`PUT /api/workspace/projects/half HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n{"data":`);
  await new Promise((r) => setTimeout(r, 200));

  // Reads bypass the write queue, so polling keeps working even while a save is stuck.
  const manifest = await timed(fetch(base + '/api/workspace/manifest', { headers: { cookie } }), 3000, 'manifest while upload is open');
  assert.equal(manifest.status, 200, 'manifest responds during a stuck upload');
  await manifest.text();

  // Drop the upload. The body reader must reject and release the queue for the next write.
  partial.destroy();
  await new Promise((r) => setTimeout(r, 300));
  const heartbeat = await timed(fetch(base + '/api/workspace/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ projectIds: [] }) }), 3000, 'heartbeat after aborted upload');
  assert.equal(heartbeat.status, 204, 'write queue is released after the client disconnects');

  // The aborted project was never created.
  const finalManifest = await (await fetch(base + '/api/workspace/manifest', { headers: { cookie } })).json();
  assert.equal(finalManifest.projects.some((p) => p.id === 'half'), false, 'partial upload did not create a project');

  console.log('workspace abort: ok');
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
