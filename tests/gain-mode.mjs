// «Усиление звука» (⚙ «Звук»): presets for the automatic processing. Runs against the BUILT app (preview 5300).
// node tests/gain-mode.mjs <video>
//  1. per mode: new project → automatic processing → compressor preset + exact LUFS vs the mode's aim
//  2. inside a project: mode change re-aims the automatic make-up and swaps an untouched compressor;
//     a hand-edited compressor and a hand-set make-up stay; persisted after reload
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const video = process.argv[2];
const tmp = process.env.TMPDIR || '/tmp', outDir = join(tmp, 'carver-test-out'); mkdirSync(outDir, { recursive: true });
const ctx = await chromium.launchPersistentContext(join(tmp, 'carver-audio-test-profile'), { channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true, viewport: { width: 1500, height: 920 }, args: ['--enable-unsafe-webgpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] });
await ctx.addInitScript(() => { const gi = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return typeof k === 'string' && k.startsWith('carver:modelsReady') ? '1' : gi.call(this, k); }; });
const page = ctx.pages()[0];
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('dialog', (d) => d.accept());
const until = async (fn, what, s = 300, arg) => { const t = Date.now(); while (Date.now() - t < s * 1000) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; await page.waitForTimeout(200); } throw new Error('timeout ' + what); };
const cancelTx = () => page.evaluate(() => { const S = window.__carver; if (S.task?.kind === 'transcribe' || S.task?.kind === 'models') S.task.cancel?.(); });
const exact = () => until(() => { const m = window.__carver.master; return m && m.lufs != null && !window.__carver.live.measuring ? { lufs: m.lufs, aim: m.opt.targetLufs, thr: m.comp.thresholdDb, ratio: m.comp.ratio, makeup: m.makeupDb, mode: m.mode, compManual: !!m.compManual, makeupAuto: m.makeupAuto } : 0; }, 'exact', 120);
const settle = async () => { await page.waitForTimeout(1200); return exact(); };
await page.goto('http://127.0.0.1:5300/'); await page.waitForTimeout(600);
const res = { modes: {} };
for (const mode of ['aggressive', 'medium', 'soft']) {
  await page.evaluate((m) => { const S = window.__carver; if (S.project) S.closeProject(); S.setGainMode(m); }, mode);
  await page.setInputFiles('#carver-file-input', video);
  await until(() => { const S = window.__carver; return S.pcm && S.master && S.task?.kind !== 'extract'; }, 'auto master', 600);
  for (let i = 0; i < 30; i++) { await cancelTx(); await page.waitForTimeout(200); }
  res.modes[mode] = await settle();
  console.log(mode, JSON.stringify(res.modes[mode]));
}
// in-project behaviour (project made with 'soft')
const st = {};
await page.evaluate(() => window.__carver.setGainMode('aggressive'));
st.autoToAggr = await settle();
await page.evaluate(() => window.__carver.setCompressorNow({ thresholdDb: -7 }));
await settle();
await page.evaluate(() => window.__carver.setGainMode('medium'));
st.manualCompThenMedium = await settle();
await page.evaluate(() => window.__carver.setMakeupNow(3));
await settle();
await page.evaluate(() => window.__carver.setGainMode('soft'));
st.manualMakeupThenSoft = await settle();
await page.evaluate(() => window.__carver.resetCompressor());
st.reset = await settle();
await page.waitForTimeout(800);
await page.reload(); await page.waitForTimeout(800);
const name = await page.evaluate(() => 0);
void name;
st.afterReloadPrefs = await page.evaluate(() => JSON.parse(localStorage.getItem('carver:prefs')).gainMode);
// settings UI
await page.evaluate(() => { const S = window.__carver; S.openSettings?.('audio'); });
res.inProject = st;
for (const [k, v] of Object.entries(st)) console.log(k, JSON.stringify(v));
writeFileSync(join(outDir, 'gain-mode.json'), JSON.stringify(res, null, 1));
await ctx.close();
