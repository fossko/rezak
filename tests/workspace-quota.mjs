import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceQueue } from '../server/workspace-queue.mjs';

const exclusive = createWorkspaceQueue(20);
const delayed = Promise.withResolvers();
const first = exclusive('project', () => delayed.promise);
let secondStarted = false;
const second = exclusive('project', () => { secondStarted = true; });
await assert.rejects(first, { status: 503 });
assert.equal(secondStarted, false);
delayed.resolve();
await second;
assert.equal(secondStarted, true);

const dir = await mkdtemp(join(tmpdir(), 'rezak-workspace-quota-'));
const data = { name: 'Кириллица', notes: 'слово: videoBytes', words: [] };
const template = { id: 'p1', name: data.name, updatedAt: 1234567890123, revision: 0, data };
// Expected array as it appears in the indented workspace file.
const quota = Buffer.byteLength('[\n' + JSON.stringify(template, null, 2)
  .split('\n').map(line => '    ' + line).join('\n') + '\n  ]');
const server = spawn(process.execPath, ['server/workspace-server.mjs', '0'], {
  env: {
    ...process.env, CARVER_ADMIN_SECRET: 'fixture', CARVER_ADMIN_PASSWORD: 'fixture',
    CARVER_WORKSPACE_DIR: dir, CARVER_WORKSPACE_PROJECT_BYTES: String(quota),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const stopped = once(server, 'exit');
try {
  const [output] = await Promise.race([
    once(server.stdout, 'data'),
    stopped.then(() => { throw new Error('Сервис завершился до запуска'); }),
  ]);
  const base = output.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base);
  const admin = (path, method) => fetch(base + '/admin/workspaces' + path, {
    method, headers: { Authorization: 'Bearer fixture' },
  });
  async function enter(token) {
    const response = await fetch(base + '/api/workspace/enter', {
      method: 'POST', body: JSON.stringify({ token }),
    });
    assert.equal(response.status, 204);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return (path, method = 'GET', body) => fetch(base + '/api/workspace' + path, {
      method, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const created = await (await admin('', 'POST')).json();
  const request = await enter(new URL(created.link).searchParams.get('workspace'));
  const put = (id, project, revision = 0) => request('/projects/' + id, 'PUT', { data: project, revision });
  const candidates = await Promise.all([put('p1', data), put('p2', data)]);
  assert.deepEqual(candidates.map(r => r.status).sort(), [200, 413]);
  assert.equal((await candidates.find(r => r.status === 413).json()).error, 'WORKSPACE_QUOTA_EXCEEDED');
  const project = await candidates.find(r => r.status === 200).json();
  const invalid = { ...data, media: { videoBytes: [] } };
  assert.equal((await put('bad', invalid)).status, 400);
  assert.equal((await put(project.id, invalid)).status, 400);
  assert.equal((await put(project.id, data)).status, 200);
  assert.equal((await put(project.id, { ...data, notes: data.notes + '!' }, 1)).status, 413);
  assert.equal((await request('/projects/' + project.id + '/notes', 'PATCH', { notes: data.notes + '!' })).status, 413);
  const saved = await (await request('/projects/' + project.id)).json();
  assert.deepEqual(saved.data, data);
  assert.equal(saved.revision, 1);

  const legacy = { ...template, data: { ...data, notes: 'я'.repeat(500) } };
  await writeFile(join(dir, 'legacy.json'), JSON.stringify({
    id: 'legacy', name: 'Старые проекты', token: 'fixture-legacy', projects: [legacy], locks: [],
  }));
  const previous = await enter('fixture-legacy');
  assert.equal((await previous('/projects/p1')).status, 200);
  assert.equal((await admin('/legacy/duplicate', 'POST')).status, 413);
  assert.equal((await previous('/projects/p1/notes', 'PATCH', { notes: 'я'.repeat(300) })).status, 200);
  assert.equal((await previous('/projects/p1', 'DELETE')).status, 204);
} finally {
  server.kill();
  await stopped;
  await rm(dir, { recursive: true, force: true });
}
