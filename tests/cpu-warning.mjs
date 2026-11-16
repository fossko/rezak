// ⚠️ «Расшифровка идёт на процессоре» on the TaskBar, its hover card, «Изменить на WebGPU» (switch +
// resume from the checkpoint), the disabled button when the page has no WebGPU, and the
// «Диагностика видеокарты» report in ⚙ «Распознавание речи».
// Usage (built app on 5200): node tests/cpu-warning.mjs <video> [--url=http://127.0.0.1:5200/]
// Uses the main test profile with Whisper Base (small CPU download) and restores `carver:prefs` at the end.
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith('--'));
const url = (args.find((a) => a.startsWith('--url=')) || '--url=http://127.0.0.1:5200/').slice(6);
const tmp = process.env.TMPDIR || '/tmp', outDir = join(tmp, 'carver-test-out');
mkdirSync(outDir, { recursive: true });
const log = (s) => process.stdout.write(s + '\n');   // unbuffered: the run is long
const T0 = Date.now(), el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
let ok = true;
const check = (c, what) => { log((c ? 'ok   ' : 'FAIL ') + what); if (!c) ok = false; };
const watchdog = setTimeout(() => { log('FAIL watchdog: 15 min'); process.exit(2); }, 15 * 60 * 1000);

const ctx = await chromium.launchPersistentContext(join(tmp, 'carver-test-profile'), {
  channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true, viewport: { width: 1500, height: 920 },
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
});
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', (e) => log('  PAGEERROR ' + e.message));
page.on('console', (m) => { const t = m.text(); if (/models ready|WARN|WebGPU/.test(t)) log('  page ' + t.slice(0, 300)); });

const task = () => page.evaluate(() => {
  const t = window.__carver.task;
  return t && { kind: t.kind, frac: +t.frac.toFixed(3), text: String(t.text).slice(0, 70), asr: t.asr };
});
async function waitTask(fn, what, s = 240) {
  const t = Date.now(); let last;
  while (Date.now() - t < s * 1000) { last = await task(); if (fn(last)) return last; await page.waitForTimeout(500); }
  throw new Error(`timeout ${s}s: ${what} · last=${JSON.stringify(last)}`);
}
async function card() {
  await page.hover('[data-cpu-warning]'); await page.waitForTimeout(200);
  return page.evaluate(() => {
    const pop = document.querySelector('.cpuwarn-pop'); if (!pop) return null;
    const b = pop.querySelector('button'), r = pop.getBoundingClientRect(), br = b.getBoundingClientRect();
    const hit = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
    return { shown: getComputedStyle(pop).display !== 'none', text: pop.innerText.replace(/\s+/g, ' ').trim(),
      disabled: b.disabled, inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.top >= 0,
      buttonOnTop: hit === b };
  });
}

