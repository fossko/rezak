// «Реставрация» test bench (Sidon). Runs against the BUILT app (vite preview on 5300).
// node tests/restore.mjs <video> [--steps=open,gate,load,preview,play,export] [--block-hf] [--clear-cache] [--headed]
//   gate    — restoration at 0 loads nothing; enabling during a task waits (toast + status), starts after it
//   load    — model download (HF, or the ./models mirror with --block-hf) + WebGPU init; timings
//   preview — tiles render ahead of the playhead only (not the whole file); render speed
//   play    — playback mixes restored buffers; amount change re-syncs
//   export  — MP3s with master off at 0 / 100 / 40 % and with master on at 60 %; files saved for verify_restore.py
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3);
const url = opt('url', 'http://127.0.0.1:5300/');
const steps = opt('steps', 'open,gate,load,preview,play,export').split(',');
const tmp = process.env.TMPDIR || '/tmp';
const outDir = join(tmp, 'carver-test-out');
mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(join(tmp, 'carver-audio-test-profile'), {
  channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: !args.includes('--headed'), acceptDownloads: true, downloadsPath: outDir,
  viewport: { width: 1500, height: 920 },
  args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
});
await ctx.addInitScript(() => {
  const gi = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) { return typeof k === 'string' && k.startsWith('carver:modelsReady') ? '1' : gi.call(this, k); };
});
const sidonReqs = [];
ctx.on('request', (r) => { if (/Sidon-ONNX/.test(r.url())) sidonReqs.push(r.url()); });
if (args.includes('--block-hf')) await ctx.route(/huggingface\.co\/soniqo\/Sidon-ONNX/, (r) => r.abort('connectionrefused'));
const page = ctx.pages()[0] || await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /\[carver\]/.test(t)) console.log('  page', `[${m.type()}]`, t.slice(0, 400)); });
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
    await page.waitForTimeout(200);
  }
  throw new Error('timeout: ' + what);
}
const cancelTranscription = () => page.evaluate(() => { const S = window.__carver; if (S.task?.kind === 'transcribe' || S.task?.kind === 'models') S.task.cancel?.(); });
const R = () => page.evaluate(() => { const r = window.__carver.restorer; return { status: r.status, error: r.error, cached: r.cached, ep: r.ep, stats: { ...r.stats }, amount: r.amount }; });

await page.goto(url);
await page.waitForTimeout(500);
if (args.includes('--clear-cache')) console.log('cache cleared:', await page.evaluate(() => caches.delete('carver-sidon-v1')));

if (steps.includes('open')) {
  await page.evaluate(() => { if (window.__carver.project) window.__carver.closeProject(); });
  await page.setInputFiles('#carver-file-input', video);
  await until(() => { const S = window.__carver; return S.pcm && S.master && S.task?.kind !== 'extract' && S.task?.kind !== 'loudness'; }, 'extraction + master', 900);
  await page.waitForTimeout(1500);
  for (let i = 0, idle = 0; i < 240; i++) {
    await cancelTranscription();
    const t = await page.evaluate(() => window.__carver.task && window.__carver.task.kind + ': ' + window.__carver.task.text);
    if (!t) { if (++idle >= 8) break; } else idle = 0;
    if (i % 10 === 0) console.log('  waiting for idle:', t);
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.__carver.setSideTab('audio'));
  console.log(el(), 'opened', await page.evaluate(() => ({ dur: window.__carver.project.media.duration, sr: window.__carver.project.media.sampleRate, ch: window.__carver.project.media.channels })));
}

if (steps.includes('gate')) {
  await page.evaluate(() => window.__carver.setSideTab('audio'));
  await page.waitForTimeout(300);
  const off = await R();
  const reqsAtZero = sidonReqs.length;
  // a fake running job: enabling must not start anything, only promise to start later
  await page.evaluate(() => window.__carver.setTask({ kind: 'llm', frac: 0.3, text: 'ИИ-монтаж… 30%' }));
  await page.locator('[data-restore-slider]').fill('40');
  await page.waitForTimeout(800);
  const waiting = await R();
  const toast = await page.evaluate(() => window.__carver.toasts.map((t) => t.text).join(' | '));
  const statusText = await page.locator('[data-restore-status]').innerText();
  await shot('restore-waiting');
  const reqsWhileBusy = sidonReqs.length - reqsAtZero;
  const stillFake = await page.evaluate(() => window.__carver.task?.kind === 'llm');
  results.gateFakeTaskHeld = stillFake;
  const tEnd = Date.now();
  await page.evaluate(() => window.__carver.setTask(null));
  const started = await until(() => { const s = window.__carver.restorer.status; return s !== 'waiting' && s !== 'off' ? s : 0; }, 'start after task', 30);
  results.gate = { offStatus: off.status, reqsAtZero, waitingStatus: waiting.status, reqsWhileBusy, toast, statusText, startedAs: started, startMs: Date.now() - tEnd };
  console.log(el(), 'gate:', JSON.stringify(results.gate));
}

if (steps.includes('load')) {
  const t0 = Date.now();
  if ((await R()).amount === 0) await page.locator('[data-restore-slider]').fill('40');
  let lastShot = 0;
  await until(() => { const s = window.__carver.restorer.status; if (s === 'error') return 'error'; return s === 'ready' ? 'ready' : 0; }, 'model ready', 1800).then(async (s) => { if (s === 'error') throw new Error('restore error: ' + (await R()).error); });
  void lastShot;
  const r = await R();
  results.load = { ms: Date.now() - t0, ep: r.ep, requests: sidonReqs.map((u) => u.replace(/^https?:\/\/[^/]+/, (h) => h)).slice(-6) };
  console.log(el(), 'load:', JSON.stringify(results.load));
}

