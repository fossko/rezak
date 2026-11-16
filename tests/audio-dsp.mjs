// Audio DSP test bench (fork `audio-dsp`): timings of loudness processing, accuracy of the fast waveform
// envelope, live compressor latency, export loudness. Runs against the BUILT app (vite preview on 5200).
// Usage: node tests/audio-dsp.mjs <video> [--project=<file.carver.json>] --steps=fresh,import,apply,...
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3);
const url = opt('url', 'http://127.0.0.1:5200/');
const steps = opt('steps', 'fresh').split(',');
const projectFile = opt('project', '');
const headed = args.includes('--headed');
const tmp = process.env.TMPDIR || '/tmp';
const outDir = join(tmp, 'carver-test-out');
mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(join(tmp, 'carver-test-profile'), {
  channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: !headed, acceptDownloads: true, downloadsPath: outDir,
  viewport: { width: 1500, height: 920 },
  args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
});
// never start the 2.2 GB model download from this bench (the disk is nearly full; transcription is not tested here)
await ctx.addInitScript(() => {
  const gi = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) { return typeof k === 'string' && k.startsWith('carver:modelsReady') ? '1' : gi.call(this, k); };
});
const page = ctx.pages()[0] || await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /\[carver\]/.test(t)) console.log('  page', `[${m.type()}]`, t.slice(0, 500)); });
page.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
page.on('dialog', (d) => d.accept());
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const shot = (n) => page.screenshot({ path: join(outDir, n + '.png') });
const results = {};
async function until(fn, what, timeoutS = 600, arg) {
  const t = Date.now();
  while (Date.now() - t < timeoutS * 1000) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await page.waitForTimeout(250);
  }
  throw new Error('timeout: ' + what);
}
const cancelTranscription = () => page.evaluate(() => { const S = window.__carver; if (S.task?.kind === 'transcribe' || S.task?.kind === 'models') S.task.cancel?.(); });

await page.goto(url);
await page.waitForTimeout(500);

const masterReady = () => { const S = window.__carver; return S.master && S.master.lufs != null ? Date.now() : 0; };

if (steps.includes('fresh')) {
  // the user's main flow: open a new file → extraction → automatic loudness processing → transcription
  await page.evaluate(() => { if (window.__carver.project) window.__carver.closeProject(); });
  const t0 = Date.now();
  await page.setInputFiles('#carver-file-input', video);
  const tx = await until(() => { const S = window.__carver; return S.pcm && S.task?.kind !== 'extract' ? Date.now() : 0; }, 'extraction', 900);
  const tm = await until(() => { const S = window.__carver; return S.master || S.task?.kind === 'transcribe' ? Date.now() : 0; }, 'auto master', 900);
  const tt = await until(() => { const S = window.__carver; return S.task?.kind === 'transcribe' || S.task?.kind === 'models' ? Date.now() : 0; }, 'transcription start', 900);
  // the audio settings must be usable DURING transcription, before the first words arrive
  await page.evaluate(() => { window.__carverLongTasks = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__carverLongTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); });
  await page.evaluate(() => window.__carver.setSideTab('audio')); await page.waitForTimeout(400);
  const during = await page.evaluate(() => ({ task: window.__carver.task?.kind, words: window.__carver.project.words.length,
    lufs: document.querySelector('[data-testid=lufs]')?.textContent ?? null, knobs: document.querySelectorAll('[data-knob]').length,
    variants: [...document.querySelectorAll('[data-variant]')].map((e) => e.getAttribute('data-variant')) }));
  during.rafMs = await page.evaluate(() => new Promise((res) => { const t = []; const f = (x) => { t.push(x); if (t.length < 30) requestAnimationFrame(f); else { const d = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b); res({ median: Math.round(d[14]), max: Math.round(d[d.length - 1]) }); } }; requestAnimationFrame(f); }));
  during.drawMs = await page.evaluate(() => window.__carverTimeline.lastDrawMs ?? null);
  const ms = [];
  for (const v of [-22, -18, -25, -12, -20, -28, -16, -22]) {
    const r0 = await page.evaluate(() => window.__carverTimeline.drawnRev);
    const tk = Date.now();
    await page.locator('[data-knob=thresholdDb] input').fill(String(v));
    await until((r) => window.__carverTimeline.drawnRev > r, 'redraw', 30, r0);
    ms.push(Date.now() - tk);
    during.trace = (during.trace || []).concat([await page.evaluate(() => ({ model: Math.round(window.__carver.live.lastModelMs), lt: window.__carverLongTasks?.splice(0) }))]);
    await page.waitForTimeout(250);
  }
  ms.sort((a, b) => a - b);
  during.sliderRedrawMs = { median: ms[ms.length >> 1], max: ms[ms.length - 1], all: ms };
  during.thresholdNow = await page.evaluate(() => window.__carver.master.comp.thresholdDb);
  during.stillTranscribing = await page.evaluate(() => window.__carver.task?.kind);
  await shot('dsp-audio-during-transcribe');
  console.log(el(), 'during transcription:', JSON.stringify(during));
  results.duringTranscribe = during;
  await cancelTranscription();
  { const ms = [];
    for (const v of [-22, -18, -25, -12, -20, -28, -16, -22]) {
      const r0 = await page.evaluate(() => window.__carverTimeline.drawnRev); const tk = Date.now();
      await page.locator('[data-knob=thresholdDb] input').fill(String(v));
      await until((r) => window.__carverTimeline.drawnRev > r, 'redraw', 30, r0); ms.push(Date.now() - tk); await page.waitForTimeout(250);
    }
    ms.sort((a, b) => a - b); console.log(el(), 'same, transcription stopped:', JSON.stringify(ms)); }
  const te = await until(masterReady, 'exact measurement', 900);
  const r = await page.evaluate(() => { const S = window.__carver, m = S.master; return { dur: S.project.media.duration, base: S.audioBase?.integrated, model: m?.modelLufs, exact: m?.lufs, tp: m?.tp, opt: m?.opt, modelMs: S.live.lastModelMs, phrases: m?.phrases.length, words: S.project.words.length, makeupDb: m?.makeupDb, trim: m?.trim }; });
  results.fresh = { extractS: (tx - t0) / 1000, masterAppliedS: (tm - tx) / 1000, transcribeStartsAfterExtractS: (tt - tx) / 1000, exactLufsAfterS: (te - tx) / 1000, ...r };
  console.log(el(), 'fresh:', JSON.stringify(results.fresh));
  await shot('dsp-fresh');
}

