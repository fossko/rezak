/// <reference lib="webworker" />
// Speech worker: Whisper (Transformers.js, WebGPU or WASM) + wav2vec2 CTC (Russian) forced alignment.
// Ported from whisper-web/word-accurate-stt.html (same models, dtypes, alignment algorithm).
import {
  pipeline, env, WhisperTextStreamer, AutoModelForCTC, AutoFeatureExtractor,
  type AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers';
import { probeWebGPU, type GpuProbeResult } from '../lib/gpu-probe';

declare const self: DedicatedWorkerGlobalScope;
env.allowLocalModels = false;
env.useBrowserCache = true;

// --- Local model fallback -------------------------------------------------------------------
// Prefer the Hugging Face hub. If a model file cannot be fetched from there (blocked region,
// no network, non-200), retry the same path against the app's own copy under ./models. The
// mirror keeps HF's layout — models/<model-id>/resolve/main/<file> — so only the host differs.
// Populate it with `node deploy/sync-models.mjs`; serve it with the `/models/` nginx location.
const HF_HOST = env.remoteHost;                                      // 'https://huggingface.co/'
const LOCAL_BASE = new URL('../models/', self.location.href).href;   // '<app-base>models/'
const baseFetch = env.fetch.bind(env);
const HF_TIMEOUT_MS = 20000;                                        // fail over if HF hangs
let warnedMirror = false;

function fetchWithTimeout(input: any, init: any, ms: number) {
  const ac = new AbortController();
  const outer: AbortSignal | undefined = init?.signal;
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const timer = setTimeout(() => ac.abort(), ms);
  return baseFetch(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
}

env.fetch = async (input: any, init?: any) => {
  const url: string = typeof input === 'string' ? input : input?.url ?? String(input);
  const mirror = url.startsWith(HF_HOST) ? LOCAL_BASE + url.slice(HF_HOST.length) : null;
  const tryMirror = async () => {
    if (!mirror) return null;
    try {
      const r = await baseFetch(mirror, init);
      if (r.status !== 200) return null;
      if (!warnedMirror) { warnedMirror = true; console.warn('[carver] Hugging Face unavailable — serving models from the local mirror', mirror); }
      return r;
    } catch { return null; }
  };
  try {
    const r = await fetchWithTimeout(input, init, HF_TIMEOUT_MS);
    if (r.status === 200) return r;
    return (await tryMirror()) ?? r;
  } catch (e) {
    const r = await tryMirror();
    if (r) return r;
    throw e;
  }
};


let asr: AutomaticSpeechRecognitionPipeline | null = null, loadedKey: string | null = null, info: any = null;

/** Why WebGPU is not usable in this worker (null = usable). */
let gpuWhy: string | null = null;
let gpuProbe: Promise<GpuProbeResult> | null = null;
async function gpuInfo(force = false) {
  const gpu = (navigator as any).gpu;
  if (force || !gpuProbe) {
    gpuProbe = probeWebGPU({
      gpu,
      attempts: 3,
      timeoutMs: 4000,
      onProgress: (text) => post({ event: 'gpu-progress', text }),
    });
  }
  const result = await gpuProbe;
  // The probe only establishes viability. Transformers creates and owns its own
  // device; release the probe device immediately (including on fallback).
  if (result.device) { try { result.device.destroy?.(); } catch { /* best effort */ } }
  if (!result.ok) {
    gpuWhy = !gpu
      ? 'в этом браузере нет WebGPU (navigator.gpu)'
      : result.reason === 'requestAdapter вернул null'
        ? 'браузер не дал адаптер WebGPU (requestAdapter → null)'
        : result.reason || 'WebGPU недоступен';
    post({ event: 'warn', text: `Видеокарта: ${gpuWhy}` });
    return null;
  }
  gpuWhy = null;
  return { f16: result.f16 };
}

function dtypeFor(model: string, device: string, f16: boolean) {
  const turbo = /large-v3-turbo/.test(model);
  if (device === 'webgpu') return { encoder_model: turbo ? (f16 ? 'fp16' : 'q4') : 'fp32', decoder_model_merged: 'q4' };
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

const post = (m: any, t?: Transferable[]) => self.postMessage(m, t || []);
const progress_callback = (p: any) => post({ event: 'load', ...p });

async function load({ model, device: pref }: { model: string; device: string }) {
  const gpu = await gpuInfo(true);
  let device = pref === 'auto' ? (gpu ? 'webgpu' : 'wasm') : pref;
  if (device === 'webgpu' && !gpu) throw new Error('WebGPU недоступен в этом браузере — выберите «Авто» или «WASM».');
  const key = model + '|' + device;
  if (asr && loadedKey === key) return info;
  if (asr) { try { await asr.dispose(); } catch { /* */ } asr = null; }
  const tryLoad = (dev: string) => pipeline('automatic-speech-recognition', model, {
    device: dev as any, dtype: dtypeFor(model, dev, !!gpu?.f16) as any, progress_callback,
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  // why we are NOT on the GPU (null when on it): the user's choice, no adapter, or a failed WebGPU start
  let why: string | null = device === 'wasm' ? (pref === 'wasm' ? 'выбрано в настройках' : gpuWhy) : null;
  try { asr = await tryLoad(device); }
  catch (e: any) {
    if (device !== 'webgpu' || pref === 'webgpu') throw e;
    why = 'не удалось запустить модель на WebGPU: ' + (e.message || e);
    post({ event: 'warn', text: why + '; переключаюсь на WASM (процессор).' });
    device = 'wasm'; asr = await tryLoad(device);
  }
  loadedKey = model + '|' + device;
  info = { device, dtype: dtypeFor(model, device, !!gpu?.f16), pref, why };
  return info;
}

async function transcribe({ buffer, language, chunk, stride, gen }: any) {
  if (!asr) throw new Error('model not loaded');
  const audio = new Float32Array(buffer);
  const seconds = audio.length / 16000;
  const jump = chunk - 2 * stride;
  const calls = seconds <= chunk ? 1 : 1 + Math.ceil((seconds - chunk) / jump);
  let done = 0;
  const a: any = asr;
  const fe = a.processor.feature_extractor.config;
  const streamer = new WhisperTextStreamer(a.tokenizer, {
    time_precision: fe.chunk_length / a.model.config.max_source_positions,
    callback_function: (text: string) => post({ event: 'text', text }),
    on_finalize: () => { done++; post({ event: 'chunk', done, total: calls }); },
  } as any);
  const opts: any = { chunk_length_s: chunk, stride_length_s: stride, return_timestamps: true, streamer, ...(gen || {}) };
  if (language && language !== 'auto') opts.language = language;
  opts.task = 'transcribe';
  const out: any = await a(audio, opts);
  return { text: out.text, chunks: (out.chunks || []).map((c: any) => ({ start: c.timestamp[0], end: c.timestamp[1], text: c.text })) };
}

// ---- wav2vec2 CTC (Russian, character level) ----
const CTC_MODEL = 'onnx-community/wav2vec2-large-xlsr-53-russian-ONNX';
// vocab.json of the model (fixed): 0 <pad> (CTC blank), 1 <s>, 2 </s>, 3 <unk>, 4 | (word separator), 5 -, 6 ё, 7…38 а…я
const ctcInv = ['<pad>', '<s>', '</s>', '<unk>', '|', '-', 'ё', ...'абвгдежзийклмнопрстуфхцчшщъыьэюя'];
const ctcVocab: Record<string, number> = Object.fromEntries(ctcInv.map((c, i) => [c, i]));
let ctc: any = null, ctcProc: any = null, ctcInfo: any = null, ctcKey: string | null = null;

async function ctcLoad({ device: pref }: { device: string }) {
  const gpu = await gpuInfo();
  if (pref === 'webgpu' && !gpu) throw new Error('WebGPU недоступен в этом worker — выберите «Авто» или «WASM».');
  let device = pref === 'auto' ? (gpu ? 'webgpu' : 'wasm') : pref;
  if (ctc && ctcKey === device) return ctcInfo;
  const dtypeOf = (dev: string) => (dev === 'webgpu' ? (gpu && gpu.f16 ? 'fp16' : 'q4') : 'q8');
  const tryLoad = (dev: string) => AutoModelForCTC.from_pretrained(CTC_MODEL, { device: dev as any, dtype: dtypeOf(dev) as any, progress_callback });
  try { ctc = await tryLoad(device); }
  catch (e: any) {
    if (device !== 'webgpu') throw e;
    post({ event: 'warn', text: 'wav2vec2: WebGPU не запустился (' + (e.message || e) + '), переключаюсь на WASM.' });
    device = 'wasm'; ctc = await tryLoad(device);
  }
  ctcProc = await AutoFeatureExtractor.from_pretrained(CTC_MODEL, { progress_callback });
  ctcKey = device;
  ctcInfo = { device, dtype: dtypeOf(device), model: CTC_MODEL };
  return ctcInfo;
}

// wav2vec2's self-attention is O(n²): a long input allocates [1, heads, T, T] and overflows int32
// ("Tensor shape is too large"). Callers normally pass a short speech region; this cap makes the
// worker safe for any length by running the model per ≤45 s piece and concatenating the emissions.
const CTC_CHUNK_S = 45;

async function emissionsOnce(audio: Float32Array) {
  const inputs = await ctcProc(audio);
  const { logits } = await ctc(inputs);
  const [, T, V] = logits.dims as number[];
  const d = logits.data as Float32Array;
  if (V !== ctcInv.length) throw new Error('wav2vec2: unexpected vocabulary size ' + V);
  const lp = new Float32Array(T * V);
  for (let t = 0; t < T; t++) {
    let mx = -Infinity;
    for (let v = 0; v < V; v++) if (d[t * V + v] > mx) mx = d[t * V + v];
    let s = 0; for (let v = 0; v < V; v++) s += Math.exp(d[t * V + v] - mx);
    const l = mx + Math.log(s);
    for (let v = 0; v < V; v++) lp[t * V + v] = d[t * V + v] - l;
  }
  return { lp, T, V, spf: audio.length / 16000 / T };
}

async function ctcEmissions(audio: Float32Array) {
  const max = CTC_CHUNK_S * 16000;
  if (audio.length <= max) return emissionsOnce(audio);
  const parts: { lp: Float32Array; T: number; V: number }[] = [];
  for (let off = 0; off < audio.length; off += max) {
    const piece = audio.subarray(off, Math.min(audio.length, off + max));
    if (piece.length < 1600) break;                       // < 0.1 s tail: nothing to hear
    parts.push(await emissionsOnce(piece));
  }
  const V = parts[0].V;
  let T = 0; for (const p of parts) T += p.T;
  const lp = new Float32Array(T * V);
  let o = 0; for (const p of parts) { lp.set(p.lp, o); o += p.lp.length; }
  return { lp, T, V, spf: audio.length / 16000 / T };
}

const ctcNorm = (w: string) => [...String(w).toLowerCase()].filter((c) => ctcVocab[c] != null && ctcVocab[c] > 5);

/** Forced alignment (torchaudio / WhisperX trellis) + greedy recognition from the same emissions. */
async function ctcAlign({ buffer, words }: { buffer: ArrayBuffer; words: string[] }) {
  const audio = new Float32Array(buffer);
  const { lp, T, V, spf } = await ctcEmissions(audio);
  const blank = 0, sep = ctcVocab['|'];
  const E = (t: number, v: number) => lp[t * V + v];

  // greedy CTC decoding with character times (independent of Whisper)
  const heard: { text: string; start: number; end: number; p: number; chars: [string, number][] }[] = [];
  {
    let cur: any = null, prev = -1;
    for (let t = 0; t < T; t++) {
      let b = 0; for (let v = 1; v < V; v++) if (lp[t * V + v] > lp[t * V + b]) b = v;
      if (b !== prev && b !== blank) {
        if (b === sep || b <= 3) { if (cur) { heard.push(cur); cur = null; } }
        else { if (!cur) cur = { text: '', start: t * spf, end: (t + 1) * spf, p: 0, n: 0, chars: [] }; cur.text += ctcInv[b]; cur.chars.push([ctcInv[b], t * spf]); }
      }
      if (cur && b !== blank && b !== sep) { cur.end = (t + 1) * spf; cur.p += Math.exp(lp[t * V + b]); cur.n++; }
      prev = b;
    }
    if (cur) heard.push(cur);
    for (const h of heard as any[]) { h.p = h.n ? h.p / h.n : 0; delete h.n; }
  }

  const toks: number[] = [], owner: number[] = [];
  words.forEach((w, i) => {
    const cs = ctcNorm(w);
    if (!cs.length) return;
    if (toks.length) { toks.push(sep); owner.push(-1); }
    for (const c of cs) { toks.push(ctcVocab[c]); owner.push(i); }
  });
  const J = toks.length;
  if (!J || J > T) return { words: words.map(() => null), heard, spf, T };
  const NEG = -1e30, W = J + 1, tr = new Float32Array((T + 1) * W).fill(NEG);
  tr[0] = 0;
  for (let t = 0; t < T; t++) {
    const eb = E(t, blank);
    for (let j = 0; j <= J; j++) {
      const stay = tr[t * W + j] + (j > 0 ? Math.max(eb, E(t, toks[j - 1])) : eb);
      const move = j > 0 ? tr[t * W + j - 1] + E(t, toks[j - 1]) : NEG;
      tr[(t + 1) * W + j] = Math.max(stay, move);
    }
  }
  const first = new Int32Array(J).fill(-1), last = new Int32Array(J).fill(-1), prob = new Float32Array(J);
  let j = J;
  for (let t = T; t > 0 && j > 0; t--) {
    const eb = E(t - 1, blank);
    const stay = tr[(t - 1) * W + j] + Math.max(eb, E(t - 1, toks[j - 1]));
    const move = tr[(t - 1) * W + j - 1] + E(t - 1, toks[j - 1]);
    if (move >= stay) {
      first[j - 1] = t - 1; if (last[j - 1] < 0) last[j - 1] = t - 1;
      prob[j - 1] = Math.max(prob[j - 1], Math.exp(E(t - 1, toks[j - 1]))); j--;
    } else if (E(t - 1, toks[j - 1]) > eb) { if (last[j - 1] < 0) last[j - 1] = t - 1; }
  }
  const out: ({ start: number; end: number; score: number; n?: number } | null)[] = words.map(() => null);
  for (let k = 0; k < J; k++) {
    const i = owner[k]; if (i < 0 || first[k] < 0) continue;
    const s = first[k] * spf, e = (last[k] + 1) * spf;
    const o = out[i];
    if (!o) out[i] = { start: s, end: e, score: prob[k], n: 1 };
    else { o.start = Math.min(o.start, s); o.end = Math.max(o.end, e); o.score += prob[k]; o.n!++; }
  }
  for (const o of out) if (o) { o.score /= o.n!; delete o.n; }
  return { words: out, heard, spf, T };
}

self.onmessage = async ({ data: m }: MessageEvent) => {
  try {
    let result: any;
    if (m.type === 'load') result = await load(m);
    else if (m.type === 'transcribe') result = await transcribe(m);
    else if (m.type === 'ctcLoad') result = await ctcLoad(m);
    else if (m.type === 'ctcAlign') result = await ctcAlign(m);
    else if (m.type === 'gpu') result = await gpuInfo();
    else throw new Error('unknown message ' + m.type);
    post({ id: m.id, ok: true, result });
  } catch (e: any) {
    post({ id: m.id, ok: false, error: (e && e.message) || String(e) });
  }
};
