// Browser check for the post-processing vertical VU meter: it sits to the right of the preview,
// matches its height, and moves while processed audio is playing.
//   npx vite preview --host 127.0.0.1 --port 5200 --strictPort
//   node tests/vu-meter.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv.find((x) => x.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:5200/';
const sr = 48000, seconds = 3, amp = 0.5;
const n = sr * seconds;
const wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * amp * 32767), 44 + i * 2);
const path = join(mkdtempSync(join(tmpdir(), 'carver-vu-')), 'sine.wav');
writeFileSync(path, wav);

const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem('carver:modelsReady:onnx-community/whisper-large-v3-turbo', '1');
  localStorage.setItem('carver:prefs', JSON.stringify({ tips: false, phraseLeveler: false }));
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  await page.evaluate(() => { if (window.__carver.project) window.__carver.closeProject(); });
  await page.setInputFiles('#carver-file-input', path);
  await page.waitForFunction(() => window.__carver?.pcm?.length > 0 && window.__carver?.edl && !window.__carver?.task, null, { timeout: 120000 });
  const box = await page.evaluate(() => {
    const c = document.querySelector('.player canvas').getBoundingClientRect();
    const v = document.querySelector('[data-vu]').getBoundingClientRect();
    return { c: { x: c.x, y: c.y, w: c.width, h: c.height }, v: { x: v.x, y: v.y, w: v.width, h: v.height } };
  });
  assert.ok(box.v.x >= box.c.x + box.c.w - 1, 'meter is to the right of the preview');
  assert.ok(Math.abs(box.v.h - box.c.h) <= 2, `meter matches preview height (${box.v.h} vs ${box.c.h})`);
  await page.locator('.player canvas').click();
  await page.waitForTimeout(900);
  const vu = await page.evaluate(() => {
    const el = document.querySelector('[data-vu]');
    const fill = el.querySelector('.vu-fill');
    return { db: +el.getAttribute('data-db'), peak: +el.getAttribute('data-peak'), clip: fill.style.clipPath, playing: window.__carverPlayer?.playing };
  });
  assert.ok(vu.playing, 'preview is playing');
  assert.ok(vu.db > -50, 'processed playback moves the meter: ' + JSON.stringify(vu));
  assert.notEqual(vu.clip, 'inset(100% 0 0)', 'meter is visibly lit');
  await page.screenshot({ path: process.env.CARVER_SHOT || '/tmp/carver-vu.png' });
  assert.equal(errors.length, 0, 'no page errors: ' + errors.join('; '));
  console.log('vu meter: ok', JSON.stringify({ box, vu }));
} finally {
  await browser.close();
}