if (steps.includes('import')) {
  // the transcribed project of the same file (words → real phrases), then link the video
  await page.evaluate(() => { if (window.__carver.project) window.__carver.closeProject(); });
  await page.reload(); await page.waitForTimeout(700);
  await page.setInputFiles('input[accept=".json,application/json"]', projectFile);
  await until(() => window.__carver.project && window.__carver.needsFile, 'project import', 60);
  await page.setInputFiles('#carver-link-input', video);
  await until(() => { const S = window.__carver; return S.pcm && !S.needsFile && S.task?.kind !== 'extract' && S.task?.kind !== 'open'; }, 'link + extract', 900);
  await cancelTranscription();
  console.log(el(), 'imported:', JSON.stringify(await page.evaluate(() => ({ words: window.__carver.project.words.length, dur: window.__carver.project.media.duration }))));
}

if (steps.includes('apply')) {
  // choose «Сильно громче» on the transcribed words: wave/model instantly, exact LUFS in the background
  await page.evaluate(() => window.__carver.setSideTab('audio'));
  await until(() => window.__carver.audioBase, 'analysis', 300);
  await page.evaluate(() => window.__carver.revertMaster());
  const r = await page.evaluate(async () => {
    const S = window.__carver, t = performance.now();
    await S.applyMaster({ kind: 'leveler', maxGainDb: 15, targetLufs: -14 });
    return { applyMs: Math.round(performance.now() - t), modelMs: Math.round(S.live.lastModelMs), model: S.master.modelLufs, phrases: S.master.phrases.length };
  });
  const t1 = Date.now();
  await until(masterReady, 'exact', 900);
  const r2 = await page.evaluate(() => { const m = window.__carver.master; return { exact: m.lufs, tp: m.tp, bias: m.bias, makeupDb: m.makeupDb, trim: m.trim, capped: m.capped, modelAfter: m.modelLufs, maxGrModel: m.maxGrDb, maxGrExact: m.exactGrDb }; });
  results.apply = { ...r, exactAfterS: (Date.now() - t1) / 1000, ...r2 };
  console.log(el(), 'apply:', JSON.stringify(results.apply));
  await shot('dsp-applied');
}

