// Browser regression for «Папка с исходниками…»: one folder restores the source for every queued project.
//   npx vite preview --port 5200 &
//   node tests/relink-folder.mjs --url=http://localhost:5200/
// The directory picker is a fake handle (real pickers cannot be driven headless), but the app's own scan,
// match, verification (sameFile) and handle persistence run for real.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args.find((x) => x.startsWith('--url='))?.slice(6) || 'http://localhost:5200/';
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => localStorage.setItem('carver:llm', JSON.stringify({ provider: 'openai', url: 'https://relink.test/v1', key: 'k', model: 'mock', temperature: '0', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: '', thinking: 'off' })));

const media = (name, size, lastModified) => ({ name, size, lastModified, duration: 10, width: 1920, height: 1080, fps: 30, videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoBitrate: 0 });
const project = (id, m) => ({
  id, name: m.name, createdAt: 1, updatedAt: 1, media: m,
  words: [{ text: 'привет', start: 0.1, end: 0.5 }], wordState: [0],
  silence: { enabled: true, thresholdDb: -42, minDuration: 1, padBefore: 0.15, padAfter: 0.12 },
  cut: { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 }, keptSilences: [], rangeCuts: [], suggestions: [], pipeline: [], version: 1,
  batch: {
    settings: { transcribe: true, fillers: false, carve: false, texts: false, strength: 'careful', textSteps: [], model: 'onnx-community/whisper-large-v3-turbo', targetLufs: -14.9 },
    stages: { prepare: { status: 'pending' }, transcribe: { status: 'pending' }, fillers: { status: 'skipped' }, carve: { status: 'skipped' }, texts: { status: 'skipped' }, video: { status: 'pending', note: 'Только после ручного экспорта видео' } },
    status: 'queued',
  },
});

const A = project('proj-a', media('Урок 1.mp4', 4000, 1000));
const B = project('proj-b', media('Урок 2.mp4', 5000, 2000));      // renamed on disk, same size + date
const C = project('proj-c', media('Урок 3.mp4', 6000, 3000));      // not in the folder
const D = project('proj-d', media('Урок 4.mp4', 7000, 4000));      // wrong size on disk

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  await page.evaluate(async (projects) => {
    await new Promise((res, rej) => {
      const r = indexedDB.open('carver', 1);
      r.onupgradeneeded = () => { for (const s of ['projects', 'blobs', 'handles', 'kv']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => {
        const t = r.result.transaction(['projects', 'kv'], 'readwrite');
        for (const p of projects) t.objectStore('projects').put(p, p.id);
        t.objectStore('kv').put(projects.map((p) => p.id), 'batch-queue-v1:local');
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      };
      r.onerror = () => rej(r.error);
    });
  }, [A, B, C, D]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__carverBatch?.ready === true);

  await page.screenshot({ path: '/tmp/batch-relink.png' });
  // The folder button is present and enabled while the queue is idle.
  assert.equal(await page.isEnabled('[data-relink-folder]'), true, 'folder relink button is available');

  const result = await page.evaluate(async () => {
    const fileHandle = (name, size, lastModified) => ({ kind: 'file', name, async getFile() { return new File([new Uint8Array(size)], name, { lastModified }); } });
    const nested = {
      kind: 'directory', name: 'Съёмка',
      async *values() { yield fileHandle('Урок 4.mp4', 7001, 4000); },
    };
    const root = {
      kind: 'directory', name: 'Исходники',
      async *values() {
        yield fileHandle('Урок 1.mp4', 4000, 1000);      // exact match
        yield fileHandle('урок 2 — финал.mp4', 5000, 2000); // renamed copy
        yield nested;                                     // wrong size, deep inside
      },
    };
    const r = await window.__carverBatch.relinkFolder(root);
    const names = {};
    for (const id of ['proj-a', 'proj-b', 'proj-c', 'proj-d']) names[id] = window.__carverBatch.files.get(id)?.file?.name ?? null;
    return { r, names };
  });

  assert.equal(result.r.matched, 2, 'two sources restored');
  assert.deepEqual(result.r.missing.sort(), ['Урок 3.mp4', 'Урок 4.mp4'], 'missing files are reported, wrong size is not accepted');
  assert.deepEqual(result.r.ambiguous, []);
  assert.equal(result.names['proj-a'], 'Урок 1.mp4', 'exact name matched');
  assert.equal(result.names['proj-b'], 'урок 2 — финал.mp4', 'renamed file matched by size and date');

  // Real FileSystemFileHandles are structured-cloneable, so the app also stores them in IDB «handles»
  // (a fake handle with functions cannot be cloned; that path is exercised by the single-file relink).
  // A second pass over the same folder is harmless.
  const again = await page.evaluate(async () => {
    const fh = (name, size, lastModified) => ({ kind: 'file', name, async getFile() { return new File([new Uint8Array(size)], name, { lastModified }); } });
    const root = { kind: 'directory', name: 'x', async *values() { yield fh('Урок 1.mp4', 4000, 1000); yield fh('урок 2 — финал.mp4', 5000, 2000); yield fh('Урок 3.mp4', 6000, 3000); yield fh('Урок 4.mp4', 7000, 4000); } };
    return window.__carverBatch.relinkFolder(root);
  });
  assert.equal(again.matched, 4, 'a second pass restores the rest');
  assert.deepEqual(again.missing, []);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('relink folder: ok');
} finally {
  await browser.close();
}