if (steps.includes('preview')) {
  await page.evaluate(() => { window.__carverPlayer.seek(0); });
  const t0 = Date.now();
  await until(() => window.__carver.restorer.cached >= 6 ? 1 : 0, 'tiles ahead', 300);
  const tFirst6 = Date.now() - t0;
  await page.waitForTimeout(8000);   // let the 60 s plan finish; nothing beyond it must be rendered
  const r = await R();
  const K = await page.evaluate(() => window.__carver.restorer.K);
  results.preview = { msFor6Tiles: tFirst6, cachedAfterSettle: r.cached, totalTiles: K, avgTileMs: Math.round(r.stats.ms / Math.max(1, r.stats.rendered)) };
  await shot('restore-ready');
  console.log(el(), 'preview:', JSON.stringify(results.preview));
}

if (steps.includes('play')) {
  await page.evaluate(() => { const p = window.__carverPlayer; p.restoredBuffers = 0; p.dryBuffers = 0; p.seek(0); p.play(); });
  await page.waitForTimeout(6000);
  const a = await page.evaluate(() => ({ restored: window.__carverPlayer.restoredBuffers, dry: window.__carverPlayer.dryBuffers, refreshes: window.__carverPlayer.refreshes }));
  await page.locator('[data-restore-slider]').fill('80');
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => ({ refreshes: window.__carverPlayer.refreshes, stats: window.__carverPlayer.stats }));
  // jump far ahead: plays dry until the tile arrives, then crossfades in
  const far = await page.evaluate(() => { const S = window.__carver; const o = S.composite.duration * 0.8; window.__carverPlayer.seek(o); return o; });
  const tj = Date.now();
  const before = await page.evaluate(() => window.__carverPlayer.restoredBuffers);
  await until((n) => window.__carverPlayer.restoredBuffers > n + 3 ? 1 : 0, 'restored after jump', 30, before);
  const jumpMs = Date.now() - tj;
  await page.evaluate(() => window.__carverPlayer.pause());
  results.play = { first6s: a, refreshesAfterAmount: b.refreshes - a.refreshes, lateFrames: b.stats.late, jumpTo: far, restoredAfterJumpMs: jumpMs };
  console.log(el(), 'play:', JSON.stringify(results.play));
}

async function exportMp3(name, kind = 'MP3') {
  await page.evaluate((n) => { window.__carverTestHandle = async () => (await navigator.storage.getDirectory()).getFileHandle(n, { create: true }); }, name);
  await page.evaluate(() => window.__carver.setSideTab('export'));
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await page.getByRole('button', { name: kind === 'MP3' ? /Экспортировать MP3/ : /Экспортировать видео|Экспортировать MP4/ }).first().click();
  await page.waitForTimeout(800);
  await until(() => window.__carver.task?.kind !== 'export' ? 1 : 0, 'mp3 export', 3600);
  const s = (Date.now() - t0) / 1000;
  const err = await page.evaluate(() => window.__carver.toasts.filter((t) => t.kind === 'err').map((t) => t.text).join(' | '));
  const b64 = await page.evaluate(async (n) => {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile();
    const b = new Uint8Array(await f.arrayBuffer()); let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  }, name);
  writeFileSync(join(outDir, name), Buffer.from(b64, 'base64'));
  const lufs = await page.evaluate(async (n) => (await window.__carverDebug.measureFile(await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile())).integrated, name);
  const r = await R();
  console.log(el(), 'export', name, `${s.toFixed(1)} s`, 'LUFS', lufs?.toFixed?.(2), 'tiles', r.stats.rendered, err ? 'ERR ' + err : '');
  return { s, lufs, err, rendered: r.stats.rendered };
}

if (steps.includes('export')) {
  const master = await page.evaluate(() => JSON.stringify(window.__carver.project.master || null));
  await page.evaluate(() => window.__carver.revertMaster());
  const rs = {};
  for (const v of [0, 100, 40]) {
    await page.evaluate((x) => window.__carver.setRestore(x), v);
    rs['dry' + v] = await exportMp3(`restore-${v}.mp3`);
  }
  // master on (compressor + make-up) at 60 %: loudness must still land at the aim
  await page.evaluate(() => window.__carver.setSideTab('audio'));
  await page.waitForTimeout(300);
  await page.evaluate(async () => { const S = window.__carver; await S.applyMaster({ kind: 'leveler', maxGainDb: 15, targetLufs: -14.9 }); });
  await until(() => window.__carver.master?.lufs != null ? 1 : 0, 'master exact', 120);
  await page.evaluate((x) => window.__carver.setRestore(x), 60);
  const meter = await page.evaluate(() => window.__carver.master.lufs);
  rs.master60 = { ...(await exportMp3('restore-60-master.mp3')), meter };
  await page.evaluate((x) => window.__carver.setRestore(x), 0);
  rs.master0 = { ...(await exportMp3('restore-0-master.mp3')), meter };
  await page.evaluate((x) => window.__carver.setRestore(x), 100);
  rs.mp4_100 = await exportMp3('restore-100-master.mp4', 'MP4');
  rs.segments = await page.evaluate(() => window.__carver.edl.segments.map((s) => [s.start, s.end]));
  rs.sampleRate = await page.evaluate(() => window.__carver.project.media.sampleRate);
  writeFileSync(join(outDir, 'restore-segments.json'), JSON.stringify(rs.segments));
  void master;
  results.export = rs;
}

writeFileSync(join(outDir, 'restore.json'), JSON.stringify(results, null, 1));
console.log(el(), 'done');
await ctx.close();