if (steps.includes('leveler')) {
  // phrase leveling is a setting, off by default: compressor + make-up only, flat curve
  const st = () => page.evaluate(() => { const m = window.__carver.master; return { pref: JSON.parse(localStorage.getItem('carver:prefs') || '{}').phraseLeveler ?? null, leveler: m.opt.leveler, curvePts: m.curve.length, trim: +m.trim.toFixed(2), makeupDb: +m.makeupDb.toFixed(2), model: +m.modelLufs.toFixed(2), exact: m.lufs == null ? null : +m.lufs.toFixed(2), capped: m.capped, gainAt1000: window.__carver.masterLeveler.gainAt(1000) }; });
  results.leveler = { off: await st() };
  await page.evaluate(() => window.__carver.setPhraseLeveler(true)); await until(masterReady, 'exact', 300);
  results.leveler.on = await st();
  await page.evaluate(() => window.__carver.setPhraseLeveler(false)); await until(masterReady, 'exact', 300);
  results.leveler.offAgain = await st();
  await page.evaluate(() => window.__carver.openSettings('audio')); await page.waitForTimeout(300);
  results.leveler.settingsText = (await page.locator('text=Выравнивание громкости по фразам').count()) + ' checkbox, checked=' + await page.locator('label:has-text("Выравнивание громкости по фразам") input').isChecked();
  await shot('dsp-settings-leveler'); await page.evaluate(() => window.__carver.openSettings(null));
  await page.evaluate(() => window.__carver.setSideTab('audio')); await page.waitForTimeout(300);
  results.leveler.variants = await page.locator('[data-variant]').evaluateAll((els) => els.map((e) => e.getAttribute('data-variant')));
  await shot('dsp-audio-comp-only');
  console.log(el(), 'leveler:', JSON.stringify(results.leveler));
}

if (steps.includes('panel')) {
  const ui = () => page.evaluate(() => ({ howTo: document.body.innerText.includes('Как выровнять'), variants: [...document.querySelectorAll('[data-variant]')].map((e) => e.getAttribute('data-variant')),
    compressor: document.querySelectorAll('[data-knob]').length, applied: !!window.__carver.master, lufs: document.querySelector('[data-testid=lufs]')?.textContent }));
  await page.evaluate(() => window.__carver.setSideTab('audio')); await page.waitForTimeout(300);
  results.panel = { on: await ui() };
  await shot('dsp-audio-panel');
  await page.evaluate(() => window.__carver.revertMaster()); await page.waitForTimeout(300);
  results.panel.reverted = await ui();
  await page.locator('button:has-text("Включить обработку")').click();
  await until(() => window.__carver.master, 'applied', 30); await page.waitForTimeout(300);
  results.panel.reenabled = await ui();
  await page.evaluate(() => window.__carver.setPhraseLeveler(true)); await page.waitForTimeout(300);
  results.panel.levelerOn = await ui();
  await page.evaluate(() => window.__carver.setPhraseLeveler(false)); await page.waitForTimeout(300);
  console.log(el(), 'panel:', JSON.stringify(results.panel));
}

