// Browser regression for the durable batch queue. Run against a built preview:
// node tests/batch.mjs /path/to/video.mp4 --url=http://localhost:5200/
// This deliberately stubs ASR/filler work; it tests queue persistence, LLM calls and result downloads.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const source = resolve(args.find(x => !x.startsWith('--')) || 'tests/fixtures/synthetic.mp4');
const url = args.find(x => x.startsWith('--url='))?.slice(6) || 'http://localhost:5200/';
const bytes = readFileSync(source);
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1500, height: 920 } });
await context.addInitScript(() => {
  localStorage.setItem('carver:modelsReady:whisper', '1');
  localStorage.setItem('carver:llm', JSON.stringify({ provider: 'openai', url: 'https://batch.test/v1', key: 'test', model: 'mock', temperature: '0', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: '', thinking: 'off' }));
  window.__carverTestDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('batch-results', { create: true });
});
const page = await context.newPage();
const requests = [];
await context.route('**/v1/chat/completions', async route => {
  const body = JSON.parse(route.request().postData() || '{}');
  requests.push(body);
  const prompt = body.messages?.map(x => x.content).join('\n') || '';
  const content = prompt.includes('Расшифровка:')
    ? JSON.stringify({ cuts: [{ line: 0, text: 'эээ', type: 'filler', confidence: 0.99, reason: 'mock' }] })
    : 'Результат пакетного текста';
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carverBatch && !!window.__carver);
  // Deterministic speech replacement: prepare still decodes the real fixture/PCM.
  const installStubs = () => page.evaluate(() => {
    const S = window.__carver;
    S.transcribe = async () => {
      window.__batchActive = (window.__batchActive || 0) + 1;
      window.__batchMaxActive = Math.max(window.__batchMaxActive || 0, window.__batchActive);
      await new Promise(r => setTimeout(r, window.__batchSlow ? 1000 : 30));
      try {
        if (window.__batchFailOnce) { window.__batchFailOnce = false; throw new Error('injected ASR failure'); }
        const d = S.project.media.duration;
        S.project.words = [{ text: 'эээ', start: Math.min(.1, d / 4), end: Math.min(.25, d / 3), para: true }, { text: 'тест.', start: Math.max(.3, d / 3), end: Math.min(.7, d - .1) }];
        S.wordState = new Uint8Array(S.project.words.length); S.wordMute = new Uint8Array(S.project.words.length);
        S.changed(false);
      } finally { window.__batchActive--; }
    };
    S.findFillers = async () => {};
  });
  await installStubs();
  const input = page.locator('#carver-batch-input');
  const payload = { name: 'batch-one.mp4', mimeType: 'video/mp4', buffer: bytes };
  const payload2 = { name: 'batch-two.mp4', mimeType: 'video/mp4', buffer: bytes };
  await input.setInputFiles([payload, payload2]);
  await page.waitForFunction(() => document.querySelectorAll('.batch-table tbody tr[data-project-row]').length === 2, null, { timeout: 30000 });
  const initial = await page.evaluate(() => window.__carverBatch.queue.length);
  assert.equal(initial, 2, 'two files are queued');
  assert.equal(await page.locator('.batch-table thead th').count(), 4, 'batch table has four columns');
  await page.getByRole('button', { name: '▶ Запустить очередь' }).click();
  await page.waitForFunction(() => !window.__carverBatch.running && window.__carverBatch.queue.length === 2, null, { timeout: 120000 });
  const persisted = await page.evaluate(async () => { const db = await indexedDB.open('carver'); return new Promise(r => { db.onsuccess = () => { const q = db.result.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => r(q.result); }; }); });
  assert.equal(persisted.length, 2, 'both projects persisted');
  for (const p of persisted) {
    assert.equal(p.batch.status, 'done', `${p.name} batch done`);
    assert.equal(p.batch.stages.video.status, 'pending', 'video remains manual');
    assert.equal(p.pipeline.length, 3, 'three default text results saved');
    assert.equal(p.videoExport, undefined, 'batch does not mark video export');
  }
  assert.ok(requests.length >= 8, 'actual mocked LLM endpoint was used for carve and text stages');
  assert.equal(await page.evaluate(() => window.__batchMaxActive), 1, 'only one active file at a time');

  // Reload must retain projects and completed stage records.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carverBatch && document.querySelectorAll('.batch-table tbody tr[data-project-row]').length === 2);
  await installStubs();

  // Result download uses one OPFS directory and distinct project/id folders.
  await page.getByRole('button', { name: 'Скачать все результаты' }).click();
  await page.waitForFunction(() => !window.__carverBatch.exporting, null, { timeout: 30000 });
  const files = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), d = await root.getDirectoryHandle('batch-results');
    const out = [];
    for await (const [name, h] of d.entries()) { if (h.kind !== 'directory') continue; const fs = []; for await (const [n, x] of h.entries()) fs.push(n); out.push({ name, files: fs }); }
    return out;
  });
  assert.equal(files.length, 2, 'one unique result folder per project');
  for (const f of files) {
    assert.ok(f.files.includes('manifest.json') && f.files.includes('project.carver.json'), 'manifest/project exported');
    assert.ok(f.files.some(x => x.endsWith('.md')), 'LLM markdown exported');
    assert.ok(f.files.includes('timeline.xml'), 'XML exported');
    assert.ok(!f.files.some(x => x.endsWith('.mp4')), 'results never synthesize MP4');
  }

  // Add two new files. Inject ASR failure in the first; queue must continue with the second.
  const input2 = page.locator('#carver-batch-input');
  await input2.setInputFiles([{ name: 'batch-three.mp4', mimeType: 'video/mp4', buffer: bytes }, { name: 'batch-four.mp4', mimeType: 'video/mp4', buffer: bytes }]);
  await page.waitForFunction(() => document.querySelectorAll('.batch-table tbody tr[data-project-row]').length === 4, null, { timeout: 30000 });
  await page.evaluate(() => { window.__batchFailOnce = true; });
  await page.getByRole('button', { name: '▶ Запустить очередь' }).click();
  await page.waitForFunction(() => !window.__carverBatch.running, null, { timeout: 120000 });
  const added = await page.evaluate(async () => { const db = await indexedDB.open('carver'); return new Promise(r => { db.onsuccess=()=>{const q=db.result.transaction('projects').objectStore('projects').getAll();q.onsuccess=()=>r(q.result.filter(x=>x.name.includes('batch-three')||x.name.includes('batch-four')))} }); });
  assert.equal(added.length, 2, 'new projects persisted');
  const failed = added.find(p => p.name.includes('batch-three'));
  const completed = added.find(p => p.name.includes('batch-four'));
  assert.equal(failed.batch.status, 'error', 'injected stage failure is persisted');
  assert.equal(failed.batch.stages.prepare.status, 'done', 'failed project keeps prepare done');
  assert.equal(failed.batch.stages.transcribe.status, 'error', 'ASR stage failed');
  assert.equal(completed.batch.status, 'done', 'next queued project completes after failure');

  // Retry queues only the failed project; completed prepare is skipped.
  await page.evaluate(id => window.__carverBatch.retry(id), failed.id);
  await page.evaluate(() => window.__carverBatch.start());
  await page.waitForFunction(() => !window.__carverBatch.running, null, { timeout: 120000 });
  const retried = await page.evaluate(async id => { const db = await indexedDB.open('carver'); return new Promise(r => { db.onsuccess=()=>{const q=db.result.transaction('projects').objectStore('projects').get(id);q.onsuccess=()=>r(q.result)} }); }, failed.id);
  assert.equal(retried.batch.status, 'done', 'retry completes');
  assert.equal(retried.batch.stages.video.status, 'pending', 'video still pending after retry');
  assert.equal(await page.evaluate(() => window.__batchMaxActive), 1, 'queue never runs two files concurrently');

  // Stop prevents the next queued file from starting; a later start resumes it.
  await input2.setInputFiles([{ name: 'batch-five.mp4', mimeType: 'video/mp4', buffer: bytes }, { name: 'batch-six.mp4', mimeType: 'video/mp4', buffer: bytes }]);
  await page.waitForFunction(() => document.querySelectorAll('.batch-table tbody tr[data-project-row]').length === 6, null, { timeout: 30000 });
  await page.evaluate(() => { window.__batchSlow = true; });
  await page.getByRole('button', { name: '▶ Запустить очередь' }).click();
  await page.waitForFunction(() => window.__batchActive > 0, null, { timeout: 30000 });
  await page.getByRole('button', { name: 'Стоп' }).click();
  await page.waitForFunction(() => !window.__carverBatch.running, null, { timeout: 30000 });
  const stopped = await page.evaluate(async () => { const db = await indexedDB.open('carver'); return new Promise(r => { db.onsuccess=()=>{const q=db.result.transaction('projects').objectStore('projects').getAll();q.onsuccess=()=>r(q.result.filter(x=>x.name.includes('batch-five')||x.name.includes('batch-six')))} }); });
  assert.ok(stopped.some(p => p.batch.status === 'interrupted' || p.batch.status === 'error'), 'stop persists interruption');
  assert.ok(stopped.some(p => p.batch.status === 'queued' || p.batch.stages.prepare.status === 'pending'), 'stop leaves next file unstarted');
  await page.evaluate(() => { window.__batchSlow = false; });
  await page.getByRole('button', { name: '▶ Запустить очередь' }).click();
  await page.waitForFunction(() => !window.__carverBatch.running, null, { timeout: 120000 });
  const resumed = await page.evaluate(async () => { const db = await indexedDB.open('carver'); return new Promise(r => { db.onsuccess=()=>{const q=db.result.transaction('projects').objectStore('projects').getAll();q.onsuccess=()=>r(q.result.filter(x=>x.name.includes('batch-five')||x.name.includes('batch-six')))} }); });
  assert.ok(resumed.every(p => p.batch.status === 'done'), 'resume completes stopped files');

  // Regression: files were added while «Тексты» was on, then the whole group was switched off.
  // Individual text steps were checked earlier; the queue must still not run them.
  const beforeTexts = requests.length;
  await input2.setInputFiles([{ name: 'batch-seven.mp4', mimeType: 'video/mp4', buffer: bytes }, { name: 'batch-eight.mp4', mimeType: 'video/mp4', buffer: bytes }]);
  await page.waitForFunction(() => document.querySelectorAll('.batch-table tbody tr[data-project-row]').length === 8, null, { timeout: 30000 });
  await page.getByRole('button', { name: '⚙ Настройки' }).click();
  const textsGroup = page.locator('[data-setting="texts"]');
  assert.equal(await textsGroup.isChecked(), true, 'text group is on by default');
  await textsGroup.click();
  assert.equal(await page.locator('[data-setting="text:spelling"]').count(), 0, 'group off hides its steps');
  const readNew = () => page.evaluate(async () => { const db = await indexedDB.open('carver'); return new Promise(r => { db.onsuccess = () => { const q = db.result.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => r(q.result.filter(x => x.name.includes('batch-seven') || x.name.includes('batch-eight'))); }; }); });
  await page.waitForFunction(async () => {
    const db = await indexedDB.open('carver');
    return new Promise(resolve => { db.onsuccess = () => { const q = db.result.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => resolve(q.result.filter(x => x.name.includes('batch-seven') || x.name.includes('batch-eight')).every(p => p.batch.settings.texts === false && p.batch.stages.texts.status === 'skipped')); }; });
  }, null, { timeout: 15000 });
  await page.getByRole('button', { name: '▶ Запустить очередь' }).click();
  await page.waitForFunction(() => !window.__carverBatch.running, null, { timeout: 120000 });
  const textOff = await readNew();
  assert.equal(textOff.length, 2);
  for (const p of textOff) {
    assert.equal(p.batch.settings.texts, false, `${p.name}: saved group switch is off`);
    assert.equal(p.batch.stages.texts.status, 'skipped', `${p.name}: text stage skipped`);
    assert.equal(p.pipeline.length, 0, `${p.name}: no text results`);
  }
  const textRequests = requests.slice(beforeTexts);
  assert.equal(textRequests.length, 2, 'only AI-carving requests for the two files');
  assert.ok(textRequests.every(request => (request.messages || []).some(m => String(m.content).includes('Расшифровка:'))), 'no text-step request was sent');

  assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ source, requests: requests.length, folders: files.length, projects: persisted.length + 2 + resumed.length }));
} finally { await browser.close(); }
