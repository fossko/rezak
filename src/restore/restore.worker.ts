/// <reference lib="webworker" />
// «Реставрация» worker: Sidon v0.1 speech restoration (sarulab-speech, MIT) as ONNX
// (soniqo/Sidon-ONNX: fp16 w2v-BERT 2.0 predictor + fp32 DAC vocoder) on WebGPU, WASM as a slow fallback.
// The fp16 vocoder is NOT usable on WebGPU: its weight-norm (ReduceL2, evaluated at run time) overflows in fp16
// and the output collapses to ~−75 dBFS (measured; on WASM it is fine). The fp32 vocoder matches the WASM
// fp16 output with correlation 0.9999999.
// The model is downloaded from Hugging Face (pinned commit) and, if that fails, from the app's own
// mirror under ./models (same layout as the Whisper mirror; `node deploy/sync-models.mjs`). Files are kept
// in Cache Storage, so the download happens once per browser.
//
// Messages (RPC, see lib/rpc.ts): load → {ep}; tile → restored audio of one tile (see restore/engine.ts).
import * as ort from 'onnxruntime-web/webgpu';
import { w2vBertFeatures } from './frontend';
import { shelfCoefs, hpCoefs, type Biquad } from '../lib/loudness';

declare const self: DedicatedWorkerGlobalScope;

const REPO = 'soniqo/Sidon-ONNX';
const REV = 'a6dce244cbcd0361ef79c030e246e6f9671770c1';
export const SIDON_FILES = [
  { path: 'fp16/sidon-predictor.onnx', size: 387515203 },
  { path: 'fp32/sidon-vocoder.onnx', size: 209947463 },
];
const PRIMARY = (p: string) => `https://huggingface.co/${REPO}/resolve/${REV}/${p}`;
const MIRROR = (p: string) => new URL(`../models/${REPO}/resolve/main/${p}`, self.location.href).href;
const CACHE = 'carver-sidon-v1';
const STALL_MS = 30000;

const WET_LAG = 336;   // 7 ms at 48 kHz
const post = (m: any) => self.postMessage(m);
let pred: ort.InferenceSession | null = null, voc: ort.InferenceSession | null = null, ep = '';

/** Download one file with progress; throws on HTTP errors, stalls and size mismatch. */
async function fetchFile(url: string, size: number, onBytes: (n: number) => void): Promise<Uint8Array> {
  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort(), STALL_MS);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const out = new Uint8Array(size);
    const rd = r.body.getReader();
    let o = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      clearTimeout(timer); timer = setTimeout(() => ac.abort(), STALL_MS);
      if (o + value.length > size) throw new Error('файл больше ожидаемого');
      out.set(value, o); o += value.length; onBytes(value.length);
    }
    if (o !== size) throw new Error(`получено ${o} из ${size} байт`);
    return out;
  } finally { clearTimeout(timer); }
}