if (steps.includes('duck')) {
  const R = {};
  await page.evaluate(() => window.__carver.setSideTab('audio')); await page.waitForTimeout(300);
  R.ui = await page.evaluate(() => ({ section: !!document.querySelector('[data-testid=duck]'), sliders: [...document.querySelectorAll('[data-duck]')].map((e) => e.getAttribute('data-duck')),
    beforeCompressor: (() => { const t = document.body.innerText; return t.indexOf('Приглушение тишины') >= 0 && t.indexOf('Приглушение тишины') < t.indexOf('Компрессор'); })() }));
  // fixed make-up so the before/after difference is the ducking alone
  await page.evaluate(() => window.__carver.setMakeupNow(window.__carver.master.makeupDb));
  await until(masterReady, 'exact', 300);
  const before = await page.evaluate(() => { const S = window.__carver; window.__ex0 = window.__carverDebug.exactLevels(); return { lufs: S.master.lufs, thr: S.project.silence.thresholdDb }; });
  const ms = [];
  for (const v of [-6, -12, -18, -12]) {
    const r0 = await page.evaluate(() => window.__carverTimeline.drawnRev);
    await page.evaluate((v) => { window.__mt = performance.now(); window.__carver.setDuck({ depthDb: v }); }, v);
    await until((r) => window.__carverTimeline.drawnRev > r, 'redraw', 30, r0);
    ms.push(await page.evaluate(() => Math.round(window.__carverTimeline.drawnAt - window.__mt)));
  }
  await page.locator('[data-duck=attackMs] input').fill('40'); await page.locator('[data-duck=releaseMs] input').fill('60'); await page.waitForTimeout(200);
  ms.sort((a, b) => a - b); R.redrawMs = { median: ms[ms.length >> 1], max: ms[ms.length - 1] };
  await until(masterReady, 'exact', 300);
  Object.assign(R, await page.evaluate(() => {
    const S = window.__carver, st = S.master, at = S.masterLeveler.dbAt, regs = S.duckRegions();
    const long = regs.find((r) => r.end - r.start > 0.4 && r.start > 60), short = regs.find((r) => r.end - r.start > 0.04 && r.end - r.start < 0.08 && r.start > 60);
    const f = (t) => +at(t).toFixed(2);
    const env = { dur: +(long.end - long.start).toFixed(3), before5ms: f(long.start - 0.005), atStart: f(long.start), start20ms: f(long.start + 0.02), afterAttack: f(long.start + 0.04),
      mid: f((long.start + long.end) / 2), releaseStart: f(long.end - 0.06), release30ms: f(long.end - 0.03), atEnd: f(long.end), after5ms: f(long.end + 0.005) };
    // short stretch: attack/release shrink 40:60, the deepest point is at start + dur*0.4
    const sd = short.end - short.start;
    const shortEnv = { dur: +sd.toFixed(3), deepest: f(short.start + sd * 0.4), expected: +(-12 * sd / 0.1).toFixed(2), end: f(short.end) };
    // exact render: level inside the long stretch vs before; speech next to it unchanged
    const ex1 = window.__carverDebug.exactLevels(), ex0 = window.__ex0;
    const avg = (a, t0, t1) => { let s = 0, n = 0; for (let k = Math.ceil(t0 / 0.01); k < Math.floor(t1 / 0.01); k++) { s += a[k]; n++; } return s / n; };
    const inA = long.start + 0.05, inB = long.end - 0.07;
    const exact = { quietDeltaDb: +(avg(ex1, inA, inB) - avg(ex0, inA, inB)).toFixed(2),
      speechBeforeDeltaDb: +(avg(ex1, long.start - 0.3, long.start - 0.01) - avg(ex0, long.start - 0.3, long.start - 0.01)).toFixed(2),
      speechAfterDeltaDb: +(avg(ex1, long.end + 0.01, long.end + 0.3) - avg(ex0, long.end + 0.01, long.end + 0.3)).toFixed(2) };
    // whole file: blocks the curve leaves at 0 dB must not change; fully ducked blocks drop by the depth
    { const d0 = [], dd = [];
      for (let k = 0; k < ex1.length; k++) { const a = at(k * 0.01), b = at(k * 0.01 + 0.005), c = at(k * 0.01 + 0.01);
        if (a === 0 && b === 0 && c === 0 && ex0[k] > -60) d0.push(ex1[k] - ex0[k]); else if (a === -12 && c === -12 && ex0[k] > -85) dd.push(ex1[k] - ex0[k]); }
      const st2 = (x) => { x.sort((p, q) => p - q); return { n: x.length, median: +x[x.length >> 1].toFixed(2), p5: +x[Math.floor(x.length * 0.05)].toFixed(2), p95: +x[Math.floor(x.length * 0.95)].toFixed(2) }; };
      exact.untouchedBlocks = st2(d0); exact.duckedBlocks = st2(dd); }
    let tot = 0; for (const r of regs) tot += r.end - r.start;
    return { regions: st.duckRegions, regionsTotalS: Math.round(tot), duck: st.duck, env, shortEnv, exact, curvePts: st.full.length, lufsAfter: st.lufs };
  }));
  R.lufsBefore = before.lufs;
  await page.evaluate((t) => window.__carver.setSilence({ thresholdDb: t + 4 }), before.thr); await page.waitForTimeout(300);
  R.thrPlus4 = await page.evaluate(() => { let t = 0; for (const r of window.__carver.duckRegions()) t += r.end - r.start; return { regions: window.__carver.master.duckRegions, totalS: Math.round(t) }; });
  await page.evaluate((t) => window.__carver.setSilence({ thresholdDb: t }), before.thr); await page.waitForTimeout(300);
  await shot('dsp-duck');
  await page.evaluate(() => window.__carver.saveNow()); await page.waitForTimeout(500);
  await page.reload(); await page.waitForTimeout(800);
  await page.locator('.pitem', { hasText: video.split('/').pop().replace(/\.[^.]+$/, '') }).first().click();
  await until(() => window.__carver.master, 'restored master', 300);
  R.afterReload = await page.evaluate(() => ({ duck: window.__carver.master.duck, regions: window.__carver.master.duckRegions, pts: window.__carver.master.full.length, savedCurvePts: window.__carver.project.master.curve.length }));
  results.duck = R;
  console.log(el(), 'duck:', JSON.stringify(R));
}

