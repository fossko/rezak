// Real Chrome smoke/regression test against the BUILT app; never starts a server.
// node tests/xml-export.mjs /path/to/video.mp4 [--url=http://localhost:5200/]
// CARVER_CHROME_PATH overrides installed Chrome. Outputs: $TMPDIR/carver-test-out/xml-*.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const video = args.find(a => !a.startsWith('--'));
assert(video, 'Usage: node tests/xml-export.mjs <video> [--url=http://localhost:5200/]');
const source = resolve(video);
const url = args.find(a => a.startsWith('--url='))?.slice(6) || 'http://localhost:5200/';
const out = join(process.env.TMPDIR || '/tmp', 'carver-test-out');
mkdirSync(out, { recursive: true });
const titleName = 'Заставка & XML проверка.mp4';
const browser = await chromium.launch({
  channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined,
  headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', viewport: { width: 1500, height: 920 } });
// Same modelsReady shim as audio-dsp.mjs; additionally replace transcription BEFORE opening a file.
await context.addInitScript(() => {
  const get = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    return typeof key === 'string' && key.startsWith('carver:modelsReady') ? '1' : get.call(this, key);
  };
});
const page = await context.newPage();
const errors = [], downloads = [], modelRequests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('download', d => downloads.push(d.suggestedFilename()));
page.on('dialog', d => d.accept());
// Safety net: fail the test if a model request was attempted, rather than downloading gigabytes.
await context.route('**/*', route => {
  const u = route.request().url();
  if (/huggingface\.co|cdn-lfs|\/models\/|\.(onnx|safetensors)(\?|$)/i.test(u)) {
    modelRequests.push(u); return route.abort();
  }
  return route.continue();
});
const report = { url, source, titleName };
async function installHooks() {
  await page.waitForFunction(() => !!window.__carver);
  await page.evaluate(() => { window.__carver.transcribe = async () => {}; });
}
const button = () => page.getByRole('button', { name: 'Экспортировать XML', exact: true });
async function expectDisabled(disabled) {
  await page.waitForFunction(want => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Экспортировать XML' && b.disabled === want), disabled);
  assert.equal(await button().isDisabled(), disabled);
}
async function exportAndCheck(label, expected) {
  const pending = page.waitForEvent('download');
  await button().click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /\.xml$/);
  const path = join(out, `xml-${label}.xml`);
  await download.saveAs(path);
  const xml = readFileSync(path, 'utf8');
  const result = await page.evaluate(({ xml, expected }) => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    check(!doc.querySelector('parsererror'), 'XML must be well formed');
    check(doc.documentElement.tagName === 'xmeml', 'Expected xmeml');
    const text = (el, tag) => el.querySelector(`:scope > ${tag}`)?.textContent;
    const num = (el, tag) => Number(text(el, tag));
    const clips = [...doc.querySelectorAll('sequence > media > video > track > clipitem')];
    const audio = [...doc.querySelectorAll('sequence > media > audio > track > clipitem')];
    check(clips.length === expected.clips.length, 'All composite clips exported');
    let end = 0;
    clips.forEach((clip, i) => {
      const wanted = expected.clips[i], name = wanted.kind === 'main' ? expected.sourceName : expected.titleName;
      check(text(clip, 'name') === name, 'Actual filename including extension');
      check(num(clip, 'start') === end, 'Video packed with no gaps or overlaps');
      end = num(clip, 'end');
      check(end > num(clip, 'start'), 'Positive duration');
      const rate = clip.querySelector(':scope > rate');
      const fps = num(rate, 'timebase') * (text(rate, 'ntsc') === 'TRUE' ? 1000 / 1001 : 1);
      const a = num(clip, 'in') / fps, b = num(clip, 'out') / fps;
      check(Math.abs(a - wanted.a) <= 1 / fps + 1e-6 && Math.abs(b - wanted.b) <= 1 / fps + 1e-6, 'Source trim matches composite');
      if (wanted.kind === 'main') check(b <= expected.cut[0] + 1e-6 || a >= expected.cut[1] - 1e-6, 'Removed range is absent');
      const links = [...clip.querySelectorAll(':scope > link')].filter(l => text(l, 'mediatype') === 'audio');
      check(links.length > 0, 'Video has audio links');
      for (const link of links) {
        const target = doc.getElementById(text(link, 'linkclipref')) || [...doc.querySelectorAll('clipitem')].find(c => c.id === text(link, 'linkclipref'));
        check(target && audio.includes(target), 'Audio link resolves');
        for (const field of ['start', 'end', 'in', 'out']) check(num(target, field) === num(clip, field), 'Linked audio aligned');
        check([...target.querySelectorAll('linkclipref')].some(ref => ref.textContent === clip.id), 'Reciprocal video link');
      }
    });
    check(num(doc.querySelector('sequence'), 'duration') === end, 'Sequence ends with last clip');
    const files = [...doc.querySelectorAll('file > name')].map(n => n.textContent);
    check(files.includes(expected.sourceName) && files.includes(expected.titleName), 'File definitions preserve names');
    for (const p of doc.querySelectorAll('pathurl')) check(decodeURIComponent(p.textContent).endsWith(expected.sourceName) || decodeURIComponent(p.textContent).endsWith(expected.titleName), 'Relink URL preserves filename');
    check(clips.some(c => text(c, 'name') === expected.titleName), 'Trimmed title included');
    return { videoClips: clips.length, audioClips: audio.length, durationFrames: end, files };
  }, { xml, expected });
  return { path, ...result };
}
try {
  await page.goto(url);
  await installHooks();
  await page.locator('#carver-file-input').setInputFiles(source);
  await page.waitForFunction(() => window.__carver.media && window.__carver.pcm && !window.__carver.task, null, { timeout: 120000 });
  const expected = await page.evaluate(async ({ titleName, sourceName }) => {
    const S = window.__carver, duration = S.project.media.duration;
    if (duration < 1) throw new Error('Fixture must be at least one second with video and audio');
    S.setSilence({ enabled: false });
    S.checkpoint();
    const cut = [duration / 3, duration / 2];
    S.project.rangeCuts = [cut];
    S.changed();
    await S.addTitle(new File([S.media.file], titleName, { type: S.media.file.type }), null);
    const asset = S.titleLib.at(-1);
    const insertion = S.insertTitle(asset.id, duration * 0.75);
    if (!insertion) throw new Error('Title insertion failed');
    S.trimTitle(insertion.id, duration * 0.1, duration * 0.3);
    await S.saveNow();
    return { sourceName, titleName, cut, projectId: S.project.id, assetId: asset.id, clips: S.composite.clips.map(c => ({ ...c })) };
  }, { titleName, sourceName: basename(source) });
  report.expected = expected;
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  await expectDisabled(false);
  assert.equal(await page.getByText('Звук — исходный:', { exact: false }).isVisible(), true, 'Audio limitation visible with hints off');
  assert.equal(await page.getByText('Границы подрезаются до целых кадров', { exact: false }).isVisible(), true, 'Frame precision limitation visible with hints off');
  report.first = await exportAndCheck('first', expected);
  await page.screenshot({ path: join(out, 'xml-export.png'), fullPage: true });

  await page.evaluate(() => window.__carver.setTask({ kind: 'export', frac: 0.5, text: 'Тест занятости' }));
  await expectDisabled(true);
  await page.evaluate(() => window.__carver.setTask(null));
  await expectDisabled(false);
  await page.evaluate(() => { const S = window.__carver; S.checkpoint(); S.project.rangeCuts = [[0, S.project.media.duration]]; S.changed(); });
  await expectDisabled(true);
  await page.evaluate(cut => { const S = window.__carver; S.project.rangeCuts = [cut]; S.changed(); }, expected.cut);
  await expectDisabled(false);
  await page.evaluate(() => window.__carver.saveNow());
  report.disabledBusyAndAllCut = true;

  // Reload clears module caches. Reopen project and read the title name from persisted IndexedDB File.
  await page.reload();
  await installHooks();
  await page.evaluate(async id => { const S = window.__carver; await S.initTitleLib(); await S.openProject(id); }, expected.projectId);
  await page.locator('#carver-link-input').setInputFiles(source);
  await page.waitForFunction(() => window.__carver.media && !window.__carver.task);
  await page.evaluate(() => window.__carver.setSideTab('export'));
  await expectDisabled(false);
  report.persisted = await exportAndCheck('persisted', expected);

  // Lose the original File (legacy Blob without a name): export must fail rather than invent .mp4.
  await page.evaluate(async id => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('carver'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['blobs', 'handles'], 'readwrite');
      tx.objectStore('blobs').delete(`title:${id}`);
      tx.objectStore('handles').delete(`title:${id}`);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    window.__carver.toasts = []; window.__carver.bump();
  }, expected.assetId);
  const before = downloads.length;
  await button().click();
  await page.waitForFunction(() => window.__carver.toasts.some(t => t.kind === 'err' && /Ошибка экспорта XML.*имя/.test(t.text)));
  await expectDisabled(false);
  assert.equal(downloads.length, before, 'Missing title filename must not download XML');
  report.missingFilenameError = await page.evaluate(() => window.__carver.toasts.find(t => t.kind === 'err').text);
  assert.deepEqual(modelRequests, [], 'No model loads attempted');
  assert.deepEqual(errors, [], 'No unhandled browser errors');
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.ok = false; report.error = error.stack;
  await page.screenshot({ path: join(out, 'xml-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  writeFileSync(join(out, 'xml-report.json'), JSON.stringify({ ...report, errors, modelRequests, downloads }, null, 2));
  await browser.close();
}