let savedPrefs = null;
try {
  await page.goto(url);
  savedPrefs = await page.evaluate(() => localStorage.getItem('carver:prefs'));

  // ---------- 1. diagnostics ----------
  await page.evaluate(() => window.__carver.openSettings('stt'));
  await page.click('[data-gpu-diag] summary');
  await page.waitForFunction(() => /chrome:\/\/gpu/.test(document.querySelector('[data-gpu-diag] textarea')?.value || ''), null, { timeout: 30000 });
  const diag = await page.$eval('[data-gpu-diag] textarea', (t) => t.value);
  log('---- diagnostics ----\n' + diag + '\n---------------------');
  check(/== WebGPU \(страница\)\nnavigator\.gpu: есть/.test(diag), 'diagnostics: WebGPU listed for the page');
  check(/== WebGPU \(фоновый поток[^\n]*\nnavigator\.gpu: есть/.test(diag), 'diagnostics: WebGPU listed for the worker');
  check(/platform: .*arch: arm/.test(diag) && /ядер CPU: \d+/.test(diag) && /WebGL: /.test(diag), 'diagnostics: platform / CPU / WebGL lines');
  await page.screenshot({ path: join(outDir, 'cpu-01-diagnostics.png') });
  await page.evaluate(() => window.__carver.openSettings(null));

  // ---------- 2. real CPU transcription → ⚠️ → «Изменить на WebGPU» ----------
  await page.evaluate(() => { const o = JSON.parse(localStorage.getItem('carver:prefs') || '{}'); localStorage.setItem('carver:prefs', JSON.stringify({ ...o, device: 'wasm', model: 'onnx-community/whisper-base' })); });
  await page.reload();
  await page.evaluate(() => { if (window.__carver.project) window.__carver.closeProject(); });
  await page.setInputFiles('#carver-file-input', video);
  await page.waitForFunction(() => window.__carver.pcm && window.__carver.task?.kind !== 'extract', null, { timeout: 240000 });
  log(el() + ' audio extracted');
  // the app starts transcription by itself after extraction; only kick it if it is not there in 5 s
  // (never `await` transcribe() in evaluate: that would wait for the whole CPU run)
  for (let i = 0; i < 10 && (await task())?.kind !== 'transcribe'; i++) await page.waitForTimeout(500);
  if ((await task())?.kind !== 'transcribe') await page.evaluate(() => { void window.__carver.transcribe(); });
  const cpu = await waitTask((t) => t?.kind === 'transcribe' && t.asr, 'CPU transcription running', 240);
  log(el() + ' running ' + JSON.stringify(cpu));
  check(cpu.asr.device === 'wasm' && cpu.asr.why === 'выбрано в настройках', 'task carries { device: wasm, why: «выбрано в настройках» }');
  check(await page.isVisible('[data-cpu-warning]'), '⚠️ visible next to the progress bar');
  const c1 = await card();
  log('  card ' + JSON.stringify(c1));
  await page.screenshot({ path: join(outDir, 'cpu-02-warning-hover.png') });
  check(!!c1?.shown && c1.inView && c1.buttonOnTop, 'hover card is shown, inside the viewport, button hit-testable');
  check(!!c1 && !c1.disabled && /процессоре/.test(c1.text) && /медленнее/.test(c1.text) && /Изменить на WebGPU/.test(c1.text),
    'card explains CPU + slowness and offers the enabled WebGPU button');

  // switch while running, at the first visible progress
  await waitTask((t) => t?.frac > 0.01, 'some CPU progress', 240);
  const before = await task();
  const tSwitch = Date.now();
  const c1b = await card();            // re-hover right before the click: the task text changes every tick
  check(!!c1b?.shown && c1b.buttonOnTop, 'card stays reachable while the progress text changes');
  await page.click('.cpuwarn-pop button', { timeout: 8000 });
  await page.waitForTimeout(700);
  const toasts0 = await page.evaluate(() => window.__carver.toasts.map((t) => t.text));
  const gpu = await waitTask((t) => t?.kind === 'transcribe' && t.asr?.device === 'webgpu', 'GPU transcription', 240);
  log(el() + ` switched in ${((Date.now() - tSwitch) / 1000).toFixed(1)} s, frac ${before.frac} → ${gpu.frac}`);
  check((await page.evaluate(() => JSON.parse(localStorage.getItem('carver:prefs')).device)) === 'webgpu', 'prefs.device is now «webgpu»');
  // A checkpoint is written after a WHOLE 5-min speech window, so an early switch legitimately starts over:
  // what matters is that the wording of the toast matches what actually happened.
  const resumed = gpu.frac > 0.01;
  const saidResume = toasts0.some((t) => /продолжу с того же места/.test(t));
  check(saidResume === resumed || (gpu.frac === 0 && !saidResume),
    `toast wording matches reality (frac ${gpu.frac}, «продолжу» said: ${saidResume})`);
  log('  toast on switch: ' + JSON.stringify(toasts0));
  check(!(await page.isVisible('[data-cpu-warning]')), '⚠️ gone once on WebGPU');
  check(toasts0.some((t) => /Переключаю/.test(t)) && !toasts0.some((t) => /остановлена/.test(t)), 'toast «Переключаю…», no «остановлена» toast');
  // the switched run must keep going on its own (no crash, no error toast)
  await page.waitForTimeout(20000);
  const st = await page.evaluate(() => ({ words: window.__carver.project?.words.length || 0, task: window.__carver.task && { kind: window.__carver.task.kind, frac: +window.__carver.task.frac.toFixed(2) }, toasts: window.__carver.toasts.map((t) => t.text) }));
  log('  after 20 s on GPU: ' + JSON.stringify(st));
  check(!!st.task && st.task.kind === 'transcribe' && st.task.frac > gpu.frac, 'GPU transcription advances on its own');
  check(!st.toasts.some((t) => /Ошибка расшифровки/.test(t)), 'no «Ошибка расшифровки» toast');
  await page.screenshot({ path: join(outDir, 'cpu-03-after-switch.png') });
  await page.evaluate(() => window.__carver.cancelTask()); await page.waitForTimeout(1000);

  // ---------- 3. page without WebGPU: button present but disabled ----------
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }); });
  await page.reload();
  await page.waitForFunction(() => !!window.__carver, null, { timeout: 60000 });
  check(await page.evaluate(() => !navigator.gpu), 'stub active: navigator.gpu is gone in this page');
  await page.evaluate(() => window.__carver.setTask({
    kind: 'transcribe', frac: 0.35, text: 'Расшифровка 35%', cancel: () => {},
    asr: { device: 'wasm', why: 'браузер не дал адаптер WebGPU (requestAdapter → null)' },
  }));
  await page.waitForTimeout(500);
  const c2 = await card();
  log('  card (no WebGPU) ' + JSON.stringify(c2));
  await page.screenshot({ path: join(outDir, 'cpu-04-nogpu.png') });
  check(!!c2?.shown && c2.disabled, 'without WebGPU the button is still there but disabled');
  check(!!c2 && /недоступен/.test(c2.text) && /Диагностика видеокарты/.test(c2.text), 'card explains WebGPU is unavailable and points to the diagnostics');
  check(/браузер не дал адаптер/.test(c2?.text || ''), 'card shows the reason coming from the worker');
} catch (e) {
  ok = false; log('FAIL ' + e.message);
} finally {
  await page.evaluate((s) => { if (s == null) localStorage.removeItem('carver:prefs'); else localStorage.setItem('carver:prefs', s); }, savedPrefs).catch(() => {});
  await ctx.close();
  clearTimeout(watchdog);
}
log(el() + (ok ? ' ALL OK' : ' SOME CHECKS FAILED'));
process.exit(ok ? 0 : 1);