if (steps.includes('silcolor')) {
  // the user's scenario: make-up 0 → threshold over the breaths → ducking → make-up up. Breaths must stay grey.
  await page.evaluate(() => window.__carver.setSideTab('audio'));
  const scan = () => page.evaluate(() => {
    const S = window.__carver, T = window.__carverTimeline, thr = S.project.silence.thresholdDb;
    const c = [...document.querySelectorAll('canvas')].find((e) => e.clientWidth === T.W);
    const dpr = devicePixelRatio, W = T.W, H = c.clientHeight, top = 18, mh = H - top - 18;
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const lv = S.levelsView, raw = S.levels, f0 = Math.max(0, Math.floor(T.v0 / 0.01)), f1 = Math.min(lv.length, Math.ceil((T.v0 + T.span) / 0.01)), per = Math.max(1, (f1 - f0) / W);
    const regs = S.edl.regions;
    const yOf = (db) => top + mh * (1 - (Math.max(-60, Math.min(0, db)) + 60) / 60);
    const isGrey = (r, g, b) => Math.abs(r - 0x56) < 6 && Math.abs(g - 0x62) < 6 && Math.abs(b - 0x70) < 6;
    const out = { boostedQuiet: 0, boostedQuietGrey: 0, loud: 0, loudGrey: 0 };
    for (let px = 330; px < W; px++) {
      const a = Math.floor(f0 + px * per), b = Math.min(f1, Math.floor(f0 + (px + 1) * per));
      let m = -120, mr = -120; for (let k = a; k < Math.max(a + 1, b); k++) { if (lv[k] > m) m = lv[k]; if (raw[k] > mr) mr = raw[k]; }
      const t = (a + 0.5) * 0.01; if (regs.some((r) => t >= r.a - 0.02 && t < r.b + 0.02)) continue;
      // a pixel well inside the bar, away from the dashed threshold line
      let yy = Math.round((yOf(m) + top + mh) / 2); if (Math.abs(yy - yOf(thr)) < 3) yy += 4;
      const i = (Math.round(yy * dpr) * c.width + Math.floor(px * dpr)) * 4, grey = isGrey(img[i], img[i + 1], img[i + 2]);
      if (mr < thr - 1 && m > thr + 3) { out.boostedQuiet++; if (grey) out.boostedQuietGrey++; else if ((out.samples ||= []).length < 6) out.samples.push([px, +m.toFixed(1), +mr.toFixed(1), Math.round(yy), Math.round(yOf(m)), img[i], img[i + 1], img[i + 2], img[i + 3]]); }
      else if (mr > thr + 1) { out.loud++; if (grey) out.loudGrey++; }
    }
    out.col354 = 0 && (() => { const r = []; let prev = ''; for (let y = 0; y < c.height; y++) { const i = (y * c.width + 354) * 4, k = img.slice(i, i + 4).join(','); if (k !== prev) { r.push(y + ':' + k); prev = k; } } return r.join(' '); })(); out.canvases = [...document.querySelectorAll('canvas')].map((e) => e.clientWidth + 'x' + e.clientHeight); out.v0 = T.v0; out.span = T.span; out.thr = thr; out.H = H; out.yThr = Math.round(yOf(thr)); return out;
  });
  const R = {};
  await page.evaluate(() => { const S = window.__carver, T = window.__carverTimeline; T.span = 60; T.v0 = 1800; T.dirty = true; S.setMakeupNow(0); S.setDuckNow({ depthDb: -10, attackMs: 30, releaseMs: 30 }); });
  await page.waitForTimeout(800);
  R.makeup0 = await scan();
  await page.evaluate(() => { window.__carver.setMakeupNow(24); window.__carverTimeline.dirty = true; });
  await page.waitForTimeout(800);
  R.makeup24 = await scan();
  await shot('dsp-silcolor-makeup24');
  results.silcolor = R;
  console.log(el(), 'silcolor:', JSON.stringify(R));
}

if (steps.includes('defaults')) {
  const R = {};
  await until(masterReady, 'exact', 300); await page.waitForTimeout(6000); await until(masterReady, 'exact', 300);
  R.auto = await page.evaluate(() => { const m = window.__carver.master; return { aim: m.opt.targetLufs, lufs: +m.lufs.toFixed(2), makeup: +m.makeupDb.toFixed(2), comp: m.comp, duck: m.duck ?? null, duckRegions: m.duckRegions }; });
  await page.evaluate(() => window.__carver.setSideTab('audio')); await page.waitForTimeout(300);
  R.ui = await page.evaluate(() => ({ label: document.querySelector('[data-makeup-auto]')?.innerText, knobs: [...document.querySelectorAll('[data-knob],[data-duck]')].map((e) => e.innerText.replace(/\s+/g, ' ')) }));
  await page.evaluate(() => window.__carver.setMakeupNow(3)); await page.waitForTimeout(500);
  await page.locator('[data-makeup-auto] input').click();
  await page.waitForTimeout(500); await until(masterReady, 'exact', 300); await page.waitForTimeout(6000); await until(masterReady, 'exact', 300);
  R.afterAutoClick = await page.evaluate(() => { const m = window.__carver.master; return { auto: m.makeupAuto !== false, lufs: +m.lufs.toFixed(2), makeup: +m.makeupDb.toFixed(2) }; });
  results.defaults = R; console.log(el(), 'defaults:', JSON.stringify(R));
}

