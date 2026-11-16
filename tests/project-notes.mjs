// «Заметки редактора» in the batch table: collapsed while empty, editable, saved into the project
// (and pushed to the workspace server as a notes-only patch).
//   npx vite preview --port 5200 &
//   node tests/project-notes.mjs --url=http://localhost:5200/
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args.find((x) => x.startsWith('--url='))?.slice(6) || 'http://localhost:5200/';
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 1000 } });
await context.addInitScript(() => localStorage.setItem('carver:llm', JSON.stringify({ provider: 'openai', url: 'https://notes.test/v1', key: 'k', model: 'mock', temperature: '0', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: '', thinking: 'off' })));

const media = { name: 'Лекция.mp4', size: 1, lastModified: 1, duration: 10, width: 1920, height: 1080, fps: 30, videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoBitrate: 0 };
const batch = () => ({
  settings: { transcribe: true, fillers: false, carve: false, texts: false, strength: 'careful', textSteps: [], model: 'onnx-community/whisper-large-v3-turbo', targetLufs: -14.9 },
  stages: { prepare: { status: 'pending' }, transcribe: { status: 'pending' }, fillers: { status: 'skipped' }, carve: { status: 'skipped' }, texts: { status: 'skipped' }, video: { status: 'pending', note: '' } },
  status: 'queued',
});
const project = (id, workspaceId, notes) => ({
  id, workspaceId, name: 'Лекция', createdAt: 1, updatedAt: 1, media, notes, batch: batch(),
  words: [{ text: 'привет', start: 0.1, end: 0.5 }], wordState: [0],
  silence: { enabled: true, thresholdDb: -42, minDuration: 1, padBefore: 0.15, padAfter: 0.12 },
  cut: { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 }, keptSilences: [], rangeCuts: [], suggestions: [], pipeline: [], version: 1,
});

const patches = [];
const WORKSPACE = { id: 'ws-notes', name: 'Заметки', token: 'T', locks: [], deleted: [], updatedAt: 1, projects: [] };
await context.route('**/api/workspace**', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  if (req.method() === 'PATCH' && path.endsWith('/notes')) {
    const body = JSON.parse(req.postData() || '{}');
    patches.push(body);
    const id = path.split('/projects/')[1].replace('/notes', '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, revision: patches.length, updatedAt: Date.now(), data: { id, notes: body.notes } }) });
  }
  if (req.url().endsWith('/enter')) return route.fulfill({ status: 204, body: '' });
  if (req.url().includes('/manifest')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: WORKSPACE.id, name: WORKSPACE.name, updatedAt: WORKSPACE.updatedAt, locks: WORKSPACE.locks, deleted: WORKSPACE.deleted,
      projects: WORKSPACE.projects.map((p) => ({ id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt })),
    }) });
  }
  const single = req.url().match(/\/api\/workspace\/projects\/([^/?]+)$/);
  if (single) {
    const p = WORKSPACE.projects.find((x) => x.id === decodeURIComponent(single[1]));
    return route.fulfill({ status: p ? 200 : 404, contentType: 'application/json', body: JSON.stringify(p ?? { error: 'project not found' }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WORKSPACE) });
});

const seed = (page, projects) => page.evaluate(async (list) => {
  await new Promise((res, rej) => {
    const r = indexedDB.open('carver', 1);
    r.onupgradeneeded = () => { for (const s of ['projects', 'blobs', 'handles', 'kv']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => {
      const t = r.result.transaction(['projects', 'kv'], 'readwrite');
      for (const p of list) t.objectStore('projects').put(p, p.id);
      t.objectStore('kv').put(list.map((p) => p.id), list[0].workspaceId ? 'batch-queue-v1:ws:ws-notes' : 'batch-queue-v1:local');
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    };
    r.onerror = () => rej(r.error);
  });
}, projects);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
try {
  // ---- 1. Empty note: collapsed, opens on click, saves and stays open after a reload.
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  await seed(page, [project('p-local', undefined, undefined)]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-project-notes="p-local"]');
  assert.equal(await page.isVisible('[data-notes-input="p-local"]'), false, 'empty note is collapsed');
  assert.match(await page.innerText('[data-project-notes="p-local"]'), /Заметки редактора/);
  await page.screenshot({ path: '/tmp/notes-collapsed.png', fullPage: true });

  await page.click('[data-notes-toggle="p-local"]');
  await page.waitForSelector('[data-notes-input="p-local"]');
  await page.fill('[data-notes-input="p-local"]', 'Проверить титры в конце,\nсократить паузу после 12:30');
  await page.locator('[data-notes-input="p-local"]').blur();
  await page.screenshot({ path: '/tmp/notes-open.png', fullPage: true });
  assert.equal(await page.evaluate(() => window.__carver.project === null), true, 'editing notes does not open the project');
  await page.waitForTimeout(400);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-notes-input="p-local"]');
  assert.equal(await page.inputValue('[data-notes-input="p-local"]'), 'Проверить титры в конце,\nсократить паузу после 12:30', 'note survived the reload');
  const storedNote = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('carver', 1);
    r.onsuccess = () => { const q = r.result.transaction('projects', 'readonly').objectStore('projects').get('p-local'); q.onsuccess = () => res(q.result.notes); };
  }));
  assert.equal(storedNote, 'Проверить титры в конце,\nсократить паузу после 12:30', 'note is project data');

  // ---- 2. Workspace: a note is pushed as a notes-only PATCH and appears open when it already has text.
  WORKSPACE.projects = [{ id: 'p-ws', name: 'Лекция', updatedAt: 5, revision: 3, data: project('p-ws', 'ws-notes', 'Уже есть заметка от коллеги') }];
  await seed(page, [project('p-ws', 'ws-notes', 'Уже есть заметка от коллеги')]);
  await page.goto(url + '?workspace=T', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__carver.scope?.kind === 'workspace');
  await page.waitForSelector('[data-project-notes="p-ws"]');
  assert.equal(await page.isVisible('[data-notes-input="p-ws"]'), true, 'a non-empty note is open by default');
  assert.equal(await page.inputValue('[data-notes-input="p-ws"]'), 'Уже есть заметка от коллеги');

  await page.fill('[data-notes-input="p-ws"]', 'Новая заметка для команды');
  await page.locator('[data-notes-input="p-ws"]').blur();
  await page.waitForTimeout(800);
  assert.ok(patches.length >= 1, 'notes are pushed to the workspace');
  assert.equal(patches[patches.length - 1].notes, 'Новая заметка для команды');
  assert.deepEqual(Object.keys(patches[patches.length - 1]), ['notes'], 'only the notes field is sent');

  // ---- 3. Clearing a note removes it (PATCH with an empty string).
  await page.fill('[data-notes-input="p-ws"]', '');
  await page.locator('[data-notes-input="p-ws"]').blur();
  await page.waitForTimeout(800);
  assert.equal(patches[patches.length - 1].notes, '');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('project notes: ok');
} finally {
  await browser.close();
}
