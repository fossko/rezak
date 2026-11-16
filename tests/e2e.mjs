// End-to-end smoke test in real Google Chrome (playwright-core, no browser download).
// Usage (against the BUILT app: npm run build && npx vite preview --port 5200): node tests/e2e.mjs <video> [--headed] [--url=http://127.0.0.1:5200/] [--steps=open,transcribe,edit,play,export]
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith('--'));
const headed = args.includes('--headed');
const url = (args.find((a) => a.startsWith('--url=')) || '--url=http://127.0.0.1:5200/').slice(6);
const steps = (args.find((a) => a.startsWith('--steps=')) || '--steps=open,transcribe,edit,play,export').slice(8).split(',');
const tmp = process.env.TMPDIR || '/tmp';
const profile = join(tmp, 'carver-test-profile');
const outDir = join(tmp, 'carver-test-out');
mkdirSync(outDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: !headed, acceptDownloads: true, downloadsPath: outDir,
  viewport: { width: 1500, height: 920 },
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--autoplay-policy=no-user-gesture-required', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
});
const page = ctx.pages()[0] || await ctx.newPage();
const logs = [];
page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error' || m.type() === 'warning' || /\[transcribe\]|\[carver\]/.test(m.text())) console.log('  page', t.slice(0, 400)); });
page.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const shot = (n) => page.screenshot({ path: join(outDir, n + '.png') });
const state = () => page.evaluate(() => {
  const S = window.__carver; const p = S.project;
  return p && {
    words: p.words.length, extras: p.words.filter((w) => w.kind === 'extra').length, task: S.task && { kind: S.task.kind, text: S.task.text, frac: S.task.frac },
    pcm: S.pcm ? S.pcm.length : 0, silences: S.silences.length, segments: S.edl?.segments.length, outDuration: S.edl?.outDuration,
    duration: p.media.duration, thr: p.silence.thresholdDb, needsFile: S.needsFile, fillers: p.words.filter((w) => w.kind === 'filler').length, scanned: !!p.fillers?.scanned,
  };
});
async function waitFor(fn, what, timeoutS = 600) {
  const t = Date.now(); let last = '';
  while (Date.now() - t < timeoutS * 1000) {
    const st = await state().catch(() => null);
    if (await fn(st)) return st;
    const s = JSON.stringify(st?.task || st);
    if (s !== last && (Date.now() % 5 < 5)) { last = s; }
    await page.waitForTimeout(1000);
    if (((Date.now() - t) / 1000 | 0) % 15 === 0) console.log(`  … ${what} ${el()}`, s?.slice(0, 200));
  }
  throw new Error('timeout waiting for ' + what);
}

await page.goto(url);
console.log('gpu:', await page.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? 'yes f16=' + a.features.has('shader-f16') : 'no'; }));