if (steps.includes('makeup')) {
  const st = () => page.evaluate(() => { const m = window.__carver.master; return { auto: m.makeupAuto !== false, makeupDb: +m.makeupDb.toFixed(2), model: +m.modelLufs.toFixed(2), exact: m.lufs == null ? null : +m.lufs.toFixed(2), chainMakeup: window.__carver.live.chain.makeupDb, ui: document.querySelector('[data-knob=makeupDb] .mono')?.textContent, autoBox: document.querySelector('[data-makeup-auto] input')?.checked }; });
  await page.evaluate(() => window.__carver.setSideTab('audio')); await page.waitForTimeout(300);
  results.makeup = { auto: await st() };
  const ms = [];
  for (const v of [6, 10, 3, 14, 8, 6]) {
    const r0 = await page.evaluate(() => window.__carverTimeline.drawnRev);
    const t = await page.evaluate((v) => { window.__mt = performance.now(); window.__carver.setMakeup(v); return 0; }, v);
    await until((r) => window.__carverTimeline.drawnRev > r, 'redraw', 30, r0);
    ms.push(await page.evaluate(() => Math.round(window.__carverTimeline.drawnAt - window.__mt)));
  }
  ms.sort((a, b) => a - b);
  results.makeup.redrawMs = { median: ms[ms.length >> 1], max: ms[ms.length - 1] };
  await until(masterReady, 'exact', 300);
  results.makeup.manual6 = await st();
  await page.locator('[data-knob=makeupDb] input').fill('9'); await page.waitForTimeout(150);
  await until(masterReady, 'exact', 300);
  results.makeup.sliderUi9 = await st();
  await shot('dsp-makeup-manual');
  await page.evaluate(() => window.__carver.saveNow()); await page.waitForTimeout(500);
  await page.reload(); await page.waitForTimeout(800);
  await page.locator('.pitem', { hasText: video.split('/').pop().replace(/\.[^.]+$/, '') }).first().click();
  await until(() => window.__carver.master, 'restored master', 300);
  await page.evaluate(() => window.__carver.setSideTab('audio')); await page.waitForTimeout(300);
  await until(masterReady, 'exact', 300);
  results.makeup.afterReload = await st();
  await page.locator('[data-makeup-auto] input').check(); await page.waitForTimeout(150);
  await until(masterReady, 'exact', 300);
  results.makeup.backToAuto = await st();
  console.log(el(), 'makeup:', JSON.stringify(results.makeup));
}

if (steps.includes('accuracy')) {
  // block model vs the exact chain, over the whole file, for several compressor settings
  const settings = [
    { thresholdDb: -5, ratio: 5, attackMs: 8, releaseMs: 120 },
    { thresholdDb: -15, ratio: 4, attackMs: 8, releaseMs: 120 },
    { thresholdDb: -20, ratio: 10, attackMs: 2, releaseMs: 60 },
    { thresholdDb: -12, ratio: 3, attackMs: 30, releaseMs: 400 },
  ];
  results.accuracy = [];
  for (const c of settings) {
    const r = await page.evaluate((c) => {
      const S = window.__carver;
      S.setCompressorNow(c);
      const model = S.live.levels, t = performance.now(), exact = window.__carverDebug.exactLevels(), exactMs = performance.now() - t;
      // per-block error over speech; and the error a 1500 px overview would show (max per pixel)
      let n = 0, sum = 0, big = 0; const errs = [];
      for (let k = 0; k < exact.length; k++) {
        if (exact[k] < -50) continue;
        const e = model[k] - exact[k]; sum += Math.abs(e); n++; if (Math.abs(e) > 3) big++;
        if ((k & 7) === 0) errs.push(Math.abs(e));
      }
      errs.sort((a, b) => a - b);
      const px = 1500, per = exact.length / px; let pe = 0, pmax = 0, pn = 0;
      for (let x = 0; x < px; x++) {
        let mm = -120, me = -120;
        for (let k = Math.floor(x * per); k < Math.floor((x + 1) * per); k++) { if (model[k] > mm) mm = model[k]; if (exact[k] > me) me = exact[k]; }
        if (me < -50) continue; const e = Math.abs(mm - me); pe += e; pn++; if (e > pmax) pmax = e;
      }
      return { c, meanAbsDb: +(sum / n).toFixed(2), p95Db: +errs[Math.floor(errs.length * 0.95)].toFixed(2), over3dB: +(big / n * 100).toFixed(2) + '%',
        overviewMeanDb: +(pe / pn).toFixed(2), overviewMaxDb: +pmax.toFixed(2), exactFullRenderMs: Math.round(exactMs), modelMs: +S.live.lastModelMs.toFixed(1), modelLufs: S.master.modelLufs };
    }, c);
    // exact LUFS for this setting (the worker), to check the model's loudness prediction
    await until(masterReady, 'exact', 900);
    r.exactLufs = await page.evaluate(() => window.__carver.master.lufs);
    r.modelLufsFinal = await page.evaluate(() => window.__carver.master.modelLufs);
    results.accuracy.push(r);
    console.log(el(), 'accuracy:', JSON.stringify(r));
  }
  await page.evaluate(() => window.__carver.setCompressorNow({ thresholdDb: -5, ratio: 5, attackMs: 8, releaseMs: 120 }));
  await until(masterReady, 'exact', 900);
}

