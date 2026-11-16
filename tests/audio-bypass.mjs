// Browser check for the global audio-processing bypass in the Звук tab:
// the toggle is at the bottom, disables the whole chain in the player, persists on the client,
// and future projects start bypassed.
//   npx vite preview --host 127.0.0.1 --port 5200 --strictPort
//   node tests/audio-bypass.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function wav(name, amp = 0.05) {
  const sr = 48000, seconds = 3, n = sr * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * amp * 32767), 44 + i * 2);
  const p = join(mkdtempSync(join(tmpdir(), 'carver-bypass-')), name);
  writeFileSync(p, b);
  return p;
}
const first = wav('sine-one.wav'), second = wav('sine-two.wav');

const url = process.argv.find((x) => x.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:5200/';
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem('carver:modelsReady:onnx-community/whisper-large-v3-turbo', '1');
  const prefs = JSON.parse(localStorage.getItem('carver:prefs') || '{}');
  localStorage.setItem('carver:prefs', JSON.stringify({ ...prefs, tips: false, phraseLeveler: false }));
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const openAudio = async (file) => {
  await page.evaluate(() => { if (window.__carver.project) window.__carver.closeProject(); });
  await page.setInputFiles('#carver-file-input', file);
  await page.waitForFunction(() => window.__carver?.pcm?.length > 0 && window.__carver?.edl && !window.__carver?.task, null, { timeout: 120000 });
};
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  await openAudio(first);
  // A quiet sine needs processing; wait for the automatic master (or at least its absence is not fatal).
  await page.waitForFunction(() => !!window.__carver.master, null, { timeout: 20000 }).catch(() => {});
  const before = await page.evaluate(() => ({
    master: !!window.__carver.master,
    chain: !!window.__carverPlayer?.mChainCfg,
    leveler: !!window.__carverPlayer?.mLeveler,
  }));
  assert.equal(before.master, true, 'the quiet test signal gets automatic processing');

  await page.evaluate(() => window.__carver.setSideTab('audio'));
  await page.waitForSelector('[data-testid="audio-bypass"] [data-audio-bypass]');
  const buttonText = await page.textContent('[data-audio-bypass]');
  assert.match(buttonText, /Обойти обработку/);
  await page.click('[data-audio-bypass]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('carver:prefs') || '{}').audioBypass === true);
  await page.waitForFunction(() => window.__carverPlayer?.mChainCfg === null && !window.__carverPlayer?.mLeveler);
  const off = await page.evaluate(() => ({
    master: !!window.__carver.master,
    chain: !!window.__carverPlayer?.mChainCfg,
    leveler: !!window.__carverPlayer?.mLeveler,
    restore: window.__carverPlayer?.mRestoreAmt,
    button: document.querySelector('[data-audio-bypass]')?.textContent,
    disabled: document.querySelector('.audio-controls')?.hasAttribute('disabled'),
  }));
  assert.equal(off.chain, false, 'player master chain bypassed');
  assert.equal(off.leveler, false, 'player leveler bypassed');
  assert.equal(off.restore, 0, 'player restoration bypassed');
  assert.equal(off.disabled, true, 'processing controls are disabled');
  assert.match(off.button, /Включить обработку/);
  await page.screenshot({ path: process.env.CARVER_SHOT || '/tmp/carver-bypass.png' });

  // Reload keeps the client preference, and a NEW project starts without automatic processing.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__carver);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('carver:prefs') || '{}').audioBypass), true, 'bypass persists');
  await openAudio(second);
  await page.waitForTimeout(800);
  const future = await page.evaluate(() => ({ master: !!window.__carver.master, bypass: JSON.parse(localStorage.getItem('carver:prefs') || '{}').audioBypass }));
  assert.equal(future.bypass, true);
  assert.equal(future.master, false, 'future project is bypassed by default');

  // The same toggle re-enables the controls (the saved master of the first project would be used again).
  await page.evaluate(() => window.__carver.setSideTab('audio'));
  await page.click('[data-audio-bypass]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('carver:prefs') || '{}').audioBypass === false);
  await page.waitForFunction(() => !!window.__carver.master, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.querySelector('.audio-controls')?.hasAttribute('disabled')), false);
  assert.match(await page.textContent('[data-audio-bypass]'), /Обойти обработку/);
  assert.equal(errors.length, 0, 'no page errors: ' + errors.join('; '));
  console.log('audio bypass: ok', JSON.stringify({ before, off, future }));
} finally {
  await browser.close();
}
