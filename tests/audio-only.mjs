// Audio-only source: import, black preview, MP3-only export, «Сохранить всё» without MP4.
// Usage (built app): npx vite preview --port 5200, then
//   node tests/audio-only.mjs <audio file> [--url=http://127.0.0.1:5200/]
// The file may be MP3, M4A/AAC, WAV, FLAC or OGG; a 96/192 kHz WAV also checks the MP3 resampler.
// Transcription is stubbed: this test covers the media/preview/export paths, not Whisper.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const url = (args.find((a) => a.startsWith('--url=')) || '--url=http://127.0.0.1:5200/').slice(6);
if (!file) { console.error('usage: node tests/audio-only.mjs <audio file> [--url=…]'); process.exit(2); }
const tmp = process.env.TMPDIR || '/tmp';
const profile = join(tmp, 'carver-audioonly-test-profile');
const outDir = join(tmp, 'carver-test-out');
mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true, acceptDownloads: true,
  downloadsPath: outDir, viewport: { width: 1500, height: 950 },
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) console.log('  ok:', msg); else fail(msg); };

await page.goto(url);
// Keep the test focused on media handling; model download/Whisper is covered by e2e.mjs.
await page.evaluate(() => {
  window.__carver.transcribe = async () => {};
  // «Сохранить всё» needs a directory handle; install it before the Export panel first renders.
  window.__carverTestDir = async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('audio-only-all', { recursive: true }).catch(() => {});
    return root.getDirectoryHandle('audio-only-all', { create: true });
  };
});
await page.setInputFiles('#carver-file-input', file);
let st = null;
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(300);
  st = await page.evaluate(() => {
    const S = window.__carver;
    return { media: S.media?.meta, pcm: S.pcm?.length || 0, task: S.task?.kind, toasts: S.toasts.map((t) => t.text) };
  });
  if (st.media && (st.pcm > 0 || st.toasts.length)) break;
}
if (st.toasts.length) fail('open toast: ' + st.toasts.join('; '));
await page.waitForFunction(() => !window.__carver.task, null, { timeout: 60000 });
const s = await page.evaluate(() => {
  const S = window.__carver, m = S.media.meta;
  const c = document.querySelector('.player canvas'), g = c.getContext('2d');
  return {
    hasVideo: m.hasVideo, width: m.width, height: m.height, videoCodec: m.videoCodec, audioCodec: m.audioCodec,
    sampleRate: m.sampleRate, channels: m.channels, pcm: S.pcm.length, dur: S.composite?.duration,
    pixel: Array.from(g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data),
  };
});
console.log('opened:', JSON.stringify(s));
ok(s.hasVideo === false, 'media is marked audio-only');
ok(s.width === 0 && s.height === 0 && s.videoCodec === '', 'no video metadata');
ok(s.pcm > 0, '16 kHz PCM extracted');
ok(s.pixel[0] === 0 && s.pixel[1] === 0 && s.pixel[2] === 0 && s.pixel[3] === 255, 'preview is a black frame');

await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
await page.waitForTimeout(300);
const ui = await page.evaluate(() => {
  const root = document.querySelector('.side-scroll');
  return {
    heads: [...root.querySelectorAll('h3')].map((h) => h.textContent.trim()),
    buttons: [...root.querySelectorAll('button')].map((b) => b.textContent.trim()),
    saveAll: [...root.querySelectorAll('label')].map((l) => l.textContent.trim()).filter((t) => /MP4|MP3/.test(t)),
  };
});
console.log('export panel:', JSON.stringify(ui));
ok(!ui.heads.some((h) => /Видео MP4/.test(h)), 'no MP4 section');
ok(!ui.heads.some((h) => /XML/.test(h)), 'no XML section');
ok(ui.buttons.some((b) => /Экспортировать MP3/.test(b)) && !ui.buttons.some((b) => /Экспортировать MP4/.test(b)), 'only MP3 export button');
ok(ui.saveAll.length === 1 && /MP3/.test(ui.saveAll[0]), 'save-all offers MP3 only');

// ---- MP3 export
await page.evaluate(async () => { window.__carverTestHandle = async () => (await navigator.storage.getDirectory()).getFileHandle('audio-only.mp3', { create: true }); });
const dlP = page.waitForEvent('download', { timeout: 120000 });
await page.getByRole('button', { name: /Экспортировать MP3/ }).click();
for (let i = 0; i < 400; i++) { await page.waitForTimeout(300); if (await page.evaluate(() => !window.__carver.task)) break; }
const out = join(outDir, 'audio-only.mp3');
await page.evaluate(async () => {
  const f = await (await (await navigator.storage.getDirectory()).getFileHandle('audio-only.mp3')).getFile();
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = 'audio-only.mp3'; document.body.appendChild(a); a.click();
});
await (await dlP).saveAs(out);
const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'compact', out]).toString().trim();
console.log('mp3:', probe, 'expected duration', s.dur?.toFixed(3));
ok(/codec_name=mp3/.test(probe), 'exported file is MP3');
const dur = +(/duration=([\d.]+)/.exec(probe)?.[1] || 0);
ok(Math.abs(dur - s.dur) < 0.15, `MP3 duration ${dur.toFixed(3)} ≈ timeline ${s.dur.toFixed(3)}`);

// ---- «Сохранить всё»: even if the remembered prefs ask for video, an audio project writes no MP4
await page.evaluate(() => {
  const o = JSON.parse(localStorage.getItem('carver:export') || '{}');
  localStorage.setItem('carver:export', JSON.stringify({ ...o, all: { video: true, audio: true, texts: true, ai: true, project: true } }));
});
await page.getByRole('button', { name: /Сохранить всё в папку/ }).click();
for (let i = 0; i < 400; i++) { await page.waitForTimeout(300); if (await page.evaluate(() => !window.__carver.task)) break; }
const names = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory(), d = await root.getDirectoryHandle('audio-only-all'), list = [];
  for await (const [, dir] of d.entries()) if (dir.kind === 'directory') for await (const [n, h] of dir.entries()) list.push(n + ' ' + (await h.getFile()).size);
  return list;
});
console.log('save all:', JSON.stringify(names));
ok(names.some((n) => /\.mp3 /.test(n)), 'save-all wrote MP3');
ok(names.some((n) => /\.srt /.test(n)), 'save-all wrote subtitles');
ok(!names.some((n) => /\.mp4 /.test(n)), 'save-all wrote no MP4');
writeFileSync(join(outDir, 'audio-only-report.json'), JSON.stringify({ file, s, ui, names, probe }, null, 2));

const realErrors = errors.filter((e) => !/AudioSample was garbage collected/.test(e));
if (realErrors.length) fail('page errors: ' + realErrors.slice(0, 3).join(' | '));
console.log(process.exitCode ? 'AUDIO-ONLY TEST FAILED' : 'ALL OK');
await ctx.close();