async function getFile(path: string, size: number, progress: (n: number) => void): Promise<Uint8Array> {
  const cache = await caches.open(CACHE).catch(() => null);
  const key = PRIMARY(path);
  const hit = await cache?.match(key);
  if (hit) {
    const b = new Uint8Array(await hit.arrayBuffer());
    if (b.length === size) { progress(size); return b; }
  }
  let data: Uint8Array | null = null, firstErr = '';
  let got = 0;
  const count = (n: number) => { got += n; progress(n); };
  try { data = await fetchFile(key, size, count); }
  catch (e: any) {
    firstErr = e?.message || String(e);
    progress(-got); got = 0;
    console.warn('[carver] Sidon: Hugging Face failed, using the mirror', firstErr);
    try { data = await fetchFile(MIRROR(path), size, count); }
    catch (e2: any) { progress(-got); throw new Error(`не удалось скачать модель (Hugging Face: ${firstErr}; запасной сервер: ${e2?.message || e2})`); }
  }
  await cache?.put(key, new Response(data as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream' } })).catch((e) => console.warn('[carver] Sidon cache put failed', e));
  return data;
}

async function load(force?: string): Promise<{ ep: string }> {
  if (pred && voc) return { ep };
  const total = SIDON_FILES.reduce((a, f) => a + f.size, 0);
  let done = 0;
  const bufs: Uint8Array[] = [];
  for (const f of SIDON_FILES) {
    bufs.push(await getFile(f.path, f.size, (n) => { done += n; post({ type: 'progress', phase: 'download', done, total }); }));
  }
  post({ type: 'progress', phase: 'init', done: total, total });
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  let gpu = false;
  try { gpu = !!(await (navigator as any).gpu?.requestAdapter()); } catch { /* no WebGPU */ }
  const tryEp = async (e: string) => {
    const so: ort.InferenceSession.SessionOptions = { executionProviders: [e], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    const p = await ort.InferenceSession.create(bufs[0], so);
    const v = await ort.InferenceSession.create(bufs[1], so);
    pred = p; voc = v; ep = e;
  };
  if (force === 'wasm') gpu = false;
  if (gpu) { try { await tryEp('webgpu'); } catch (e) { console.warn('[carver] Sidon WebGPU failed, falling back to WASM', e); } }
  if (!pred) await tryEp('wasm');
  return { ep };
}

// ---------------------------------------------------------------- DSP helpers
function biquad(x: Float32Array, c: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
/** 2nd-order Butterworth high-pass (Sidon's demo applies 50 Hz before the model). */
function hpButter(fs: number, f: number): Biquad {
  const K = Math.tan(Math.PI * f / fs), Q = Math.SQRT1_2, a0 = 1 + K / Q + K * K;
  return { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
}
/** K-weighted energy per 400 ms block (BS.1770 stages), for the loudness match. */
function kBlocks(x: Float32Array, fs: number): Float64Array {
  const y = biquad(biquad(x, shelfCoefs(fs)), hpCoefs(fs));
  const B = Math.round(0.4 * fs), n = Math.floor(y.length / B);
  const e = new Float64Array(n);
  for (let k = 0; k < n; k++) { let s = 0; for (let i = k * B; i < (k + 1) * B; i++) s += y[i] * y[i]; e[k] = s / B; }
  return e;
}

/**
 * One tile. `x` = 16 kHz mono context window (Int16 scale /32768), `c0`/`c1` = core range inside it
 * (16 kHz samples). Returns the restored core resampled to `sr` (exactly round((c1-c0)·sr/16000) samples),
 * loudness-matched to the dry core so the loudness model of the Аудио tab stays valid.
 */
async function tile(x: Float32Array, c0: number, c1: number, sr: number): Promise<{ wet: Float32Array; gainDb: number; ms: number }> {
  if (!pred || !voc) throw new Error('модель не загружена');
  const t0 = performance.now();
  const hp = biquad(x, hpButter(16000, 50));
  const padded = new Float32Array(hp.length + 320); padded.set(hp, 160);
  const { data, T } = w2vBertFeatures(padded);
  const f = await pred.run({ input_features: new ort.Tensor('float32', data, [1, T, 160]) });
  const a = await voc.run({ features: f.features });
  const y = a.audio.data as Float32Array;   // 48 kHz, sample 3i ↔ input sample i
  f.features.dispose?.();
  // core at 48 kHz (the vocoder output may be a few samples short at the very end). Sidon's output lags the
  // input by a constant ~7 ms (speech-envelope cross-correlation: 7–8 ms in every 20 s window, no drift), so the
  // core is read WET_LAG samples later — otherwise the dry/wet mix smears every onset.
  const n48 = (c1 - c0) * 3, core = new Float32Array(n48);
  const s48 = c0 * 3 + WET_LAG;
  core.set(y.subarray(s48, Math.min(y.length, s48 + n48)));
  a.audio.dispose?.();
  // loudness match on gated 400 ms blocks of the dry core
  const dry = x.subarray(c0, c1);
  const ed = kBlocks(dry, 16000), ew = kBlocks(core, 48000);
  const n = Math.min(ed.length, ew.length);
  let mx = 0; for (let k = 0; k < n; k++) mx = Math.max(mx, ed[k]);
  let sd = 0, sw = 0, used = 0;
  for (let k = 0; k < n; k++) if (ed[k] > mx * 0.01 && ed[k] > 1e-7) { sd += ed[k]; sw += ew[k]; used++; }
  let gainDb = NaN;
  if (used >= 2 && sw > 0) gainDb = Math.max(-24, Math.min(24, 10 * Math.log10(sd / sw)));
  // resample to the source rate (linear; 48 kHz sources — the usual case — are copied)
  const nOut = Math.round((c1 - c0) * sr / 16000);
  let wet: Float32Array;
  if (sr === 48000) wet = core;
  else {
    wet = new Float32Array(nOut);
    const r = 48000 / sr;
    for (let i = 0; i < nOut; i++) {
      const p = i * r, j = Math.floor(p), fr = p - j;
      wet[i] = (core[j] ?? 0) * (1 - fr) + (core[j + 1] ?? 0) * fr;
    }
  }
  return { wet, gainDb, ms: performance.now() - t0 };
}

self.onmessage = async ({ data: m }) => {
  try {
    let result: any, transfer: Transferable[] = [];
    if (m.type === 'load') result = await load(m.ep);
    else if (m.type === 'tile') {
      const r = await tile(m.x, m.c0, m.c1, m.sr);
      result = r; transfer = [r.wet.buffer];
    } else throw new Error('unknown message ' + m.type);
    self.postMessage({ id: m.id, ok: true, result }, transfer);
  } catch (e: any) {
    self.postMessage({ id: m.id, ok: false, error: e?.message || String(e) });
  }
};