if (steps.includes('live')) {
  // drag the threshold slider like a user: input events → model → canvas redraw; then tiles render in
  await page.evaluate(() => window.__carver.setSideTab('audio'));
  await page.waitForTimeout(300);
  const zooms = [{ name: 'whole file', span: 1e9 }, { name: '5 min', span: 300 }, { name: '20 s', span: 20 }, { name: '2 s (samples)', span: 2 }];
  results.live = [];
  const slider = page.locator('[data-knob="thresholdDb"] input');
  for (const z of zooms) {
    await page.evaluate((span) => { const T = window.__carverTimeline, S = window.__carver; T.span = Math.min(span, S.project.media.duration); T.v0 = Math.min(1800, S.project.media.duration - T.span); if (T.v0 < 0) T.v0 = 0; T.dirty = true; }, z.span);
    await page.waitForTimeout(400);
    const lat = [];
    for (let i = 0; i < 12; i++) {
      const v = -6 - i;
      const r = await page.evaluate(async (v) => {
        const S = window.__carver, T = window.__carverTimeline;
        const el = document.querySelector('[data-knob="thresholdDb"] input');
        const t0 = performance.now(), rev0 = S.masterRev;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, String(v));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        while (!(S.masterRev > rev0 && T.drawnRev === S.masterRev)) await new Promise((r) => requestAnimationFrame(r));
        const drawn = performance.now() - t0;
        return { drawn, model: S.live.lastModelMs };
      }, v);
      lat.push(r);
    }
    // exact tiles for the visible range after the last change
    const tiles = await page.evaluate(async () => {
      const S = window.__carver, T = window.__carverTimeline, L = S.live, t0 = performance.now();
      const need = () => { const b0 = Math.floor(T.v0 / 0.01 / 6000), b1 = Math.floor(((T.v0 + T.span) / 0.01 - 1) / 6000); for (let t = b0; t <= Math.min(b1, L.covered.length - 1); t++) if (!L.covered[t]) return false; return true; };
      if (T.span / T.W < 0.012) return { ms: 0, samples: true };
      while (!need()) { if (performance.now() - t0 > 120000) return { ms: -1 }; await new Promise((r) => setTimeout(r, 20)); }
      return { ms: Math.round(performance.now() - t0) };
    });
    const d = lat.map((x) => x.drawn).sort((a, b) => a - b);
    const r = { zoom: z.name, drawMedianMs: +d[d.length >> 1].toFixed(1), drawMaxMs: +d[d.length - 1].toFixed(1), modelMs: +(lat.reduce((s, x) => s + x.model, 0) / lat.length).toFixed(1), exactVisibleMs: tiles.ms, samples: !!tiles.samples };
    results.live.push(r);
    console.log(el(), 'live:', JSON.stringify(r));
    await shot('dsp-live-' + z.name.replace(/\W+/g, '_'));
  }
  // real slider drag with the mouse (whole file view) for the screenshot / smoothness
  await page.evaluate(() => { const T = window.__carverTimeline, S = window.__carver; T.span = S.project.media.duration; T.v0 = 0; T.dirty = true; });
  const box = await slider.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2); await page.mouse.down();
    const t0 = Date.now();
    for (let i = 0; i <= 30; i++) { await page.mouse.move(box.x + box.width * (0.8 - i * 0.015), box.y + box.height / 2); }
    await page.mouse.up();
    results.drag = { steps: 31, ms: Date.now() - t0, draws: await page.evaluate(() => window.__carverTimeline.draws) };
    console.log(el(), 'drag:', JSON.stringify(results.drag));
  }
  await page.waitForTimeout(300); await shot('dsp-drag-model');
  await until(masterReady, 'exact', 900);
  await page.waitForTimeout(500); await shot('dsp-drag-exact');
}

