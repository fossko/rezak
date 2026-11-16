// Manual MP4 marking + archived batch-result export regression.
// node tests/batch-results.mjs /path/to/video.mp4 --url=http://localhost:5200/
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2), source = resolve(args.find(x => !x.startsWith('--')) || 'tests/fixtures/synthetic.mp4');
const url = args.find(x => x.startsWith('--url='))?.slice(6) || 'http://localhost:5200/';
const bytes = readFileSync(source), browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1500, height: 920 } });
await context.addInitScript(() => {
  localStorage.setItem('carver:modelsReady:whisper', '1');
  // Headless VPS has no hardware codecs. Keep real WebCodecs, but select its software path.
  for (const API of [VideoDecoder, VideoEncoder]) {
    const configure = API.prototype.configure, supported = API.isConfigSupported.bind(API);
    API.prototype.configure = function(config) { return configure.call(this, { ...config, hardwareAcceleration: 'prefer-software' }); };
    API.isConfigSupported = config => supported({ ...config, hardwareAcceleration: 'prefer-software' });
  }
  window.__carverTestHandle = async () => (await navigator.storage.getDirectory()).getFileHandle('manual-export.mp4', { create: true });
  window.__carverTestDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('batch-results-manual', { create: true });
});
const page = await context.newPage(), errors = [];
page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
page.on('console', m => { if (m.type() === 'error') console.error('[browser]', m.text()); });
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.__carver.transcribe = async () => {}; });
  await page.locator('#carver-file-input').setInputFiles(source);
  await page.waitForFunction(() => window.__carver?.media && window.__carver?.pcm && !window.__carver?.task, null, { timeout: 120000 });
  const info = await page.evaluate(async () => {
    const S = window.__carver, d = S.project.media.duration;
    if (d < 1) throw new Error('fixture must be at least one second');
    S.project.words = [{ text: 'начало', start: d * .05, end: d * .1 }, { text: 'конец.', start: d * .8, end: d * .9 }];
    S.wordState = new Uint8Array(2); S.wordMute = new Uint8Array(2);
    S.project.batch = { settings: { transcribe: false, fillers: false, carve: false, texts: false, strength: 'careful', textSteps: [], model: 'test', targetLufs: -14.9 }, stages: Object.fromEntries(['prepare','transcribe','fillers','carve','texts','video'].map(id => [id, { status: id === 'video' ? 'pending' : 'done' }])), status: 'done' };
    S.setSilence({ enabled: false }); S.project.rangeCuts = [[d * .25, d * .35]]; S.changed();
    const titleName = 'archived-title.mp4';
    await S.addTitle(new File([S.media.file], titleName, { type: S.media.file.type }), null);
    const asset = S.titleLib.at(-1), ins = S.insertTitle(asset.id, d * .7);
    if (!ins) throw new Error('title insertion failed');
    S.trimTitle(ins.id, d * .1, d * .3);
    await S.saveNow();
    return { id: S.project.id, titleName, duration: S.composite.duration, lastWordStart: S.composite.srcToOut(d * .8), clips: S.composite.clips.map(c => ({ ...c })) };
  });
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const mp4 = page.getByRole('button', { name: 'Экспортировать MP4…', exact: true });
  await page.evaluate(() => { window.__carverTestHandle = async () => { window.__pickerCancelled = true; throw new DOMException('cancelled', 'AbortError'); }; });
  await mp4.click();
  await page.waitForFunction(() => window.__pickerCancelled);
  assert.equal(await page.evaluate(() => window.__carver.project.batch.stages.video.status), 'pending', 'cancelled picker never marks video done');
  assert.equal(await page.evaluate(() => window.__carver.project.videoExport), undefined);
  await page.evaluate(() => { window.__carverTestHandle = async () => (await navigator.storage.getDirectory()).getFileHandle('manual-export.mp4', { create: true }); });
  await mp4.click();
  await page.waitForFunction(() => window.__carver?.project?.videoExport || window.__carver?.toasts.some(t => t.kind === 'err'), null, { timeout: 120000 });
  await page.waitForFunction(() => !window.__carver?.task, null, { timeout: 120000 });
  const marked = await page.evaluate(async id => {
    const db = await indexedDB.open('carver'); return await new Promise(r => { db.onsuccess = () => { const q = db.result.transaction('projects').objectStore('projects').get(id); q.onsuccess = () => r(q.result); }; });
  }, info.id);
  assert.ok(marked.videoExport?.name, 'successful manual MP4 records videoExport');
  assert.equal(marked.batch?.stages?.video?.status, 'done', 'successful manual export marks the batch video stage');
  const mp4File = await page.evaluate(async () => (await navigator.storage.getDirectory()).getFileHandle('manual-export.mp4').then(x => x.getFile()).then(f => f.size));
  assert.ok(mp4File > 1000, 'manual MP4 was written');
  const outDir = resolve(process.env.TMPDIR || '/tmp', 'carver-test-out'); mkdirSync(outDir, { recursive: true });
  const dataUrl = await page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle('manual-export.mp4')).getFile();
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
  });
  writeFileSync(resolve(outDir, 'batch-manual.mp4'), Buffer.from(dataUrl.split(',')[1], 'base64'));

  // Turn this saved project into an archived batch record without opening another project.
  await page.evaluate(async () => {
    const S = window.__carver;
    await S.saveNow(); S.closeProject(true); S.batchView = true; S.bump();
  });
  await page.waitForFunction(() => document.querySelector('.batch-panel') && document.querySelectorAll('.batch-table tbody tr[data-project-row]').length === 1);
  assert.equal(await page.locator('.batch-table thead th').count(), 4, 'batch results table has four columns');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  assert.ok(overflow, 'desktop batch table has no horizontal overflow');
  await page.screenshot({ path: `${process.env.TMPDIR || '/tmp'}/carver-test-out/batch-results.png`, fullPage: true });

  await page.getByRole('button', { name: 'Скачать результаты', exact: true }).click();
  await page.waitForFunction(() => !window.__carverBatch?.exporting, null, { timeout: 30000 });
  const exported = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), d = await root.getDirectoryHandle('batch-results-manual');
    for await (const [name, h] of d.entries()) if (h.kind === 'directory') {
      const out = {}; for await (const [n, f] of h.entries()) out[n] = f.kind === 'file' ? await f.getFile().then(async x => n.endsWith('.mp4') ? x.size : x.text()) : '';
      return { name, files: Object.keys(out), xml: out['timeline.xml'] || '', processed: out['processed.json'] || '', manifest: out['manifest.json'] || '', mp4: out['manual-export.mp4'] || 0 };
    }
    return null;
  });
  assert.ok(exported?.files.includes('timeline.xml'), 'archived results include XML');
  assert.match(exported.xml, /archived-title\.mp4/, 'archived XML preserves title filename');
  assert.ok(exported.files.includes('processed.srt') && exported.files.includes('processed.json'), 'processed timeline text exported');
  const processed = JSON.parse(exported.processed);
  assert.ok(Math.abs(processed.duration - info.duration) < .001, 'processed duration includes archived titles');
  assert.ok(Math.abs(processed.words.at(-1).start - info.lastWordStart) < .001, 'archived word times include title insertion');
  assert.ok(exported.manifest.includes('video'), 'manifest includes stage statuses');
  assert.ok(exported.mp4 > 1000, 'results copy the already-rendered manual MP4 without rendering');
  assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ source, manualMp4Bytes: mp4File, files: exported.files, title: info.titleName }));
} finally { await browser.close(); }
