// Regression for per-step LLM models + the 20k fragment default: the structured step must send its
// configured model, one request for a 13k source, and the tightened structured prompt.
//   npx vite preview --host 127.0.0.1 --port 5200 --strictPort
//   node tests/step-models.mjs --url=http://127.0.0.1:5200/
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args.find((x) => x.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:5200/';
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => {
  const settings = {
    provider: 'custom', url: 'http://127.0.0.1:5200/v1', key: 'test', model: 'main-model',
    temperature: '0', maxTokens: '', chunkChars: '20000', parallel: '1', extraBody: '', extraHeaders: '',
    thinking: 'off', stepModels: { spelling: 'chat-model', structured: 'reasoner-model' },
  };
  localStorage.setItem('carver:llm', JSON.stringify(settings));
  localStorage.setItem('carver:modelsReady:onnx-community/whisper-large-v3-turbo', '1');
});

const requests = [];
await context.route('**/v1/chat/completions', async (route) => {
  const req = route.request();
  if (req.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    return;
  }
  const body = JSON.parse(req.postData() || '{}');
  requests.push(body);
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      choices: [{ message: { content: '## Готовый раздел\n\n' + 'Текст раздела. '.repeat(30) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());

const source = Array.from({ length: 230 }, (_, i) => `Строка ${i + 1}: содержательный фрагмент исходного текста.`).join('\n') + '\nКОНЕЦ-ИСХОДНИКА';
assert.ok(source.length > 12000 && source.length < 20000, 'test source must fit one 20k chunk');
const project = {
  id: 'proj-step-models', name: 'Per-step models', createdAt: Date.now(), updatedAt: Date.now(),
  media: { name: 'test.mp4', size: 1000, lastModified: Date.now(), duration: 60, width: 1920, height: 1080, fps: 30, videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoBitrate: 0 },
  words: [{ text: 'привет', start: 0.1, end: 0.5 }], wordState: [0],
  silence: { enabled: true, thresholdDb: -42, minDuration: 1, padBefore: 0.15, padAfter: 0.12 },
  cut: { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 }, keptSilences: [], rangeCuts: [], suggestions: [],
  pipeline: [{ stepId: 'spelling', text: source, at: Date.now() }], version: 1,
};

try {
  await page.goto(url, { waitUntil: 'networkidle' });
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
  await page.waitForFunction(() => window.__carver.project?.id === 'proj-step-models');
  // The pipeline only needs an EDL to render its output text; provide a silent 60 s level grid.
  await page.evaluate(() => { window.__carver.levels = new Float32Array(6000).fill(-60); window.__carver.recompute(); });
  await page.evaluate(() => window.__carver.setSideTab('texts'));
  await page.waitForSelector('[data-run-step="structured"]');
  await page.click('[data-run-step="structured"]');
  await page.waitForFunction(() => window.__carver.project.pipeline.some((r) => r.stepId === 'structured' && r.text?.includes('Готовый раздел')), null, { timeout: 15000 });

  assert.equal(requests.length, 1, '13k source with 20k chunks must be one request');
  assert.equal(requests[0].model, 'reasoner-model', 'structured uses its per-step model');
  const system = requests[0].messages.find((m) => m.role === 'system').content;
  const user = requests[0].messages.find((m) => m.role === 'user').content;
  assert.ok(system.includes('внимательный редактор'));
  assert.ok(user.includes('8–12 смысловых разделов'), 'tightened heading requirement is sent');
  assert.ok(user.includes('[неразборчиво]'), 'ASR-garbage rule is sent');
  assert.ok(user.includes('маркированными или нумерованными списками'), 'list requirement is sent');
  assert.ok(user.includes('КОНЕЦ-ИСХОДНИКА'), 'the whole source is in the single chunk');

  // The spelling step has a different override and must use it too.
  await page.click('[data-run-step="spelling"]');
  await page.waitForFunction(() => window.__carver.project.pipeline.some((r) => r.stepId === 'spelling' && r.text?.includes('Готовый раздел')), null, { timeout: 15000 });
  assert.equal(requests.length, 2, 'spelling made one request');
  assert.equal(requests[1].model, 'chat-model', 'spelling uses its per-step model');

  // The per-step fields are visible in Settings.
  await page.evaluate(() => window.__carver.openSettings('llm'));
  await page.click('summary:has-text("Модели по шагам")');
  await page.waitForSelector('[data-step-model="structured"]', { state: 'visible' });
  assert.equal(await page.inputValue('[data-step-model="structured"]'), 'reasoner-model');

  // Existing DeepSeek settings with the old 12k default migrate once to 20k.
  const ctx2 = await browser.newContext({ serviceWorkers: 'block' });
  await ctx2.addInitScript(() => {
    localStorage.setItem('carver:llm', JSON.stringify({ provider: 'deepseek', url: 'https://api.deepseek.com/v1', key: 'k', model: 'deepseek-chat', temperature: '0.2', maxTokens: '', chunkChars: '12000', parallel: '2', extraBody: '', extraHeaders: '', thinking: 'auto' }));
  });
  const page2 = await ctx2.newPage();
  await page2.goto(url, { waitUntil: 'networkidle' });
  await page2.evaluate(() => window.__carver.openSettings('llm'));
  await page2.waitForFunction(() => JSON.parse(localStorage.getItem('carver:llm') || '{}').chunkChars === '20000');
  await ctx2.close();

  assert.equal(errors.length, 0, 'no page errors: ' + errors.join('; '));
  console.log('step models: ok');
} finally {
  await browser.close();
}
