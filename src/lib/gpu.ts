// WebGPU availability (for the «Изменить на WebGPU» button) and the hardware diagnostics report
// (⚙ «Распознавание речи» → «Диагностика видеокарты»). Everything here is read-only probing.

let avail: Promise<boolean> | null = null;
/** Can this browser get a WebGPU adapter on the main thread? Cached; `fresh` re-probes. */
export function webgpuAvailable(fresh = false): Promise<boolean> {
  if (!avail || fresh) {
    avail = (async () => {
      try { return !!(await (navigator as any).gpu?.requestAdapter()); } catch { return false; }
    })();
  }
  return avail;
}

/** One adapter probe; runs on the main thread and (as source text) inside a worker — so it must stay
 *  self-contained: no references to anything outside its own body (the minifier renames outer names). */
async function probeAdapters(): Promise<string[]> {
  const LIMITS = ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize',
    'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX'];
  const out: string[] = [];
  const gpu = (navigator as any).gpu;
  if (!gpu) { out.push('navigator.gpu: нет (WebGPU выключен или не поддерживается)'); return out; }
  out.push('navigator.gpu: есть; preferred canvas format: ' + (gpu.getPreferredCanvasFormat?.() ?? '?'));
  for (const pp of [undefined, 'high-performance', 'low-power']) {
    const tag = 'adapter(' + (pp || 'default') + ')';
    try {
      const a = await gpu.requestAdapter(pp ? { powerPreference: pp } : undefined);
      if (!a) { out.push(tag + ': null — браузер не дал адаптер'); continue; }
      const i = a.info || {};
      out.push(`${tag}: vendor=${i.vendor || '?'} architecture=${i.architecture || '?'} device=${i.device || '?'} description=${i.description || '?'}` +
        ` fallback=${a.isFallbackAdapter ?? i.isFallbackAdapter ?? '?'}`);
      if (!pp) {
        out.push('  features: ' + [...a.features].sort().join(', '));
        out.push('  limits: ' + LIMITS.map((k) => `${k}=${a.limits[k]}`).join(' '));
        try { const d = await a.requestDevice(); out.push('  requestDevice: ok'); d.destroy(); }
        catch (e: any) { out.push('  requestDevice: ОШИБКА ' + (e?.message || e)); }
      }
    } catch (e: any) { out.push(tag + ': ОШИБКА ' + (e?.message || e)); }
  }
  return out;
}

/** The same probe inside a dedicated worker — transcription runs in a worker, and its view of the GPU can differ. */
function probeInWorker(): Promise<string[]> {
  const src = `const probe=${probeAdapters.toString()};probe().then((r)=>postMessage(r),(e)=>postMessage(['ОШИБКА '+e]));`;
  return new Promise((resolve) => {
    let w: Worker;
    try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
    catch (e: any) { resolve(['не удалось запустить worker: ' + (e?.message || e)]); return; }
    const t = setTimeout(() => { w.terminate(); resolve(['нет ответа за 10 с']); }, 10000);
    w.onmessage = (m) => { clearTimeout(t); w.terminate(); resolve(m.data); };
    w.onerror = (e) => { clearTimeout(t); w.terminate(); resolve(['ошибка worker: ' + (e.message || '?')]); };
  });
}

function webgl(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return 'нет WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? `${gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)} / ${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}` : String(gl.getParameter(gl.RENDERER));
  } catch (e: any) { return 'ошибка ' + (e?.message || e); }
}

/** Plain-text report for the user to read or paste into a bug report. `extra` = app-level lines (settings, last model load). */
export async function gpuDiagnostics(extra: string[]): Promise<string> {
  const n: any = navigator, L: string[] = [];
  L.push('Резак — диагностика, ' + new Date().toLocaleString('ru-RU'));
  L.push('Адрес: ' + location.origin + location.pathname);
  L.push('');
  L.push('== Браузер и система');
  L.push('userAgent: ' + n.userAgent);
  try {
    const h = await n.userAgentData?.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList']);
    if (h) L.push(`platform: ${h.platform} ${h.platformVersion || ''} · arch: ${h.architecture || '?'} ${h.bitness || ''} · ` +
      (h.fullVersionList || []).map((b: any) => `${b.brand} ${b.version}`).join(', '));
  } catch { /* not Chromium */ }
  L.push(`ядер CPU: ${n.hardwareConcurrency ?? '?'} · память (оценка браузера): ${n.deviceMemory ? n.deviceMemory + ' ГБ' : '?'}` +
    ` · экран: ${screen.width}×${screen.height} @${devicePixelRatio}x`);
  L.push(`secure context: ${isSecureContext} · crossOriginIsolated: ${crossOriginIsolated}`);
  L.push('WebGL: ' + webgl());
  L.push('');
  L.push('== WebGPU (страница)');
  L.push(...await probeAdapters());
  L.push('');
  L.push('== WebGPU (фоновый поток, где идёт расшифровка)');
  L.push(...await probeInWorker());
  L.push('');
  L.push('== Резак');
  L.push(...extra);
  try {
    const est = await navigator.storage?.estimate();
    L.push(`хранилище: постоянное=${await navigator.storage?.persisted?.()} · занято ${est?.usage ? (est.usage / 1e9).toFixed(2) : '?'} ГБ из ${est?.quota ? (est.quota / 1e9).toFixed(0) : '?'} ГБ`);
  } catch { /* */ }
  L.push('');
  L.push('Подробнее о видеокарте в Chrome: откройте chrome://gpu');
  return L.join('\n');
}
