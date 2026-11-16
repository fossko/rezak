// Browser regression: shared workspace projects and local projects must stay isolated.
//   npx vite preview --port 5200 &
//   node tests/workspace-scope.mjs --url=http://localhost:5200/
// Checks: no workspace URL → only local projects; workspace URL → only that workspace's projects;
// opening a local project inside a workspace tab never pushes it to the server; the batch queue is per scope.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args.find((x) => x.startsWith('--url='))?.slice(6) || 'http://localhost:5200/';
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem('carver:llm', JSON.stringify({ provider: 'openai', url: 'https://scope.test/v1', key: 'k', model: 'mock', temperature: '0', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: '', thinking: 'off' }));
});

const media = { name: 'x.mp4', size: 1, lastModified: 1, duration: 10, width: 1920, height: 1080, fps: 30, videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoBitrate: 0 };
const batchState = () => ({
  settings: { transcribe: true, fillers: true, carve: false, texts: false, strength: 'careful', textSteps: [], model: 'onnx-community/whisper-large-v3-turbo', targetLufs: -14.9 },
  stages: { prepare: { status: 'pending' }, transcribe: { status: 'pending' }, fillers: { status: 'pending' }, carve: { status: 'skipped' }, texts: { status: 'skipped' }, video: { status: 'pending', note: 'Только после ручного экспорта видео' } },
  status: 'queued',
});
const baseProject = (id, name, workspaceId) => ({
  id, name, workspaceId, createdAt: 1, updatedAt: 1, media, batch: batchState(),
  words: [{ text: 'привет', start: 0.1, end: 0.5 }], wordState: [0],
  silence: { enabled: true, thresholdDb: -42, minDuration: 1, padBefore: 0.15, padAfter: 0.12 },
  cut: { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 }, keptSilences: [], rangeCuts: [], suggestions: [], pipeline: [], version: 1,
});
const LOCAL = baseProject('local-1', 'Локальный проект', undefined);
const WORKSPACE_PROJECT = baseProject('ws-1', 'Проект пространства', 'ws-test');

const puts = [];
let sessionValid = true, enters = 0;
await context.route('**/api/workspace**', async (route) => {
  const req = route.request();
  if (req.url().endsWith('/enter')) { enters++; sessionValid = true; return route.fulfill({ status: 204, body: '' }); }
  if (!sessionValid) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
  if (req.method() === 'PUT') {
    const body = JSON.parse(req.postData() || '{}');
    puts.push(body);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: body.data?.id, name: 'x', updatedAt: Date.now(), revision: (body.revision || 0) + 1 }) });
  }
  const remote = { id: 'ws-1', name: 'Проект пространства', updatedAt: 5, revision: 3, data: WORKSPACE_PROJECT };
  if (req.url().includes('/manifest')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: 'ws-test', name: 'Нейрокурс', updatedAt: 1, locks: [], deleted: [],
      projects: [{ id: remote.id, name: remote.name, revision: remote.revision, updatedAt: remote.updatedAt }],
    }) });
  }
  if (req.url().match(/\/api\/workspace\/projects\/[^/?]+$/)) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(remote) });
  }
  return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 'ws-test', name: 'Нейрокурс', token: 'T', locks: [], deleted: [], updatedAt: 1, projects: [remote] }),
  });
});

