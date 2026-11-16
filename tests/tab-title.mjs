// Browser check for the tab title precedence: open file → workspace name → app title.
//   npx vite preview --host 127.0.0.1 --port 5200 --strictPort
//   node tests/tab-title.mjs --url=http://127.0.0.1:5200/
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.argv.find((x) => x.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:5200/';
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const init = () => {
  localStorage.setItem('carver:modelsReady:onnx-community/whisper-large-v3-turbo', '1');
  localStorage.setItem('carver:prefs', JSON.stringify({ tips: false }));
};

try {
  // 1. Neither a file nor a workspace.
  const local = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 900 } });
  await local.addInitScript(init);
  const page = await local.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  await page.evaluate(() => { if (window.__carver.project) window.__carver.closeProject(); });
  await page.waitForFunction(() => document.title === 'Резак');

  // 2. An open file: its real source name (with extension), not the project label or just the app name.
  const project = {
    id: 'proj-title', name: 'Мой фильм', createdAt: Date.now(), updatedAt: Date.now(),
    media: { name: 'Мой фильм.mp4', size: 1000, lastModified: Date.now(), duration: 60, width: 1920, height: 1080, fps: 30, videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoBitrate: 0 },
    words: [{ text: 'привет', start: 0.1, end: 0.5 }], wordState: [0],
    silence: { enabled: true, thresholdDb: -42, minDuration: 1, padBefore: 0.15, padAfter: 0.12 },
    cut: { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 }, keptSilences: [], rangeCuts: [], suggestions: [], pipeline: [], version: 1,
  };
  await page.evaluate(async (p) => {
    await new Promise((res, rej) => {
      const r = indexedDB.open('carver', 1);
      r.onupgradeneeded = () => { for (const s of ['projects', 'blobs', 'handles', 'kv']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => { const t = r.result.transaction('projects', 'readwrite'); t.objectStore('projects').put(p, p.id); t.oncomplete = () => res(); t.onerror = () => rej(t.error); };
      r.onerror = () => rej(r.error);
    });
    window.__carver.openProject(p.id);
  }, project);
  await page.waitForFunction(() => document.title === 'Мой фильм.mp4 — Резак');

  // Progress keeps the file name.
  await page.evaluate(() => window.__carver.setTask({ kind: 'transcribe', frac: 0.5, text: 'Расшифровка…' }));
  await page.waitForFunction(() => document.title === '⏳ 50% · Мой фильм.mp4 — Резак');
  await page.evaluate(() => window.__carver.setTask(null));
  await page.evaluate(() => window.__carver.closeProject());
  await page.waitForFunction(() => document.title === 'Резак');
  await local.close();

  // 3. A workspace with no open project shows its name.
  const ws = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 900 } });
  await ws.addInitScript(init);
  await ws.route('**/api/workspace/**', async (route) => {
    const u = route.request().url();
    if (u.endsWith('/enter')) return route.fulfill({ status: 204, body: '' });
    const manifest = { id: 'ws-title', name: 'Нейрокурс ч3', updatedAt: 1, locks: [], deleted: [], projects: [] };
    if (u.includes('/manifest')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
  });
  const wp = await ws.newPage();
  await wp.goto(url + '?workspace=T', { waitUntil: 'networkidle' });
  await wp.waitForFunction(() => !!window.__carver);
  await wp.waitForFunction(() => document.title === 'Нейрокурс ч3 — Резак', null, { timeout: 15000 });
  await ws.close();

  console.log('tab title: ok');
} finally {
  await browser.close();
}