if (steps.includes('firstrun')) {
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('carver:modelsReady')) localStorage.removeItem(k); });
  await page.reload();
  await page.waitForTimeout(800);
  await shot('00-firstrun');
  const t = Date.now();
  while (Date.now() - t < 600000) {
    const ready = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('carver:modelsReady')));
    if (ready) break;
    await page.waitForTimeout(500);
  }
  console.log(`firstrun: models ready after ${((Date.now() - t) / 1000).toFixed(1)} s;`, await page.locator('.card').first().innerText());
  await shot('00-home');
}
if (steps.includes('fasttrack')) {
  const model = (args.find((a) => a.startsWith('--llm=')) || '--llm=gemma4:latest').slice(6);
  await page.evaluate((model) => {
    localStorage.setItem('carver:llm', JSON.stringify({ provider: 'ollama', url: 'http://localhost:11434/v1', key: '', model, temperature: '0.2', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: '' }));
    localStorage.setItem('carver:carve', JSON.stringify({ strength: 'normal', auto: true, walkAway: false, fastStrength: 'careful' }));
    localStorage.setItem('carver:profanity', JSON.stringify({ mode: 'mute', extra: 'использовать', exclude: '', marginMs: 30, fadeMs: 4 }));
    if (window.__carver.project) window.__carver.closeProject();
  }, model);
  await page.reload(); await page.waitForTimeout(800);
  // a real File inside the page, then synthetic drag events carrying it
  await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'dnd-src'; i.hidden = true; document.body.appendChild(i); });
  await page.setInputFiles('#dnd-src', video);
  const drag = (type, x) => page.evaluate(([type, x]) => {
    const f = document.getElementById('dnd-src').files[0], dt = new DataTransfer(); dt.items.add(f);
    window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: 400, bubbles: true, cancelable: true }));
  }, [type, x]);
  const W = 1500;
  await drag('dragenter', 300); await drag('dragover', 300); await page.waitForTimeout(150);
  const left = await page.evaluate(() => ({ overlay: !!document.querySelector('.dropov'), on: document.querySelector('.dz.on h2')?.textContent }));
  await shot('10-drop-left');
  await drag('dragover', 1200); await page.waitForTimeout(150);
  const right = await page.evaluate(() => ({ on: document.querySelector('.dz.on h2')?.textContent, steps: document.querySelector('.dz-steps')?.innerText }));
  await shot('11-drop-right');
  console.log('overlay: left half →', JSON.stringify(left), '; right half →', JSON.stringify(right));
  const t0 = Date.now();
  await drag('drop', 1200);
  await page.waitForTimeout(500);
  console.log('overlay after drop:', await page.locator('.dropov').count());
  let sawCard = false, sawStep = new Set();
  while (Date.now() - t0 < 1800_000) {
    const ft = await page.evaluate(() => window.__carver.project?.fastTrack || null);
    if (ft) { sawStep.add(ft.step); if (await page.locator('.ftcard').count()) sawCard = true; }
    if (ft && ft.status !== 'running') break;
    if (ft && ft.step === 'ai' && !sawStep.has('shot-ai')) { sawStep.add('shot-ai'); await shot('12-fasttrack-ai'); }
    await page.waitForTimeout(1000);
  }
  const r = await page.evaluate(() => {
    const S = window.__carver, p = S.project;
    return { ft: p.fastTrack, words: p.words.length, muted: Array.from(S.wordMute).filter(Boolean).length,
      sugg: p.suggestions.length, tab: S.sideTab, title: document.title, shrink: document.querySelector('.shrink')?.textContent,
      gear: document.querySelector('button.icon[aria-label="Настройки"] svg') ? 'svg' : 'missing' };
  });
  console.log(el(), `fast track finished in ${((Date.now() - t0) / 1000).toFixed(0)} s; card seen: ${sawCard}; steps seen: ${[...sawStep].join(',')}`);
  console.log('fast track result:', JSON.stringify(r));
  await page.waitForTimeout(3500);
  const ch = await page.evaluate(() => window.__carverChime.log.map((c) => ({ kind: c.kind, busyS: Math.round(c.busyMs / 1000), afterFinishS: +((c.at - window.__carver.project.fastTrack.finished) / 1000).toFixed(1) })));
  console.log(`chimes during the whole fast track: ${ch.length} ${JSON.stringify(ch)}`);
  await shot('13-fasttrack-done');
  // model dropdown: opens, fetches the provider's list, filters
  await page.getByRole('button', { name: /^ИИ-монтаж/ }).first().click();
  await page.locator('.mpick-btn').first().click();
  await page.waitForSelector('.mpick-item', { timeout: 20000 });
  const all = await page.locator('.mpick-item').allInnerTexts();
  await page.locator('.mpick-pop input').fill('gem');
  const filt = await page.locator('.mpick-item').allInnerTexts();
  await shot('14-model-picker');
  await page.keyboard.press('Escape');
  console.log('model picker: list', JSON.stringify(all), '; filtered "gem" →', JSON.stringify(filt));
  // inline spinner + status under the AI button while it runs
  await page.getByRole('button', { name: 'Найти лишнее во всём тексте' }).click();
  await page.waitForSelector('.tinline', { timeout: 10000 });
  await page.waitForTimeout(2500);
  const inl = await page.evaluate(() => ({ text: document.querySelector('.tinline')?.innerText.replace(/\s+/g, ' '), btn: document.querySelector('.panel button.primary')?.innerText, btnSpinner: !!document.querySelector('.panel button.primary .spin') }));
  await shot('15-ai-inline-status');
  console.log('AI inline status:', JSON.stringify(inl));
  await waitFor((s) => s && !s.task, 'second AI pass', 1200);
}
if (steps.includes('llmstatus')) {
  const model = (args.find((a) => a.startsWith('--llm=')) || '--llm=gemma4:latest').slice(6);
  const setLlm = (thinking) => page.evaluate(([model, thinking]) => localStorage.setItem('carver:llm', JSON.stringify({ provider: 'ollama', url: 'http://localhost:11434/v1', key: '', model, temperature: '0.2', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: '', thinking })), [model, thinking]);
  for (const thinking of ['auto', 'off']) {
    await setLlm(thinking);
    await page.reload(); await page.waitForTimeout(500);
    await page.locator('.pitem', { hasText: video.split('/').pop().replace(/\.[^.]+$/, '') }).first().click();
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__carver.clearSuggestions(); window.__carver.setSideTab('ai'); });
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Найти лишнее во всём тексте' }).click();
    const seen = [];
    while (Date.now() - t0 < 600_000) {
      const t = await page.evaluate(() => window.__carver.task?.text || null);
      if (t === null && Date.now() - t0 > 1500) break;
      const stage = !t ? '' : /размышляет/.test(t) ? 'think' : /пишет ответ/.test(t) ? 'write' : /ожидание/.test(t) ? 'wait' : 'other';
      if (stage && (!seen.length || seen[seen.length - 1].stage !== stage)) seen.push({ stage, at: ((Date.now() - t0) / 1000).toFixed(1), text: t });
      await page.waitForTimeout(250);
    }
    const n = await page.evaluate(() => window.__carver.project.suggestions.length);
    console.log(`thinking=${thinking}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${n} suggestions; status changes:`);
    for (const x of seen) console.log(`   ${x.at.padStart(6)} s  [${x.stage}] ${x.text}`);
    if (thinking === 'auto') await shot('16-llm-thinking-status');
  }
  // connection test with timing breakdown
  await setLlm('auto');
  await page.evaluate(() => window.__carver.openSettings('llm'));
  await page.getByRole('button', { name: 'Проверить подключение' }).click();
  await page.waitForSelector('.modal .ok:has-text("Подключение работает"), .modal .err', { timeout: 180000 });
  console.log('connection test:', await page.locator('.modal .ok, .modal .err').last().innerText());
  await shot('17-llm-test');
}
if (steps.includes('open')) {
  await page.evaluate(() => { if (window.__carver.project) window.__carver.closeProject(); });
  await page.setInputFiles('#carver-file-input', video);
  const st = await waitFor((s) => s && s.pcm > 0 && (!s.task || s.task.kind !== 'extract'), 'audio extraction', 300);
  console.log(el(), 'opened:', JSON.stringify(st));
  await shot('01-opened');
}
if (steps.includes('reopen')) {
  const before = await state();
  await page.reload();
  const pname = video.split('/').pop().replace(/\.[^.]+$/, '');
  await page.locator('.pitem', { hasText: pname }).first().click();
  await page.waitForTimeout(1500);
  console.log('reopened (before link):', JSON.stringify(await state()));
  await page.setInputFiles('#carver-link-input', video);
  const st = await waitFor((s) => s && !s.needsFile && !s.task, 'relink', 120);
  console.log('relinked:', JSON.stringify(st), 'same edl:', st.outDuration === before?.outDuration, 'removed words kept:', await page.evaluate(() => Array.from(window.__carver.wordState).filter(Boolean).length));
}
if (steps.includes('probe')) {
  const r = await page.evaluate(() => {
    const S = window.__carver, lv = Float32Array.from(S.levels).sort(), q = (p) => lv[Math.floor(lv.length * p)].toFixed(1);
    const pcm = S.pcm; let mx = 0; for (let i = 0; i < pcm.length; i++) mx = Math.max(mx, Math.abs(pcm[i]));
    return { n: S.levels.length, p: [0.05, 0.2, 0.3, 0.5, 0.7, 0.9].map(q), max: mx, sample: Array.from(pcm.slice(16000 * 30, 16000 * 30 + 8)),
      silences: S.silences.map((s) => s.start.toFixed(2) + '-' + s.end.toFixed(2)).join(' ') };
  });
  console.log('probe:', JSON.stringify(r));
}
if (steps.includes('transcribe')) {
  const st = await waitFor((s) => s && s.words > 0 && !s.task && s.scanned, 'transcription', 3600);
  console.log(el(), 'transcribed:', JSON.stringify(st));
  await shot('02-transcribed');
  const sample = await page.evaluate(() => window.__carver.project.words.slice(0, 60).map((w) => `${w.kind ? '‹' + w.text + '›' : w.text}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(' '));
  console.log('words:', sample);
}
if (steps.includes('edit')) {
  // remove words 5..9 via UI selection + Delete, then undo/redo
  const w5 = page.locator('[data-i="5"]'), w9 = page.locator('[data-i="9"]');
  await w5.click(); await w9.click({ modifiers: ['Shift'] });
  await page.keyboard.press('Delete');
  let r = await page.evaluate(() => Array.from(window.__carver.wordState.slice(0, 12)));
  console.log('after delete:', r.join(''));
  await page.keyboard.press('Meta+z');
  r = await page.evaluate(() => Array.from(window.__carver.wordState.slice(0, 12)));
  console.log('after undo:  ', r.join(''));
  await page.keyboard.press('Meta+Shift+z');
  r = await page.evaluate(() => Array.from(window.__carver.wordState.slice(0, 12)));
  console.log('after redo:  ', r.join(''));
  console.log('edl:', JSON.stringify(await state()));
  await shot('03-edited');
}
if (steps.includes('seamless')) {
  // play 40 s of the carved result starting where cuts are dense, measure frame delivery
  const r0 = await page.evaluate(() => {
    const S = window.__carver, P = window.__carverPlayer, segs = S.edl.segments;
    let best = 0, bestN = 0;
    for (let k = 0; k < segs.length; k++) { let n = 0; for (let j = k; j < segs.length && segs[j].start < segs[k].start + 60; j++) n++; if (n > bestN) { bestN = n; best = k; } }
    P.seekSrc(segs[best].start); P.stats = { drawn: 0, late: 0, maxGap: 0 };
    return { from: segs[best].start, joins: bestN };
  });
  await page.locator('.player canvas').click();
  await page.waitForTimeout(40000);
  await page.locator('.player canvas').click();
  const st = await page.evaluate(() => window.__carverPlayer.stats);
  console.log('seamless:', JSON.stringify(r0), JSON.stringify(st), `fps≈${(st.drawn / 40).toFixed(1)}`);
}
if (steps.includes('aligndebug')) {
  const [A, B, w0, w1] = (args.find((a) => a.startsWith('--range=')) || '--range=1677,1708,если,варвар,').slice(8).split(',');
  const r = await page.evaluate(async ([A, B, w0, w1]) => {
    const S = window.__carver, D = window.__carverDebug, ws = S.project.words.filter((w) => !w.kind);
    const i0 = ws.findIndex((w) => w.start > +A - 3 && w.text.toLowerCase().startsWith(w0)), i1 = ws.findIndex((w, i) => i > i0 && w.text.startsWith(w1));
    const words = ws.slice(i0, i1 + 1).map((w) => w.text);
    const rpc = D.getSpeechRPC(); await rpc.call('ctcLoad', { device: 'auto' });
    const { data, t0 } = D.pcmSlice(S.pcm, +A, +B);
    const res = await rpc.call('ctcAlign', { buffer: data.buffer, words }, [data.buffer]);
    return { n: words.length, T: res.T, nulls: res.words.filter((x) => !x).length,
      al: words.map((w, i) => `${w}@${res.words[i] ? (t0 + res.words[i].start).toFixed(1) + '(' + res.words[i].score.toFixed(2) + ')' : 'NULL'}`).join(' '),
      heard: res.heard.map((h) => `${h.text}@${(t0 + h.start).toFixed(1)}`).join(' ') };
  }, [A, B, w0, w1]);
  console.log('aligndebug:', JSON.stringify(r, null, 1));
}
if (steps.includes('fillers')) {
  const sens = (args.find((a) => a.startsWith('--sens=')) || '--sens=normal').slice(7);
  await page.getByRole('button', { name: 'Монтаж', exact: true }).click();
  await page.evaluate((s) => { window.__carver.fillerOpts().sensitivity = s; }, sens);
  const t = Date.now();
  await page.getByRole('button', { name: /^Найти( заново)?$/ }).click();
  await page.waitForTimeout(800);
  await waitFor((s) => s && !s.task, 'fillers', 900);
  const r = await page.evaluate(() => {
    const S = window.__carver, p = S.project;
    const f = p.words.map((w, i) => ({ w, i })).filter((x) => x.w.kind === 'filler');
    return { n: f.length, cut: f.filter((x) => S.wordState[x.i]).length, list: f.map((x) => ({ s: x.w.start, e: x.w.end, label: x.w.text, auto: !!x.w.auto })),
      outDuration: S.edl.outDuration, words: p.words.length };
  });
  writeFileSync(join(outDir, 'fillers.json'), JSON.stringify(r.list));
  console.log(el(), `fillers (${sens}): ${r.n} found, ${r.cut} cut, in ${((Date.now() - t) / 1000).toFixed(1)} s; result ${r.outDuration.toFixed(1)} s; words ${r.words}`);
  const by = {}; for (const x of r.list) by[x.label] = (by[x.label] || 0) + 1; console.log('labels:', JSON.stringify(by));
  await shot('08-fillers');
}
if (steps.includes('rate')) {
  for (const r of ['2', '0.75', '1.5', '1']) {
    await page.locator('select.rate').selectOption(r);
    const o0 = await page.evaluate(() => { const P = window.__carverPlayer; P.seek(30); P.stats = { drawn: 0, late: 0, maxGap: 0, audio: 0 }; return P.current; });
    await page.locator('.player canvas').click();
    const w0 = Date.now();
    await page.waitForTimeout(10000);
    const res = await page.evaluate(() => { const P = window.__carverPlayer; return { cur: P.current, stats: P.stats, rate: P.rate }; });
    const wall = (Date.now() - w0) / 1000;
    await page.locator('.player canvas').click();
    console.log(`rate ${r}: player.rate=${res.rate} advanced ${(res.cur - o0).toFixed(2)} s of video in ${wall.toFixed(1)} s wall (×${((res.cur - o0) / wall).toFixed(2)}),`,
      `frames ${res.stats.drawn} (${(res.stats.drawn / wall).toFixed(1)} fps, late ${res.stats.late}), audio scheduled ${res.stats.audio.toFixed(1)} s wall`);
  }
}
if (steps.includes('play')) {
  await page.evaluate(() => window.__carver && document.querySelector('.player canvas'));
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__hubT = []; });
  await page.locator('.player canvas').click();
  await page.waitForTimeout(6000);
  const t = await page.evaluate(() => { const S = window.__carver; return { playing: document.querySelector('.pctl button').textContent, time: document.querySelector('.pctl .time').textContent }; });
  console.log('play:', JSON.stringify(t));
  await shot('04-playing');
  await page.locator('.player canvas').click();
}
if (steps.includes('export')) {
  page.on('dialog', (d) => d.accept());
  // export streams into an OPFS file (same code path as a real file picked in the save dialog)
  await page.evaluate(() => { window.__carverTestHandle = async () => (await navigator.storage.getDirectory()).getFileHandle('export.mp4', { create: true }); });
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  const tx = Date.now();
  await page.getByRole('button', { name: /Экспортировать MP4/ }).click();
  await page.waitForTimeout(1000);
  await waitFor((s) => s && !s.task, 'export', 3600);
  console.log(el(), `export took ${((Date.now() - tx) / 1000).toFixed(1)} s`);
  const dlP = page.waitForEvent('download', { timeout: 600_000 });
  await page.evaluate(async () => { const f = await (await (await navigator.storage.getDirectory()).getFileHandle('export.mp4')).getFile(); const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = 'export.mp4'; document.body.appendChild(a); a.click(); });
  const dl = await dlP;
  const out = join(outDir, 'export.mp4');
  await dl.saveAs(out);
  const st = await state();
  writeFileSync(join(outDir, 'segments.json'), JSON.stringify(await page.evaluate(() => window.__carver.edl.segments)));
  console.log(el(), 'exported; expected duration', st.outDuration?.toFixed(3));
  console.log(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,duration,nb_frames,r_frame_rate,sample_rate,channels', '-of', 'compact', out]).toString());
  await shot('05-exported');
}
if (steps.includes('ai')) {
  const model = (args.find((a) => a.startsWith('--llm=')) || '--llm=gemma4:latest').slice(6);
  await page.evaluate((model) => localStorage.setItem('carver:llm', JSON.stringify({ provider: 'ollama', url: 'http://localhost:11434/v1', key: '', model, temperature: '0.2', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: '' })), model);
  await page.evaluate(() => localStorage.setItem('carver:carve', JSON.stringify({ strength: 'normal', auto: true })));
  await page.evaluate(() => { const S = window.__carver; S.clearSuggestions(); S.resetEdits(); });
  await page.getByRole('button', { name: 'ИИ-монтаж', exact: true }).click();
  await page.getByRole('button', { name: 'Найти лишнее во всём тексте' }).click();
  await page.waitForTimeout(1500);
  await waitFor((s) => s && !s.task, 'AI carving', 1800);
  const sug = await page.evaluate(() => { const S = window.__carver, p = S.project; return p.suggestions.map((s) => `[${s.type}/${s.status} ${Math.round((s.confidence ?? 0) * 100)}%] «${p.words.slice(s.from, s.to + 1).map((w) => w.text).join(' ')}» — ${s.reason}`); });
  console.log(el(), 'suggestions:', sug.length); for (const x of sug.slice(0, 70)) console.log('   ', x);
  console.log('edl:', JSON.stringify(await state()));
  await shot('06-ai');
}
if (steps.includes('texts')) {
  await page.evaluate(() => localStorage.setItem('carver:pipeline', JSON.stringify([
    { id: 'spelling', enabled: false }, { id: 'structured', enabled: false }, { id: 'chapters', enabled: true }, { id: 'keypoints', enabled: false },
    { id: 'summary', enabled: false, source: 'plain' }, { id: 'youtube', enabled: true, source: 'plain' }, { id: 'post', enabled: false }, { id: 'shorts', enabled: false }])));
  await page.getByRole('button', { name: 'Тексты', exact: true }).click();
  await page.getByRole('button', { name: 'Запустить отмеченные' }).click();
  await page.waitForTimeout(1500);
  await waitFor((s) => s && !s.task, 'text pipeline', 1800);
  const res = await page.evaluate(() => window.__carver.project.pipeline.map((r) => `### ${r.stepId}\n${r.text.slice(0, 900)}`).join('\n\n'));
  console.log(el(), 'pipeline results:\n' + res);
  await shot('07-texts');
}
if (steps.includes('subs')) {
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  for (const [name, file] of [['Субтитры SRT', 'out.srt'], ['JSON (слова и склейки)', 'out.json'], ['Текст с таймкодами', 'out.timed.txt']]) {
    const dlP = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    await (await dlP).saveAs(join(outDir, file));
  }
  console.log('subs saved');
}
if (steps.includes('mat')) {
  const words = (args.find((a) => a.startsWith('--matwords=')) || '--matwords=использовать, нормально*').slice(11);
  await page.evaluate(() => { const S = window.__carver; S.resetEdits(); S.clearSuggestions(); S.clearProfanity(); S.project.titles = []; S.recompute(); });
  await page.getByRole('button', { name: 'Мат', exact: true }).click();
  const inp = page.getByPlaceholder('сук*, мудак*, /^пид[оа]р/');
  await inp.fill('сук*, /[/');                      // invalid regexp must be reported and block the button
  const bad = await page.locator('.err', { hasText: 'Не понял' }).first().innerText();
  const disabled = await page.getByRole('button', { name: 'Почистить мат' }).isDisabled();
  console.log('mat: invalid entry →', JSON.stringify(bad), 'button disabled:', disabled);
  await inp.fill(words); await inp.blur();
  await page.getByRole('button', { name: 'Заглушить', exact: true }).click();
  await page.getByRole('button', { name: 'Почистить мат' }).click();
  const r1 = await page.evaluate(() => { const S = window.__carver, p = S.project;
    return { hits: (p.profHits || []).map((h) => p.words.slice(h.from, h.to + 1).map((w) => w.text).join(' ')), muted: Array.from(S.wordMute).filter(Boolean).length, regions: S.muteRegions() }; });
  console.log('mat: hits', JSON.stringify(r1.hits), 'muted words', r1.muted, 'regions', JSON.stringify(r1.regions.map((r) => r.map((x) => +x.toFixed(2)))));
  // hotkey M on a selected word (toggle on, then off, then on again)
  const wi = await page.evaluate(() => window.__carver.project.words.findIndex((w, i) => i > 20 && !w.kind && w.text.length > 4 && !window.__carver.wordState[i]));
  await page.locator(`[data-i="${wi}"]`).click();
  await page.keyboard.press('m'); const m1 = await page.evaluate((i) => window.__carver.wordMute[i], wi);
  await page.keyboard.press('m'); const m2 = await page.evaluate((i) => window.__carver.wordMute[i], wi);
  await page.keyboard.press('m'); const m3 = await page.evaluate((i) => window.__carver.wordMute[i], wi);
  const cls = await page.locator(`[data-i="${wi}"]`).getAttribute('class');
  const color = await page.locator(`[data-i="${wi}"]`).evaluate((e) => getComputedStyle(e).color);
  console.log(`mat: hotkey M on word ${wi}: ${m1} → ${m2} → ${m3}; class "${cls}", color ${color}`);
  // switch the last hit to «вырезать» and back to «заглушить»
  const nh = r1.hits.length;
  if (nh > 1) {
    await page.locator('.sugg').nth(nh - 1).getByRole('button', { name: 'вырезать', exact: true }).click();
    const st = await page.evaluate(() => { const S = window.__carver, h = S.project.profHits.at(-1); return { cut: S.wordState[h.from], mute: S.wordMute[h.from], out: S.edl.outDuration }; });
    console.log('mat: last hit → вырезать:', JSON.stringify(st));
  }
  await shot('09-mat');
}
if (steps.includes('saveall')) {
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => {
    localStorage.setItem('carver:export', JSON.stringify({ videoMute: false, audioMute: true, mp3Bitrate: 320000, maskSubs: true, all: { video: true, audio: true, texts: true, ai: true, project: true } }));
    window.__carverTestDir = async () => { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle('export-all', { create: true }); };
  });
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  writeFileSync(join(outDir, 'mutes.json'), JSON.stringify(await page.evaluate(() => {
    const S = window.__carver, D = window.__carverDebug;
    return { mutes: S.muteRegions().map(([a, b]) => [D.srcToOut(S.edl, a), D.srcToOut(S.edl, b)]), outDuration: S.edl.outDuration };
  })));
  const tx = Date.now();
  await page.getByRole('button', { name: 'Сохранить всё в папку…' }).click();
  await page.waitForTimeout(1000);
  await waitFor((s) => s && !s.task, 'save all', 3600);
  console.log(el(), `save all took ${((Date.now() - tx) / 1000).toFixed(1)} s`);
  const names = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), d = await root.getDirectoryHandle('export-all');
    const out = [];
    for await (const [n, h] of d.entries()) if (h.kind === 'directory') for await (const [n2, h2] of h.entries()) out.push(n + '/' + n2 + ' ' + (await h2.getFile()).size);
    return out;
  });
  console.log('saved files:\n  ' + names.join('\n  '));
  for (const want of ['.mp4', '.mp3', '.srt']) {
    const dlP = page.waitForEvent('download');
    await page.evaluate(async (ext) => {
      const root = await navigator.storage.getDirectory(), d = await root.getDirectoryHandle('export-all');
      for await (const [, h] of d.entries()) if (h.kind === 'directory') for await (const [n2, h2] of h.entries()) if (n2.endsWith(ext)) {
        const a = document.createElement('a'); a.href = URL.createObjectURL(await h2.getFile()); a.download = 'all' + ext; document.body.appendChild(a); a.click(); return;
      }
    }, want);
    await (await dlP).saveAs(join(outDir, 'all' + want));
  }
  await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); await root.removeEntry('export-all', { recursive: true }); });
}
if (steps.includes('cutedit')) {
  const box = await page.locator('.timeline canvas').boundingBox();
  const TL = () => page.evaluate(() => { const t = window.__carverTimeline; return { v0: t.v0, span: t.span, W: t.W }; });
  const view = (v0, span) => page.evaluate(([v0, span]) => { const t = window.__carverTimeline; t.v0 = v0; t.span = span; t.dirty = true; }, [v0, span]);
  const X = async (t) => { const v = await TL(); return box.x + (t - v.v0) / v.span * v.W; };
  const region = (sk) => page.evaluate((sk) => { const r = window.__carver.edl.regions.find((r) => r.sk === sk); return r ? { a: r.a, b: r.b, autoA: r.autoA, autoB: r.autoB, sk: r.sk, ek: r.ek, custom: r.custom } : null; }, sk);
  const ms = (x) => (x * 1000).toFixed(1);
  // 1) deepest zoom by mouse wheel
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < 40; k++) await page.mouse.wheel(0, -300);
  let v = await TL();
  console.log(`zoom: span ${v.span.toFixed(2)} s over ${v.W} px = ${ms(v.span / v.W)} ms per pixel`);
  // 2) a removed word run to work on: cut two kept words in the middle of the clip
  const wi = await page.evaluate(() => { const S = window.__carver, ws = S.project.words;
    S.resetEdits(); S.clearSuggestions(); S.clearProfanity(); S.setAllFillers(false);
    let i = ws.findIndex((w, k) => k > 40 && !w.kind && !S.wordState[k] && !S.wordState[k + 1] && !S.wordState[k - 1] && ws[k + 1] && !ws[k + 1].kind && ws[k + 2] && !S.wordState[k + 2]);
    S.toggleRange(i, i + 1); return i; });
  const sk = `rs:${wi}`;
  let r0 = await region(sk);
  console.log(`region for words ${wi}–${wi + 1}:`, JSON.stringify(r0));
  await view(r0.a - 0.6, 2.5); await page.waitForTimeout(150);
  v = await TL(); const spp = v.span / v.W;
  // 3) click inside → selected, handles shown, playhead before the cut
  await page.mouse.click(await X((r0.a + r0.b) / 2), box.y + box.height / 2);
  await page.waitForTimeout(150);
  const sel = await page.evaluate(() => window.__carver.cutSel);
  console.log('selected:', JSON.stringify(sel));
  await page.screenshot({ path: join(outDir, '19-cut-selected.png') });
  // 4) drag the END handle 25 px to the right
  const hy = box.y + 16 + 2 + 8;
  const xb = await X(r0.b);
  await page.mouse.move(xb, hy); await page.mouse.down();
  for (let k = 1; k <= 5; k++) await page.mouse.move(xb + k * 5, hy);
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(outDir, '20-cut-dragging.png') });
  await page.mouse.up(); await page.waitForTimeout(200);
  let r1 = await region(sk);
  console.log(`drag end +25 px: b ${r0.b.toFixed(4)} → ${r1.b.toFixed(4)} (Δ ${ms(r1.b - r0.b)} ms, expected ${ms(25 * spp)} ± ${ms(spp)}), custom=${r1.custom}`);
  // 5) keyboard: ← ×3 on the end handle, then Tab → start handle, Shift+→ once (= 10 px)
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowLeft');
  let r2 = await region(sk);
  console.log(`← ×3: b Δ ${ms(r2.b - r1.b)} ms (expected ${ms(-3 * spp)})`);
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+ArrowRight');
  let r3 = await region(sk);
  console.log(`Tab, Shift+→: a Δ ${ms(r3.a - r2.a)} ms (expected ${ms(10 * spp)}); edges stored:`, JSON.stringify(await page.evaluate(() => window.__carver.project.edges)));
  await page.screenshot({ path: join(outDir, '21-cut-custom.png') });
  // 6) restore the words in the transcript → region gone; cut again → custom edges come back
  await page.evaluate((i) => window.__carver.toggleRange(i, i + 1), wi);
  const gone = await region(sk);
  await page.evaluate((i) => window.__carver.toggleRange(i, i + 1), wi);
  const back = await region(sk);
  console.log(`words restored → region ${gone ? 'STILL THERE' : 'gone'}; cut again → a ${back.a.toFixed(4)} b ${back.b.toFixed(4)} (same as before: ${Math.abs(back.a - r3.a) < 1e-4 && Math.abs(back.b - r3.b) < 1e-4})`);
  // 7) limits: drag the start far left, into the previous region
  await view(back.a - 8, 10); await page.waitForTimeout(150);
  await page.mouse.click(await X(back.a + 0.05), box.y + box.height / 2); await page.waitForTimeout(100);
  const xa = await X(back.a);
  await page.mouse.move(xa, hy); await page.mouse.down();
  for (let k = 1; k <= 20; k++) await page.mouse.move(xa - k * 40, hy);
  await page.mouse.up(); await page.waitForTimeout(200);
  const lim = await page.evaluate((sk) => { const S = window.__carver, rs = S.edl.regions, i = rs.findIndex((r) => r.sk === sk); return { a: rs[i].a, prevB: i > 0 ? rs[i - 1].b : null, minKeep: S.project.cut.minKeep, n: rs.length }; }, sk);
  console.log(`drag start far left: a=${lim.a.toFixed(4)}, previous region ends ${lim.prevB?.toFixed(4)}, gap ${lim.prevB != null ? ms(lim.a - lim.prevB) : '-'} ms (min keep ${ms(lim.minKeep)} ms) → no overlap: ${lim.prevB == null || lim.a - lim.prevB >= lim.minKeep}`);
  // 8) double-click → back to automatic; undo → custom again
  const cur = await region(sk);
  await view(cur.b - 2, 2.5); await page.waitForTimeout(150);
  await page.mouse.dblclick(await X(cur.b - 0.3), box.y + box.height / 2); await page.waitForTimeout(200);
  const reset = await region(sk);
  console.log(`double-click: custom=${reset.custom}, a=${reset.a.toFixed(4)} (auto ${r0.a.toFixed(4)}), b=${reset.b.toFixed(4)} (auto ${r0.b.toFixed(4)})`);
  await page.keyboard.press('Escape'); await page.keyboard.press('Meta+z'); await page.waitForTimeout(150);
  const undone = await region(sk);
  console.log(`undo: custom=${undone.custom}, a=${undone.a.toFixed(4)}, b=${undone.b.toFixed(4)}`);
  // 9) a pause (silence) region: customize its start, then move the threshold & padding — the edge must not move
  const g = await page.evaluate(() => window.__carver.edl.regions.find((r) => r.sk && r.sk.startsWith('gs:') && r.b - r.a > 1));
  await page.evaluate((g) => { const S = window.__carver, r = S.edl.regions.find((x) => x.sk === g.sk); S.setEdge(r, 'a', r.a - 0.05); }, g);
  const gs1 = await region(g.sk);
  await page.evaluate(() => { window.__carver.setSilence({ thresholdDb: window.__carver.project.silence.thresholdDb - 6, padBefore: 0.3 }); });
  const gs2 = await region(g.sk);
  await page.evaluate(() => { window.__carver.setSilence({ thresholdDb: window.__carver.project.silence.thresholdDb + 6, padBefore: 0.15 }); });
  console.log(`pause region ${g.sk}: custom start ${gs1.a.toFixed(4)}; after threshold −6 dB & padding 0.3 s: ${gs2 ? gs2.a.toFixed(4) : 'region gone'} (auto would be ${gs2 ? gs2.autoA.toFixed(4) : '-'}) → unchanged: ${gs2 && Math.abs(gs2.a - gs1.a) < 1e-6}`);
  await page.screenshot({ path: join(outDir, '22-pause-custom.png') });
  writeFileSync(join(outDir, 'cutedit.json'), JSON.stringify({ word: await region(sk), pause: await region(g.sk) }));
}
if (steps.includes('zoom')) {
  await page.evaluate(() => {
    window.__zt = { wheel: [], key: [] };
    window.addEventListener('wheel', (e) => window.__zt.wheel.push(e.defaultPrevented), { passive: true });
    window.addEventListener('keydown', (e) => window.__zt.key.push(e.code + ':' + e.defaultPrevented));
  });
  const box = await page.locator('.timeline canvas').boundingBox();
  const tbox = await page.locator('.tscroll').boundingBox();
  const sbox = await page.locator('.side-scroll').boundingBox();
  const snap = () => page.evaluate(() => { const t = window.__carverTimeline;
    return { span: +t.span.toFixed(3), v0: +t.v0.toFixed(3), text: document.querySelector('.tscroll').scrollTop, side: document.querySelector('.side-scroll').scrollTop,
      dpr: window.devicePixelRatio, inner: window.innerWidth, vvScale: window.visualViewport.scale }; });
  await page.evaluate(() => { const t = window.__carverTimeline; t.v0 = 20; t.span = 30; t.dirty = true; document.querySelector('.tscroll').scrollTop = 0; document.querySelector('.side-scroll').scrollTop = 0; });
  const show = (label, a, b) => console.log(`${label.padEnd(40)} span ${a.span}→${b.span}  v0 ${a.v0}→${b.v0}  text scroll ${a.text}→${b.text}  side scroll ${a.side}→${b.side}  page dpr ${a.dpr}→${b.dpr} width ${a.inner}→${b.inner} vv ${a.vvScale}→${b.vvScale}`);
  const pinch = async (x, y, dy) => { await page.mouse.move(x, y); await page.keyboard.down('Control'); for (let k = 0; k < 6; k++) await page.mouse.wheel(0, dy); await page.keyboard.up('Control'); await page.waitForTimeout(150); };
  let a = await snap(); await pinch(box.x + 500, box.y + 70, -20); let b = await snap(); show('pinch-in over waveform', a, b);
  a = b; await pinch(tbox.x + 300, tbox.y + 200, -20); b = await snap(); show('pinch-in over transcript', a, b);
  a = b; await pinch(sbox.x + 200, sbox.y + 200, -20); b = await snap(); show('pinch-in over side panel', a, b);
  a = b; await page.mouse.move(box.x + 500, box.y + 70); await page.mouse.wheel(0, 120); await page.mouse.wheel(80, 0); await page.waitForTimeout(150); b = await snap(); show('scroll over waveform (down + right)', a, b);
  a = b; await page.mouse.move(tbox.x + 300, tbox.y + 200); await page.mouse.wheel(0, 400); await page.waitForTimeout(300); b = await snap(); show('scroll over transcript', a, b);
  a = b; await page.mouse.move(sbox.x + 200, sbox.y + 300); await page.mouse.wheel(0, 300); await page.waitForTimeout(300); b = await snap(); show('scroll over side panel', a, b);
  a = b; await page.keyboard.press('Meta+Equal'); await page.waitForTimeout(100); b = await snap(); show('Cmd+=', a, b);
  a = b; await page.keyboard.press('Meta+Minus'); await page.keyboard.press('Meta+Minus'); await page.waitForTimeout(100); b = await snap(); show('Cmd+- ×2', a, b);
  a = b; await page.locator('.tl-zoom button', { hasText: '+' }).click(); await page.waitForTimeout(100); b = await snap(); show('button +', a, b);
  a = b; await page.locator('.tl-zoom button', { hasText: '−' }).click(); await page.waitForTimeout(100); b = await snap(); show('button −', a, b);
  const zt = await page.evaluate(() => window.__zt);
  const ctrlWheels = zt.wheel.slice(0, 18);
  console.log(`ctrl+wheel events cancelled (no page zoom): ${ctrlWheels.filter(Boolean).length}/${ctrlWheels.length}; keys: ${zt.key.filter((k) => /Equal|Minus/.test(k)).join(' ')}`);
  await shot('23-zoom-buttons');
}
if (steps.includes('titletext')) {
  const titlePath = (args.find((a) => !a.startsWith('--') && /intro/i.test(a))) || (process.env.TITLE || '');
  await page.getByRole('button', { name: 'Заставки', exact: true }).click();
  await page.evaluate(async () => { const S = window.__carver; S.project.titles = []; S.recompute(); S.bump(); for (const t of [...S.titleLib]) await S.removeTitleAsset(t.id); });
  await page.setInputFiles('#carver-title-input', titlePath);
  await page.waitForSelector('.sugg:has-text("glvrd-intro-clean")', { timeout: 20000 });
  // place the text caret AFTER a word by clicking it
  const wi = await page.evaluate(() => { const S = window.__carver, ws = S.project.words; let i = ws.findIndex((w, k) => k > 15 && !w.kind && !S.wordState[k] && ws[k + 1] && !ws[k + 1].kind); S.setSelection({ a: i, b: i }); return i; });
  await page.locator(`.tscroll [data-i="${wi}"]`).click(); await page.waitForTimeout(120);
  const caretEnd = await page.evaluate((i) => window.__carver.project.words[i].end, wi);
  await page.locator('.sugg', { hasText: 'glvrd-intro-clean' }).first().click();
  await page.waitForTimeout(200);
  const r1 = await page.evaluate((end) => { const S = window.__carver, t = S.project.titles[0]; return { anchor: t.anchor, expected: end, chip: !!document.querySelector('[data-title]'), selected: S.titleSel?.id === t.id }; }, caretEnd);
  console.log(`insert at caret after word ${wi}: anchor ${r1.anchor.toFixed(3)} vs word end ${r1.expected.toFixed(3)} → ${Math.abs(r1.anchor - r1.expected) < 1e-3}; chip in text: ${r1.chip}; title selected: ${r1.selected}`);
  await shot('30-title-chip');
  // click the chip -> selected; Delete -> removed
  await page.locator('[data-title]').click(); await page.waitForTimeout(100);
  const sel = await page.evaluate(() => window.__carver.titleSel?.id === window.__carver.project.titles[0].id);
  await page.keyboard.press('Delete'); await page.waitForTimeout(150);
  const gone = await page.evaluate(() => ({ n: window.__carver.project.titles.length, chip: !!document.querySelector('[data-title]') }));
  console.log(`chip click selects: ${sel}; Delete removes it: titles ${gone.n}, chip ${gone.chip}`);
}
if (steps.includes('linenav')) {
  await page.evaluate(() => { window.__carver.selectRegion(null); document.querySelector('.tscroll').scrollTop = 0; });
  await page.waitForTimeout(300);
  // visual lines of the rendered words
  const lines = () => page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.tscroll [data-i]')) {
      const r = el.getBoundingClientRect(), L = out.find((l) => Math.abs(l.top - r.top) < r.height / 2);
      const w = { i: +el.dataset.i, left: r.left, right: r.right };
      if (L) L.words.push(w); else out.push({ top: r.top, words: [w] });
    }
    return out.sort((a, b) => a.top - b.top);
  });
  const info = (i) => page.evaluate((i) => { const r = document.querySelector(`.tscroll [data-i="${i}"]`).getBoundingClientRect(); return { top: r.top, cx: (r.left + r.right) / 2, text: document.querySelector(`.tscroll [data-i="${i}"]`).textContent }; }, i);
  const focus = () => page.evaluate(() => ({ a: window.__carver.selection.a, b: window.__carver.selection.b }));
  let L = await lines();
  const li = Math.min(4, L.length - 3), line = L[li], start = line.words[line.words.length - 2];   // near the right end of a line
  await page.locator(`.tscroll [data-i="${start.i}"]`).click();
  await page.waitForTimeout(150);
  const s0 = await info(start.i);
  const st0 = await page.evaluate(() => document.querySelector('.tscroll').scrollTop);
  await page.keyboard.press('ArrowDown');
  const f1 = await focus(), s1 = await info(f1.b);
  L = await lines();
  const lineBelow = L.find((l) => l.top > s0.top + 5);
  const nearest = lineBelow.words.reduce((m, w) => { const d = s0.cx < w.left ? w.left - s0.cx : s0.cx > w.right ? s0.cx - w.right : 0; return d < m.d ? { d, i: w.i } : m; }, { d: 1e9, i: -1 });
  console.log(`↓ from «${s0.text}» (word ${start.i}) → «${s1.text}» (word ${f1.b}): moved ${Math.round(s1.top - s0.top)} px down; expected word ${nearest.i} on the next line → ${f1.b === nearest.i ? 'OK' : 'MISMATCH'}`);
  await page.keyboard.press('ArrowUp');
  const f2 = await focus();
  console.log(`↑ back → word ${f2.b} (${f2.b === start.i ? 'same word OK' : 'DIFFERENT'})`);
  // round trip through 6 lines (crossing paragraph breaks / short lines) keeps the column
  const path = [];
  for (let k = 0; k < 6; k++) { await page.keyboard.press('ArrowDown'); const f = await focus(); path.push(`${(await info(f.b)).text}`); }
  for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowUp');
  const f3 = await focus();
  console.log(`↓×6 path: ${path.join(' → ')}; ↑×6 → word ${f3.b} (${f3.b === start.i ? 'back to start OK' : 'DRIFTED'})`);
  // Shift+↓ extends
  await page.keyboard.press('Shift+ArrowDown');
  const f4 = await focus();
  console.log(`Shift+↓: anchor ${f4.a} (kept ${f4.a === start.i}), focus ${f4.b}; selected words ${Math.abs(f4.b - f4.a) + 1}`);
  await shot('24-linenav');
  // first line: ↑ stays put
  await page.evaluate(() => { document.querySelector('.tscroll').scrollTop = 0; }); await page.waitForTimeout(200);
  L = await lines();
  await page.locator(`.tscroll [data-i="${L[0].words[1].i}"]`).click();
  await page.keyboard.press('ArrowUp');
  const f5 = await focus();
  console.log(`↑ on the first line: stays on word ${f5.b} (${f5.b === L[0].words[1].i ? 'OK' : 'moved'})`);
  const st1 = await page.evaluate(() => document.querySelector('.tscroll').scrollTop);
  console.log(`page did not scroll by itself: scrollTop ${st0} → after first ↓ handled by selection (now ${st1})`);
}
if (steps.includes('caret')) {
  await page.evaluate(() => { window.__carver.selectRegion(null); window.__carver.setSelection(null); document.querySelector('.tscroll').scrollTop = 0; });
  await page.waitForTimeout(300);
  const st = (label) => page.evaluate((label) => {
    const c = document.querySelector('.caret'), cr = c.getBoundingClientRect(), S = window.__carver;
    const sel = S.selection, w = sel && document.querySelector(`.tscroll [data-i="${sel.b}"]`), wr = w && w.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return { label, visible: cs.display !== 'none', x: Math.round(cr.left), wordLeft: wr && Math.round(wr.left), wordRight: wr && Math.round(wr.right),
      dy: wr ? Math.round(cr.top - wr.top) : null, h: Math.round(cr.height), anim: cs.animationName, opacity: cs.opacity, word: w && w.textContent };
  }, label);
  const fmt = (r) => `${r.label.padEnd(26)} visible=${r.visible} caret x=${r.x} | word «${r.word}» ${r.wordLeft}–${r.wordRight}, dy=${r.dy}, h=${r.h}, anim=${r.anim}, opacity=${r.opacity}`;
  console.log(fmt(await st('no selection')));
  const first = await page.evaluate(() => [...document.querySelectorAll('.tscroll [data-i]')][14].dataset.i);
  await page.locator(`.tscroll [data-i="${first}"]`).click(); await page.waitForTimeout(80);
  console.log(fmt(await st('click (caret after word)')));
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(80);
  console.log(fmt(await st('↓')));
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(80);
  console.log(fmt(await st('← (caret before word)')));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(80);
  console.log(fmt(await st('→, Shift+→ ×2')));
  // blink: sample opacity over 2 s after the 0.5 s solid period
  await page.waitForTimeout(600);
  const ops = [];
  for (let k = 0; k < 8; k++) { ops.push(await page.evaluate(() => getComputedStyle(document.querySelector('.caret')).opacity)); await page.waitForTimeout(260); }
  console.log('blink opacity samples (every 0.26 s):', ops.join(' '));
  await page.locator('.tscroll').screenshot({ path: join(outDir, '25-caret.png'), clip: undefined });
  // waveform region selected → caret dimmed, not blinking
  await page.evaluate(() => { const S = window.__carver; S.selectRegion(S.edl.regions[0]); });
  await page.waitForTimeout(150);
  console.log(fmt(await st('waveform region selected')));
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  console.log(fmt(await st('Esc ×2 (deselect)')));
}
if (steps.includes('chime')) {
  // 1) the sound itself, rendered offline: length, loudness, no clipping
  const snd = await page.evaluate(async () => {
    const out = {};
    for (const kind of ['done', 'error']) {
      const sr = 48000, oc = new OfflineAudioContext(1, sr * 3, sr);
      const len = window.__carverChime.scheduleJingle(oc, oc.destination, 0, kind);
      const x = (await oc.startRendering()).getChannelData(0);
      let peak = 0, last = 0, acc = 0;
      for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; if (a > 0.001) last = i; acc += x[i] * x[i]; }
      out[kind] = { scheduledS: +len.toFixed(2), audibleS: +(last / sr).toFixed(2), peakDb: +(20 * Math.log10(peak)).toFixed(1), rmsDb: +(10 * Math.log10(acc / x.length)).toFixed(1) };
    }
    return out;
  });
  console.log('jingle (offline render):', JSON.stringify(snd));
  // 2) when it plays — fast settings for the logic test
  await page.evaluate(() => { const c = window.__carverChime.cfg; c.idleMs = 800; c.minBusyMs = 1500; window.__carverChime.log.length = 0; });
  const S = (fn, arg) => page.evaluate(fn, arg);
  const count = () => page.evaluate(() => window.__carverChime.log.map((x) => x.kind));
  const task = (kind) => S((kind) => window.__carver.setTask({ kind, frac: 0.5, text: 'тест', cancel: () => window.__carver.setTask(null) }), kind);
  const idle = () => S(() => window.__carver.setTask(null));
  // a) chain of steps with short gaps → exactly one chime, after the LAST step
  await task('transcribe'); await page.waitForTimeout(1000); await idle(); await page.waitForTimeout(300);
  await task('fillers'); await page.waitForTimeout(700); await idle(); await page.waitForTimeout(200);
  await task('llm'); await page.waitForTimeout(1200);
  const midChain = (await count()).length;
  await idle(); await page.waitForTimeout(400);
  const beforeIdle = (await count()).length;
  await page.waitForTimeout(800);
  console.log(`chain of 3 steps with gaps: chimes during chain ${midChain}, right after last step ${beforeIdle}, after ${0.8 + 0.4}s idle → ${JSON.stringify(await count())}`);
  // b) short operation → silent
  await S(() => { window.__carverChime.log.length = 0; });
  await task('open'); await page.waitForTimeout(400); await idle(); await page.waitForTimeout(1300);
  console.log('short operation (0.4 s):', JSON.stringify(await count()));
  // c) stopped by the user → silent
  await task('llm'); await page.waitForTimeout(2000); await S(() => window.__carver.cancelTask()); await page.waitForTimeout(1300);
  console.log('stopped with «Стоп»:', JSON.stringify(await count()));
  // d) ended with an error → error variant
  await task('llm'); await page.waitForTimeout(2000); await S(() => { window.__carver.setTask(null); window.__carver.toast('Ошибка ИИ: тест', 'err'); }); await page.waitForTimeout(1300);
  console.log('ended with an error:', JSON.stringify(await count()));
  // e) «Без звука» in settings → silent
  await S(() => { window.__carverChime.log.length = 0; window.__carver.openSettings('stt'); });
  await page.getByRole('button', { name: '🔕 Без звука' }).click();
  await shot('26-sound-setting');
  await page.keyboard.press('Escape'); await S(() => window.__carver.openSettings(null));
  await task('llm'); await page.waitForTimeout(2000); await idle(); await page.waitForTimeout(1300);
  console.log('sound off:', JSON.stringify(await count()));
  await S(() => window.__carver.openSettings('stt')); await page.getByRole('button', { name: '🔔 Звук' }).click(); await S(() => window.__carver.openSettings(null));
  await page.evaluate(() => { const c = window.__carverChime.cfg; c.idleMs = 2500; c.minBusyMs = 12000; window.__carverChime.log.length = 0; });
}
if (steps.includes('titles')) {
  const titlePath = (args.find((a) => !a.startsWith('--') && /intro/i.test(a))) || (process.env.TITLE || '');
  // 1) clean slate, then upload the заставка into the library
  await page.getByRole('button', { name: 'Заставки', exact: true }).click();
  await page.evaluate(async () => { const S = window.__carver; S.project.titles = []; S.recompute(); S.bump(); for (const t of [...S.titleLib]) await S.removeTitleAsset(t.id); });
  await page.setInputFiles('#carver-title-input', titlePath);
  await page.waitForSelector('.sugg:has-text("glvrd-intro-clean")', { timeout: 20000 });
  const lib = await page.evaluate(() => window.__carver.titleLib.map((t) => ({ name: t.name, dur: +t.duration.toFixed(2), wh: t.width + 'x' + t.height, audio: t.hasAudio })));
  console.log('library:', JSON.stringify(lib));
  // 2) place playhead inside a kept segment and insert
  const anchor = await page.evaluate(() => { const S = window.__carver; const seg = S.edl.segments.find((x) => x.end - x.start > 8); const t = (seg.start + seg.end) / 2; window.__carverPlayer.seekSrc(t); return t; });
  const ins = await page.evaluate((t) => window.__carver.insertTitle(window.__carver.titleLib[0].id, t), anchor);
  const c0 = await page.evaluate(() => { const C = window.__carver.composite; return { dur: C.duration, clips: C.clips.map((c) => c.kind), titleCount: C.clips.filter((c) => c.kind === 'title').length }; });
  console.log(`inserted at ${anchor.toFixed(2)}:`, JSON.stringify(ins), JSON.stringify(c0));
  // timing: srcToOut jumps by title duration after the anchor; outToSrc inside title returns the title clip
  const map = await page.evaluate((anchor) => { const C = window.__carver.composite; return { before: C.srcToOut(anchor - 0.5), after: C.srcToOut(anchor + 0.5), inside: C.outToSrc(C.srcToOut(anchor - 0.5) + 1.5).clip.kind }; }, anchor);
  console.log('mapping:', JSON.stringify(map), '(before < after by ~title dur; inside title =', map.inside === 'title', ')');
  await shot('28-titles');
  // 3) trim: select the title (its marker), nudge b in by 10 px via keyboard
  await page.evaluate(() => { const S = window.__carver; S.titleSel = { id: S.project.titles[0].id, handle: 'b' }; S.bump(); });
  await page.evaluate(() => (document.activeElement || {}).blur && document.activeElement.blur());   // focus was on the file input
  await page.keyboard.press('Tab');   // ensure handle 'a'
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const trimmed = await page.evaluate(() => { const t = window.__carver.project.titles[0]; return { a: +t.a.toFixed(3), b: +t.b.toFixed(3) }; });
  console.log('after ← trim:', JSON.stringify(trimmed), '(b < 3.75)');
  await shot('29-title-selected');
  // 4) delete with Delete key
  await page.evaluate(() => { const S = window.__carver; S.titleSel = { id: S.project.titles[0].id, handle: 'b' }; S.bump(); });
  await page.evaluate(() => (document.activeElement || {}).blur && document.activeElement.blur());
  await page.keyboard.press('Delete');
  const afterDel = await page.evaluate(() => ({ titles: window.__carver.project.titles.length, dur: window.__carver.composite.duration }));
  console.log('after Delete:', JSON.stringify(afterDel));
  // 5) re-insert and EXPORT to verify composite (video includes title frames, audio length matches)
  await page.evaluate((t) => window.__carver.insertTitle(window.__carver.titleLib[0].id, t), anchor);
  const seg = await page.evaluate(() => window.__carver.edl.segments.find((x) => x.end - x.start > 8));
  const clip = await page.evaluate(() => { const C = window.__carver.composite; return C.clips.find((c) => c.kind === 'title'); });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => { window.__carverTestHandle = async () => (await navigator.storage.getDirectory()).getFileHandle('export.mp4', { create: true }); });
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click();
  await page.getByRole('button', { name: /Экспортировать MP4/ }).click();
  await page.waitForTimeout(1000);
  await waitFor((st) => st && !st.task, 'export', 1800);
  const dlP = page.waitForEvent('download');
  await page.evaluate(async () => { const f = await (await (await navigator.storage.getDirectory()).getFileHandle('export.mp4')).getFile(); const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = 'export.mp4'; document.body.appendChild(a); a.click(); });
  await (await dlP).saveAs(join(outDir, 'export.mp4'));
  const st = await page.evaluate(() => { const S = window.__carver; return { outDur: S.composite.duration, mainDur: S.edl.outDuration }; });
  console.log('export: composite', st.outDur.toFixed(2), 's = main', st.mainDur.toFixed(2), '+ title', (st.outDur - st.mainDur).toFixed(2));
  writeFileSync(join(outDir, 'title-map.json'), JSON.stringify({ anchor: clip.anchor, titleOut: clip.out, titleDur: clip.b - clip.a, mainBefore: clip.out }));
  console.log(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,duration,nb_frames,r_frame_rate', '-of', 'compact', join(outDir, 'export.mp4')]).toString());
}
if (steps.includes('persist')) {
  const id = await page.evaluate(() => { const S = window.__carver; S.toggleRange(20, 22); return S.project.id; });
  await page.reload();   // immediately: the edit must survive via the pagehide/visibilitychange flush
  const kept = await page.evaluate(async (id) => {
    const db = await new Promise((r) => { const q = indexedDB.open('carver'); q.onsuccess = () => r(q.result); });
    const p = await new Promise((r) => { const q = db.transaction('projects').objectStore('projects').get(id); q.onsuccess = () => r(q.result); });
    return p.wordState.slice(18, 25).join('');
  }, id);
  console.log('persist after instant reload (words 18-24):', kept);
}
if (steps.includes('offline')) {
  await page.reload(); await page.waitForTimeout(1500);   // make sure the SW controls the page and caches assets
  const sw = await page.evaluate(() => !!navigator.serviceWorker?.controller);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForTimeout(1500);
  const ok = await page.locator('.logo').count();
  console.log('offline: sw controller', sw, '; app shell loaded offline:', ok > 0, '; projects listed:', await page.locator('.pitem').count());
  await ctx.setOffline(false);
}
console.log('done', el());
await page.waitForTimeout(1500);   // let the autosave land
await ctx.close();
