// Regression: playback at the end of the recording must not scroll the waveform window past the end
// (which left a blank 200–300 px strip and looked like a time-shifted waveform). Zooming used to hide it.
//   npx vite preview --host 127.0.0.1 --port 5200 --strictPort
//   node tests/timeline-end.mjs --video=<clip.mp4>
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args.find((x) => x.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:5200/';
const video = args.find((x) => x.startsWith('--video='))?.slice(8);
assert.ok(video, 'pass --video=<file>');
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
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
  await page.setInputFiles('#carver-file-input', video);
  await page.waitForFunction(() => window.__carver?.pcm?.length > 0 && window.__carver?.levels && window.__carver?.edl, null, { timeout: 120000 });
  await page.evaluate(() => {
    const S = window.__carver;
    S.project.silence.enabled = false; S.project.rangeCuts = []; S.changed();
  });
  await page.waitForFunction(() => window.__carver?.edl?.segments?.length === 1, null, { timeout: 10000 });
  const D = await page.evaluate(() => window.__carver.project.media.duration);
  assert.ok(D > 1, 'clip must have a real duration');
  const span = Math.min(1.2, D / 2);
  await page.evaluate(({ span }) => {
    const T = window.__carverTimeline;
    T.span = span; T.v0 = 0; T.dirty = true;
  }, { span });
  await page.locator('.player canvas').click();
  await page.evaluate(({ D }) => {
    const P = window.__carverPlayer;
    P.seekSrc(Math.max(0, D - Math.min(0.6, D / 4)));
    P.play();
  }, { D });
  await page.waitForTimeout(700);
  const view = await page.evaluate(() => {
    const T = window.__carverTimeline, P = window.__carverPlayer;
    return { v0: T.v0, span: T.span, src: P?.currentSrc, playing: P?.playing };
  });
  assert.ok(view.v0 >= -1e-6, 'window starts at or after zero');
  assert.ok(view.v0 <= Math.max(0, D - view.span) + 0.02, `window ends at the recording end: v0=${view.v0}, D-span=${Math.max(0, D - view.span)}, view=${JSON.stringify(view)}`);
  assert.equal(errors.length, 0, 'no page errors: ' + errors.join('; '));
  console.log('timeline end: ok', JSON.stringify({ D, ...view }));
} finally {
  await browser.close();
}
