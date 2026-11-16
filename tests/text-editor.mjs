// Browser regression for the full-screen text editor (Тексты → ✎ Редактировать).
// Checks: the edit button is disabled until a text exists, Cmd/Ctrl+S saves text + prompt into the
// project (Esc/⌘S never opens the browser's "save page"), and in a workspace ⌘S pushes to the server.
//   npx vite preview --port 5200 &
//   node tests/text-editor.mjs --url=http://localhost:5200/
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args.find((x) => x.startsWith('--url='))?.slice(6) || 'http://localhost:5200/';
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem('carver:modelsReady:' + (JSON.parse(localStorage.getItem('carver:prefs') || '{}').model || 'onnx-community/whisper-large-v3-turbo'), '1');
  localStorage.setItem('carver:llm', JSON.stringify({ provider: 'openai', url: 'https://texts.test/v1', key: 'test', model: 'mock', temperature: '0', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: '', thinking: 'off' }));
});

const puts = [];
let staleNext = false;   // next PUT answers 409 STALE_REVISION, to test the explicit-save retry
const workspace = {
  id: 'ws-test', name: 'Тест', token: 'T', updatedAt: 1, locks: [], deleted: [],
  projects: [{ id: 'proj-text', name: 'Проект', updatedAt: 1, revision: 0, data: null }],
};
await context.route('**/api/workspace**', async (route) => {
  const req = route.request();
  if (req.method() === 'PUT') {
    const body = JSON.parse(req.postData() || '{}');
    puts.push(body);
    if (staleNext) {
      staleNext = false;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'STALE_REVISION', project: { ...workspace.projects[0], revision: 7 } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...workspace.projects[0], revision: (body.revision || 0) + 1 }) });
    return;
  }
  if (req.url().endsWith('/enter')) return route.fulfill({ status: 204, body: '' });
  // The app polls the light manifest and fetches a project only when its revision changed.
  if (req.url().includes('/manifest')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: workspace.id, name: workspace.name, updatedAt: workspace.updatedAt, locks: workspace.locks, deleted: workspace.deleted,
      projects: workspace.projects.map((p) => ({ id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt })),
    }) });
  }
  const single = route.request().url().match(/\/api\/workspace\/projects\/([^/?]+)$/);
  if (single) {
    const p = workspace.projects.find((x) => x.id === decodeURIComponent(single[1]));
    return route.fulfill({ status: p ? 200 : 404, contentType: 'application/json', body: JSON.stringify(p ?? { error: 'project not found' }) });
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workspace) });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());

const project = {
  id: 'proj-text', name: 'Проект', createdAt: Date.now(), updatedAt: Date.now(), workspaceId: 'ws-test',
  media: { name: 'test.mp4', size: 1000, lastModified: Date.now(), duration: 60, width: 1920, height: 1080, fps: 30, videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoBitrate: 0 },
  words: [{ text: 'привет', start: 0.1, end: 0.5 }], wordState: [0], silence: { enabled: true, thresholdDb: -42, minDuration: 1, padBefore: 0.15, padAfter: 0.12 },
  cut: { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 }, keptSilences: [], rangeCuts: [], suggestions: [], pipeline: [], version: 1,
};