if (steps.includes('play')) {
  // a compressor change during playback is heard within ~0.1 s (audio re-sync, no restart)
  const r = await page.evaluate(async () => {
    const S = window.__carver, P = window.__carverPlayer;
    P.seek(600); P.play(); await new Promise((r) => setTimeout(r, 1500));
    const f0 = P.refreshes, b0 = P.masterBuffers, st0 = { ...P.stats };
    S.setCompressorNow({ thresholdDb: -18 }); await new Promise((r) => setTimeout(r, 1200));
    S.setCompressorNow({ thresholdDb: -10 }); await new Promise((r) => setTimeout(r, 1200));
    const cur = P.current; P.pause();
    return { refreshes: P.refreshes - f0, processedBuffers: P.masterBuffers - b0, playing: cur > 600, late: P.stats.late - st0.late, pos: cur };
  });
  results.play = r;
  console.log(el(), 'play:', JSON.stringify(r));
  await page.evaluate(() => window.__carver.setCompressorNow({ thresholdDb: -5 }));
}

if (steps.includes('persist')) {
  // the processing is project state now: it must survive a reload
  const before = await page.evaluate(() => { const m = window.__carver.master; return m && { comp: m.comp, trim: m.trim, pts: m.curve.length, lufs: m.lufs }; });
  await page.evaluate(() => window.__carver.saveNow());
  await page.waitForTimeout(500);
  await page.reload(); await page.waitForTimeout(800);
  await page.locator('.pitem', { hasText: video.split('/').pop().replace(/\.[^.]+$/, '') }).first().click();
  await until(() => window.__carver.master, 'restored master', 300);
  const after = await page.evaluate(() => { const m = window.__carver.master; return { comp: m.comp, trim: m.trim, pts: m.curve.length, leveler: m.opt.leveler }; });
  await until(masterReady, 'exact after reload', 900);
  const lufs = await page.evaluate(() => window.__carver.master.lufs);
  results.persist = { before, after: { ...after, lufs } };
  console.log(el(), 'persist:', JSON.stringify(results.persist));
}

if (steps.includes('tiledebug')) {
  await page.evaluate(() => window.__carver.setSideTab('audio'));
  for (const span of [1e9, 300]) {
    await page.evaluate((span) => { const T = window.__carverTimeline, S = window.__carver; T.span = Math.min(span, S.project.media.duration); T.v0 = span > 1e8 ? 0 : 1800; T.dirty = true; }, span);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__carver.setCompressorNow({ thresholdDb: -9 }));
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500);
      console.log(span, JSON.stringify(await page.evaluate(() => { const T = window.__carverTimeline, L = window.__carver.live; return { v0: T.v0, span: T.span, W: T.W, cov: Array.from(L.covered).map((x, i) => x ? i : -1).filter((x) => x >= 0).join(','), req: Array.from(L.requested).map((x, i) => x ? i : -1).filter((x) => x >= 0).join(',') }; })));
    }
  }
}

if (steps.includes('export')) {
  // the only full-length render: MP3 of the carved programme, then its loudness measured in the page.
  // The meter describes the SOURCE timeline; the export is the cut programme, so compare against the
  // exact chain measured over the kept segments only (computed here the same way).
  if (await page.evaluate(() => !!window.__carver.needsFile)) {
    await page.setInputFiles('#carver-link-input', video);
    await until(() => { const S = window.__carver; return S.media && !S.needsFile && S.task?.kind !== 'extract' && S.task?.kind !== 'open'; }, 'relink', 900);
    await cancelTranscription();
  }
  await page.evaluate(() => { window.__carverTestHandle = async () => (await navigator.storage.getDirectory()).getFileHandle('export.mp3', { create: true }); });
  await page.evaluate(() => window.__carver.setSideTab('export'));
  await page.waitForTimeout(400);
  const t0 = Date.now();
  await page.getByRole('button', { name: /Экспортировать MP3/ }).click();
  await page.waitForTimeout(1500);
  console.log(el(), 'task after click:', await page.evaluate(() => window.__carver.task?.kind + ' ' + window.__carver.task?.text));
  await until(() => window.__carver.task?.kind !== 'export' ? 1 : 0, 'mp3 export', 3600);
  console.log(el(), 'task after export:', await page.evaluate(() => window.__carver.task?.kind ?? 'none'));
  await cancelTranscription();
  const exportS = (Date.now() - t0) / 1000;
  const r = await page.evaluate(async () => {
    const S = window.__carver, f = await (await (await navigator.storage.getDirectory()).getFileHandle('export.mp3')).getFile();
    const file = await window.__carverDebug.measureFile(f);
    return { bytes: f.size, file, meterSource: S.master.lufs, outDuration: S.edl.outDuration, cuts: S.edl.segments.length };
  });
  results.export = { exportS, ...r };
  console.log(el(), 'export:', JSON.stringify(results.export));
}

writeFileSync(join(outDir, 'audio-dsp.json'), JSON.stringify(results, null, 1));
await ctx.close();