const seed = async (page) => page.evaluate(async (projects) => {
  await new Promise((res, rej) => {
    const r = indexedDB.open('carver', 1);
    r.onupgradeneeded = () => { for (const s of ['projects', 'blobs', 'handles', 'kv']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => {
      const t = r.result.transaction(['projects', 'kv'], 'readwrite');
      for (const p of projects) t.objectStore('projects').put(p, p.id);
      // One queue per scope, both non-empty: neither may leak into the other mode.
      t.objectStore('kv').put(['local-1'], 'batch-queue-v1:local');
      t.objectStore('kv').put(['ws-1'], 'batch-queue-v1:ws:ws-test');
      t.objectStore('kv').put(['local-1', 'ws-1'], 'batch-queue-v1');   // legacy single queue
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    };
    r.onerror = () => rej(r.error);
  });
}, [LOCAL, WORKSPACE_PROJECT]);

const visibleRows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-project-row]')].map((e) => e.getAttribute('data-project-row')));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
try {
  // ---- 1. Local mode: only projects created on this machine.
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  await seed(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__carver.scope?.kind === 'local');
  await page.waitForSelector('[data-project-row]');
  assert.deepEqual((await visibleRows(page)).sort(), ['local-1'], 'local mode shows only local projects');
  await page.waitForFunction(() => window.__carverBatch?.ready === true);
  assert.deepEqual(await page.evaluate(() => window.__carverBatch.queue), ['local-1'], 'local mode uses the local queue only');
  const noWorkspacePuts = puts.length;

  // Saving a local project never reaches a workspace (there is none in this tab anyway).
  await page.evaluate(async () => { await window.__carver.openProject('local-1'); });
  await page.waitForFunction(() => window.__carver.project?.id === 'local-1');
  await page.evaluate(async () => { window.__carver.project.name = 'Локальный проект 2'; await window.__carver.saveNow(true); });
  assert.equal(puts.length, noWorkspacePuts, 'local save made no workspace request');

  // Cmd/Ctrl+S force-saves and names the machine as the browser exposes it (no hostname API).
  await page.keyboard.press('Meta+s');
  const machine = await page.evaluate(() => window.__carverMachineLabel?.());
  assert.ok(machine, 'machine label hook is exposed');
  await page.waitForFunction((label) => [...document.querySelectorAll('.toast')].some((t) => t.textContent === `Сохранено на ${label}`), machine, { timeout: 5000 });

  // On the project table ⌘S must save all projects (not open the browser's save dialog) and report it.
  await page.evaluate(() => window.__carver.closeProject(true));
  await page.waitForFunction(() => !window.__carver.project);
  await page.evaluate(() => { window.__sKeyPrevented = null; window.addEventListener('keydown', (e) => { if (e.code === 'KeyS') window.__sKeyPrevented = e.defaultPrevented; }); });
  await page.keyboard.press('Control+s');
  await page.waitForFunction((label) => [...document.querySelectorAll('.toast')].some((t) => t.textContent?.startsWith(`Сохранено на ${label}:`)), machine, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__sKeyPrevented), true, 'browser page save is prevented');

  // ---- 2. Workspace mode: only this workspace's projects, never the local ones.
  await page.goto(url + '?workspace=T', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__carver.scope?.kind === 'workspace');
  await page.waitForFunction(() => window.__carver.workspaceId === 'ws-test');
  await page.evaluate(() => window.__carver.closeProject(true));
  await page.waitForSelector('[data-project-row]');
  assert.deepEqual((await visibleRows(page)).sort(), ['ws-1'], 'workspace mode shows only workspace projects');
  await page.waitForFunction(() => window.__carverBatch?.ready === true);
  assert.deepEqual(await page.evaluate(() => window.__carverBatch.queue), ['ws-1'], 'workspace mode uses its own queue only');

  // A local project opened through any code path must not be pushed into the workspace.
  const before = puts.length;
  await page.evaluate(async () => { await window.__carver.openProject('local-1'); });
  await page.waitForFunction(() => window.__carver.project?.id === 'local-1');
  await page.evaluate(async () => { window.__carver.project.name = 'Локальный проект 3'; await window.__carver.saveNow(true); });
  await page.waitForTimeout(400);
  assert.equal(puts.length, before, 'a local project opened in a workspace tab is not uploaded');

  // ---- 3. The workspace project itself still saves normally.
  await page.evaluate(async () => { await window.__carver.openProject('ws-1'); });
  await page.waitForFunction(() => window.__carver.project?.id === 'ws-1');
  // The editor lock is requested shortly after opening; only then may this tab write to the server.
  await page.waitForFunction(() => window.__carver.workspaceSessionReady === true, null, { timeout: 5000 });
  const beforeWs = puts.length;
  await page.evaluate(async () => { window.__carver.project.name = 'Проект пространства 2'; await window.__carver.saveNow(true); });
  await page.waitForTimeout(400);
  assert.ok(puts.length > beforeWs, 'workspace project is still saved to the server');
  assert.equal(puts[puts.length - 1].data.id, 'ws-1');

  // Ctrl+S in a workspace project saves locally and pushes once, with the exact workspace name.
  const beforeHot = puts.length;
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Сохранено в Нейрокурс'), null, { timeout: 5000 });
  assert.ok(puts.length > beforeHot, 'workspace hotkey save pushed the project');
  assert.equal(puts[puts.length - 1].data.id, 'ws-1');

  // A restarted workspace service drops in-memory sessions. The client must re-enter with the URL
  // token and retry the save instead of flooding the screen with 401 error toasts.
  const entersBefore = enters;
  sessionValid = false;
  await page.evaluate(async () => { window.__carver.project.name = 'Проект после перезапуска'; await window.__carver.saveNow(true); });
  await page.waitForTimeout(300);
  assert.ok(enters > entersBefore, 'client re-authenticated after 401');
  assert.ok(sessionValid, 'new session established');
  assert.equal(puts.at(-1).data.id, 'ws-1');

  // Pressing ⌘S on the workspace project table saves every dirty project and reports the real count.
  await page.evaluate(() => window.__carver.closeProject(true));
  await page.waitForFunction(() => !window.__carver.project);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Все проекты в Нейрокурс актуальны' || t.textContent?.startsWith('Сохранено в Нейрокурс:')), null, { timeout: 5000 });
  await page.evaluate(() => { window.__carver.toasts = []; window.__carver.bump(); });
  await page.waitForTimeout(1600);
  const beforeAll = puts.length;
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('carver'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const p = await new Promise((res, rej) => { const q = db.transaction('projects').objectStore('projects').get('ws-1'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    p.name = 'Проект пространства после таблицы'; p.updatedAt = Date.now() + 60000;
    await new Promise((res, rej) => { const q = db.transaction('projects', 'readwrite').objectStore('projects').put(p, 'ws-1'); q.onsuccess = () => res(); q.onerror = () => rej(q.error); });
  });
  await page.keyboard.press('Control+s');
  for (let i = 0; i < 50 && puts.length === beforeAll; i++) await page.waitForTimeout(100);
  assert.ok(puts.length > beforeAll, 'table ⌘S actually pushed the dirty project');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Сохранено в Нейрокурс: 1 проект'), null, { timeout: 5000 });

  // ---- 4. Back to the plain URL after a workspace session: only local projects again.
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__carver.scope?.kind === 'local');
  await page.waitForSelector('[data-project-row]');
  assert.deepEqual((await visibleRows(page)).sort(), ['local-1'], 'plain URL hides the workspace projects again');
  await page.waitForFunction(() => window.__carverBatch?.ready === true);
  assert.deepEqual(await page.evaluate(() => window.__carverBatch.queue), ['local-1'], 'local queue restored');

  // ---- 5. The old single queue is migrated per scope, never wholesale.
  await page.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open('carver', 1);
    r.onsuccess = () => {
      const t = r.result.transaction('kv', 'readwrite');
      t.objectStore('kv').delete('batch-queue-v1:local');
      t.objectStore('kv').delete('batch-queue-v1:ws:ws-test');
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    };
    r.onerror = () => rej(r.error);
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__carverBatch?.ready === true);
  assert.deepEqual(await page.evaluate(() => window.__carverBatch.queue), ['local-1'], 'legacy queue migrated without workspace ids');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('workspace scope: ok');
} finally {
  await browser.close();
}