try {
  await page.goto(url + '?workspace=T', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  await page.evaluate(async (p) => {
    await new Promise((res, rej) => {
      const r = indexedDB.open('carver', 1);
      r.onupgradeneeded = () => { for (const s of ['projects', 'blobs', 'handles', 'kv']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => { const t = r.result.transaction('projects', 'readwrite'); t.objectStore('projects').put(p, p.id); t.oncomplete = () => res(); t.onerror = () => rej(t.error); };
      r.onerror = () => rej(r.error);
    });
    window.__carver.openProject(p.id);
  }, project);
  await page.waitForFunction(() => window.__carver.project?.id === 'proj-text');
  await page.evaluate(() => window.__carver.setSideTab('texts'));

  // 1. No text yet → the edit button must be disabled.
  await page.waitForSelector('[data-edit-text="spelling"]');
  assert.equal(await page.isDisabled('[data-edit-text="spelling"]'), true, 'edit is disabled before generation');

  // 2. Generated text enables it and opens the overlay.
  await page.evaluate(() => {
    const S = window.__carver;
    S.project.pipeline = [{ stepId: 'spelling', text: 'Старый текст', at: Date.now() }];
    S.bump();
  });
  await page.waitForFunction(() => !document.querySelector('[data-edit-text="spelling"]')?.hasAttribute('disabled'));
  await page.screenshot({ path: process.env.CARVER_SHOT_PANEL || '/tmp/texts-panel.png' });
  await page.click('[data-edit-text="spelling"]');
  await page.waitForSelector('[data-text-editor="spelling"] textarea[data-text-editor-input]');

  // 3. Type a long text and press Ctrl+S: it saves the project and never offers to save the page.
  const long = Array.from({ length: 40 }, (_, i) => `Абзац ${i + 1}: отредактированный текст для проверки.`).join('\n\n');
  // The browser must never see an unhandled Ctrl+S (that opens "save the page").
  const prevented = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    document.querySelector('[data-text-editor-input]').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  assert.equal(prevented, true, 'Ctrl+S is handled, the page is not saved');
  await page.fill('[data-text-editor-input]', long);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__carver.project.pipeline.find((r) => r.stepId === 'spelling')?.text?.startsWith('Абзац 1:'));
  assert.equal(await page.isVisible('[data-text-editor="spelling"]'), true, 'overlay stays open after saving');
  await page.waitForFunction(() => document.querySelector('.teditor-dirty') == null, null, { timeout: 5000 });

  // 4. The prompt is editable and saved into the project.
  await page.click('.teditor-prompt summary');
  const promptArea = page.locator('.teditor-prompt textarea').first();
  await promptArea.fill('Новый запрос к модели');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__carver.project.prompts?.spelling?.map === 'Новый запрос к модели');

  await page.screenshot({ path: process.env.CARVER_SHOT || '/tmp/text-editor.png' });

  // 5. In a workspace Cmd+S pushes the project (with the edited text) to the server.
  await page.waitForTimeout(600);
  assert.ok(puts.length >= 1, 'workspace received the forced save');
  const pushed = puts[puts.length - 1].data;
  assert.equal(pushed.pipeline.find((r) => r.stepId === 'spelling').text, long, 'server received the edited text');
  assert.equal(pushed.prompts.spelling.map, 'Новый запрос к модели', 'server received the edited prompt');

  // 5b. A stale revision is retried with the server's revision instead of losing the edit.
  await page.waitForTimeout(700);   // let the debounced autosave settle first
  staleNext = true;
  const beforeRetry = puts.length;
  await page.click('.teditor-head');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => true);
  await page.waitForTimeout(900);
  assert.ok(puts.length >= beforeRetry + 2, 'stale save was retried');
  assert.notEqual(puts[beforeRetry].revision, 7, 'the first attempt used the stale revision');
  assert.ok(puts.slice(beforeRetry + 1).some((p) => p.revision === 7), 'retry used the revision reported by the server');

  // 6. A reload keeps both: they are project state, not component state.
  await page.click('.teditor-head button[aria-label="Закрыть"]');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  await page.evaluate(async () => { await window.__carver.openProject('proj-text'); });
  await page.waitForFunction(() => window.__carver.project?.id === 'proj-text');
  const after = await page.evaluate(() => {
    const p = window.__carver.project;
    return { text: p.pipeline.find((r) => r.stepId === 'spelling')?.text, prompt: p.prompts?.spelling?.map };
  });
  assert.equal(after.text, long, 'edited text survived the reload');
  assert.equal(after.prompt, 'Новый запрос к модели', 'edited prompt survived the reload');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('text editor: ok');
} finally {
  await browser.close();
}
