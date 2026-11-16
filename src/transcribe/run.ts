// Transcription orchestrator: VAD -> Whisper in overlapping windows -> wav2vec2 word alignment
// -> edge snapping on the waveform -> "extra" sounds Whisper dropped. Ported from whisper-web.
import type { Word } from '../lib/types';
import { SR } from '../lib/util';
import { RPC, newSpeechWorker } from '../lib/rpc';

export interface TranscribeOptions { model: string; device: string; language: string }
export interface TProgress { stage: 'load' | 'vad' | 'transcribe' | 'done'; frac: number; text: string; live?: string; device?: string }
interface Seg { start: number; end: number; text: string }
export interface Checkpoint { v: 3; key: string; t: number; segs: Seg[]; words: Word[] }

const WINDOW_S = 300, MARGIN_S = 15, CHUNK_S = 30, STRIDE_S = 5;

export const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'Large v3 Turbo — лучшая (~1–1,6 ГБ)', size: 1.6e9 },
  { id: 'onnx-community/whisper-small', label: 'Small — хорошая (~250 МБ)', size: 4.2e8 },
  { id: 'onnx-community/whisper-base', label: 'Base — быстрая (~80 МБ)', size: 1.5e8 },
];
export const DEFAULT_MODEL = WHISPER_MODELS[0].id;

// ---------------------------------------------------------------------------
// Voice activity detection (energy based, adaptive noise floor) — whisper-web
const VAD_FRAME = 480, VAD_MIN_SILENCE = 2.0, VAD_PAD = 0.4, VAD_MIN_SPEECH = 0.15;
function detectSpeech(pcm: Int16Array): { s: number; e: number }[] {
  const n = Math.floor(pcm.length / VAD_FRAME);
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0; const i = f * VAD_FRAME;
    for (let j = i; j < i + VAD_FRAME; j++) { const v = pcm[j]; acc += v * v; }
    db[f] = 10 * Math.log10(acc / VAD_FRAME / 1073741824 + 1e-10);
  }
  const BLOCK = 33, nb = Math.ceil(n / BLOCK), bp = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const v = Array.from(db.subarray(b * BLOCK, Math.min(n, (b + 1) * BLOCK))).sort((x, y) => x - y);
    bp[b] = v[Math.floor(v.length * 0.1)];
  }
  const floor = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let m = Infinity;
    for (let k = Math.max(0, b - 15); k <= Math.min(nb - 1, b + 15); k++) m = Math.min(m, bp[k]);
    floor[b] = m;
  }
  const fps = SR / VAD_FRAME;
  const raw: number[][] = [];
  let runStart = -1, runSpeech = 0;
  for (let i = 0; i <= n; i++) {
    const speech = i < n && db[i] > Math.max(floor[Math.floor(i / BLOCK)] + 10, -60);
    if (speech) { if (runStart < 0) runStart = i; runSpeech++; }
    else if (runStart >= 0) { raw.push([runStart, i, runSpeech]); runStart = -1; runSpeech = 0; }
  }
  const merged: number[][] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && (r[0] - last[1]) / fps < VAD_MIN_SILENCE) { last[1] = r[1]; last[2] += r[2]; }
    else merged.push([...r]);
  }
  const regions: { s: number; e: number }[] = [];
  for (const [a, b, sp] of merged) {
    if (sp / fps < VAD_MIN_SPEECH) continue;
    const s = Math.max(0, Math.round((a / fps - VAD_PAD) * SR));
    const e = Math.min(pcm.length, Math.round((b / fps + VAD_PAD) * SR));
    const last = regions[regions.length - 1];
    if (last && s <= last.e) last.e = Math.max(last.e, e); else regions.push({ s, e });
  }
  return regions;
}

class TimeMap {
  r: { s: number; e: number }[]; c: number[] = []; total: number;
  constructor(regions: { s: number; e: number }[]) {
    this.r = regions; let acc = 0;
    for (const g of regions) { this.c.push(acc); acc += g.e - g.s; }
    this.total = acc;
  }
  idx(x: number, isEnd: boolean) {
    let lo = 0, hi = this.r.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.c[mid] <= x) lo = mid; else hi = mid - 1; }
    if (isEnd && lo > 0 && x === this.c[lo]) lo--;
    return lo;
  }
  toOrig(sec: number, isEnd = false) {
    if (!this.r.length) return sec;
    const x = Math.round(sec * SR), k = this.idx(x, isEnd), g = this.r[k];
    return (g.s + Math.min(Math.max(0, x - this.c[k]), g.e - g.s)) / SR;
  }
  /** Inverse of toOrig: SOURCE seconds -> compressed (speech-only) seconds. */
  toComp(sec: number) {
    if (!this.r.length) return sec;
    const x = Math.round(sec * SR);
    let lo = 0, hi = this.r.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.r[mid].s <= x) lo = mid; else hi = mid - 1; }
    const g = this.r[lo], xc = Math.min(Math.max(x, g.s), g.e);
    return (this.c[lo] + (xc - g.s)) / SR;
  }
  /** Compressed [start, end) of one word -> SOURCE seconds, clamped to the region it starts in. */
  wordSpan(start: number, end: number): [number, number] {
    if (!this.r.length) return [start, end];
    const k = this.idx(Math.round(start * SR), false), s = this.toOrig(start);
    const e = Math.min(this.toOrig(end, true), this.r[k].e / SR);
    return [s, Math.max(s + 0.01, e)];
  }
  span(a: number, b: number): [number, number] {
    let os = this.toOrig(a), oe = this.toOrig(b, true);
    if (!this.r.length) return [os, oe];
    const xa = Math.round(a * SR), xb = Math.round(b * SR);
    const k1 = this.idx(xa, false), k2 = this.idx(xb, true);
    if (k2 > k1) {
      const before = this.c[k1 + 1] - xa, after = xb - this.c[k2];
      if (before >= after) oe = this.r[k1].e / SR; else os = this.r[k2].s / SR;
    }
    return [os, Math.max(os, oe)];
  }
  read(pcm: Int16Array, a: number, b: number): Float32Array {
    const A = Math.round(a * SR), B = Math.round(b * SR);
    const out = new Float32Array(Math.max(0, B - A)); let w = 0;
    for (let k = 0; k < this.r.length && w < out.length; k++) {
      const cs = this.c[k], ce = cs + (this.r[k].e - this.r[k].s);
      if (ce <= A || cs >= B) continue;
      const from = this.r[k].s + Math.max(0, A - cs), to = this.r[k].s + Math.min(ce, B) - cs;
      for (let i = from; i < to; i++) out[w++] = pcm[i] / 32768;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Repetition-loop detection & cleanup — whisper-web
function repetitive(text: string) {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  if (t.length < 80) return false;
  const seen = new Set<string>(); let total = 0;
  for (let i = 0; i + 8 <= t.length; i++) { seen.add(t.slice(i, i + 8)); total++; }
  return seen.size / total < 0.5;
}
function degeneracy(chunks: Seg[]) {
  const all = chunks.map((c) => c.text || '').join(' ');
  let bad = 0;
  for (let i = 0; i < all.length; i += 300) if (repetitive(all.slice(i, i + 400))) bad++;
  for (const c of chunks) if ((c.text || '').length >= 80 && repetitive(c.text)) bad++;
  return bad;
}
const REPEAT_RE = /(?<=^|[\s,.;:!?])(\S.{3,80}?)(?:[\s,.;:!?…-]*\1){2,}/gu;
const wordsOf = (x: string) => x.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
function cleanSegments(segs: Seg[], before: Seg[]): Seg[] {
  const out: Seg[] = [];
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const text = s.text.replace(REPEAT_RE, '$1').trim();
    if (!text) continue;
    if (text.length > 15 && text.length / Math.max(s.end - s.start, 0.01) > 40) {
      const near = new Set(segs.slice(Math.max(0, i - 2), i + 3).filter((x) => x !== s).flatMap((x) => wordsOf(x.text)));
      const w = wordsOf(text);
      if (w.length && w.filter((x) => near.has(x)).length / w.length >= 0.6) continue;
      if (out.length) { out[out.length - 1].text += ' ' + text; continue; }
    }
    const all = [...before.slice(-2), ...out];
    const p1 = all[all.length - 1], p2 = all[all.length - 2];
    if (p1 && p2 && norm(p1.text) === norm(text) && norm(p2.text) === norm(text)) { p1.end = Math.max(p1.end, s.end); continue; }
    out.push({ start: s.start, end: s.end, text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Word boundaries: wav2vec2 spikes -> real onsets/offsets (whisper-web "cenEdge")
const HOP = 0.002;
function envelope(x: Float32Array) {
  const hop = Math.round(HOP * SR), win = Math.round(0.010 * SR), n = Math.max(1, Math.floor(x.length / hop));
  const env = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c = k * hop; let acc = 0, m = 0;
    for (let i = Math.max(0, c - win / 2); i < Math.min(x.length, c + win / 2); i++) { acc += x[i] * x[i]; m++; }
    env[k] = 10 * Math.log10((m ? acc / m : 0) + 1e-10);
  }
  const sorted = Float32Array.from(env).sort();
  const floor = sorted[Math.floor(n * 0.10)], peak = sorted[Math.floor(n * 0.98)];
  return { env, thr: floor + Math.max(10, 0.3 * (peak - floor)), n };
}
function snapEdges(E: ReturnType<typeof envelope>, t0: number, s: number, e: number, lo = -Infinity, hi = Infinity): [number, number] {
  const { env, thr, n } = E;
  const K = (t: number) => Math.min(n - 1, Math.max(0, Math.round((t - t0) / HOP))), T = (k: number) => t0 + k * HOP;
  const PAUSE = Math.round(0.020 / HOP);
  const quiet = (k: number, dir: number) => { for (let j = 0; j < PAUSE; j++) { const q = k + dir * j; if (q < 0 || q >= n || env[q] >= thr) return false; } return true; };
  const A = Math.max(Math.min(lo, s), s - 0.18), B = Math.min(Math.max(hi, e), e + 0.22);
  let a = A, b = B;
  for (let k = K(s); k >= K(A); k--) if (quiet(k, -1)) { a = T(k + 1); break; }
  for (let k = K(e); k <= K(B); k++) if (quiet(k, 1)) { b = T(k); break; }
  return [Math.min(a, s), Math.max(b, e)];
}

const HAS_ALNUM = /[\p{L}\p{N}]/u;
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/\s+/)) {
    if (!t) continue;
    if (!HAS_ALNUM.test(t) && out.length) out[out.length - 1] += (/^[-–—]$/.test(t) ? ' ' : '') + t;   // "—", "..." stick to previous
    else out.push(t);
  }
  return out;
}

/** Signs that the words were forced into too little audio: any 8 consecutive words faster than
 *  26 letters/s (fast natural speech is ~20), or 4+ words in a row with no acoustic evidence. */
function squeezed(texts: string[], al: ({ start: number; end: number; score: number } | null)[]): boolean {
  const L = texts.map((t) => (t.match(/[\p{L}]/gu) || []).length);
  const idx = al.map((w, i) => (w ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k + 7 < idx.length; k++) {
    const i = idx[k], j = idx[k + 7];
    let n = 0; for (let m = i; m <= j; m++) n += L[m];
    if (n / Math.max(0.05, al[j]!.end - al[i]!.start) > 26) return true;
  }
  let run = 0;
  for (const w of al) { if (w && w.score < 0.05) { if (++run >= 4) return true; } else run = 0; }
  return false;
}

/** Align a group of consecutive segments; returns words (+ extra sounds) in time order. */
async function alignGroup(map: TimeMap, rpc: RPC | null, pcm: Int16Array, segs: Seg[], leftBound: number, rightBound: number, mayExtend: boolean, ctx?: Seg, log: (...args: unknown[]) => void = console.log): Promise<{ words: Word[]; squeezed: boolean }> {
  const total = pcm.length / SR;
  const lastEnd = segs[segs.length - 1].end;
  // Whisper's segment times can be a few seconds off: start up to 3 s early (never before the
  // previous word), and align together with the next segment's text as context so that the last
  // words can't stretch into audio that belongs to the next segment. Context words are dropped.
  let a = Math.max(0, leftBound, segs[0].start - 3);
  let b = Math.min(total, (ctx ? ctx.end : lastEnd) + 0.8);
  const toks: { text: string; seg: number; start?: number; end?: number; score?: number; ctx?: boolean }[] = [];
  segs.forEach((s, si) => { for (const t of tokenize(s.text)) toks.push({ text: t, seg: si }); });
  const own = toks.length;
  if (ctx) for (const t of tokenize(ctx.text)) toks.push({ text: t, seg: segs.length - 1, ctx: true });
  if (!own) return { words: [], squeezed: false };
  let isSqueezed = false;
  const letters = toks.reduce((x, t) => x + (t.text.match(/[\p{L}]/gu) || []).length, 0);
  // Silences carry no words, so align the speech only: map.read concatenates the VAD regions.
  // A segment that straddles a long pause would otherwise hand wav2vec2 minutes of silence — its
  // self-attention is O(n²) and overflows int32 ("Tensor shape is too large", 400+ s slices on
  // recordings with a long tail). Times below are compressed (speech) seconds in [aC, bC) and are
  // mapped back to SOURCE seconds before returning.
  let data: Float32Array = new Float32Array(0), t0 = 0, aC = 0, bC = 0, res: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    aC = map.toComp(a); bC = Math.max(aC, map.toComp(b));
    data = map.read(pcm, aC, bC); t0 = aC;
    res = null;
    if (!rpc || data.length <= SR * 0.2) break;
    try {
      const copy = data.slice();
      res = await rpc.call('ctcAlign', { buffer: copy.buffer, words: toks.map((t) => t.text) }, [copy.buffer]);
    } catch (e: any) { if (e?.name === 'AbortError') throw e; log('Ошибка выравнивания; используем резервные границы слов', String(e)); break; }
    // Whisper's segment times sometimes end too early (drift): the words then get squeezed into too
    // little audio. Normal speech is ~12–18 letters/s; if it's much faster, give the alignment the
    // audio up to the next segment (≤ 25 s more) and try again.
    isSqueezed = squeezed(toks.map((t) => t.text), res.words);
    if (attempt === 0 && isSqueezed && mayExtend) {
      const na = Math.max(0, leftBound, segs[0].start - 5), nb = Math.min(total, Math.max(b, rightBound - 0.05), lastEnd + 25);
      if (na < a - 0.3 || nb > b + 0.3) {
        log(`[transcribe] squeezed alignment at ${a.toFixed(1)}–${b.toFixed(1)} s: retrying with ${na.toFixed(1)}–${nb.toFixed(1)} s`);
        a = na; b = nb; continue;
      }
    }
    break;
  }
  const E = envelope(data);
  if (res) toks.forEach((t, i) => { const r = res.words[i]; if (r) { t.start = t0 + r.start; t.end = t0 + r.end; t.score = r.score; } });
  // edge snapping (neighbours = raw aligned spikes)
  const raw = toks.map((t) => [t.start, t.end]);
  toks.forEach((t, i) => {
    if (t.start == null) return;
    let lo = -Infinity, hi = Infinity;
    for (let k = i - 1; k >= 0; k--) if (raw[k][1] != null) { lo = raw[k][1]!; break; }
    for (let k = i + 1; k < toks.length; k++) if (raw[k][0] != null) { hi = raw[k][0]!; break; }
    const [s, e] = snapEdges(E, t0, t.start, t.end!, lo, hi);
    t.start = Math.max(s, lo === -Infinity ? aC : lo); t.end = Math.min(e, hi === Infinity ? bC : hi);
    if (t.end <= t.start) t.end = t.start + 0.02;
  });
  // interpolate the unaligned ones (digits, latin words, failed alignment) by character count
  let i = 0;
  while (i < toks.length) {
    if (toks[i].start != null) { i++; continue; }
    let j = i; while (j + 1 < toks.length && toks[j + 1].start == null) j++;
    const L = i > 0 ? toks[i - 1].end! : Math.max(aC, map.toComp(segs[toks[i].seg].start));
    const R = j + 1 < toks.length ? toks[j + 1].start! : Math.min(bC, Math.max(L + 0.1, map.toComp(segs[toks[j].seg].end)));
    const span = Math.max(0.05 * (j - i + 1), R - L), chars = toks.slice(i, j + 1).reduce((x, t) => x + t.text.length + 1, 0);
    let t = L;
    for (let k = i; k <= j; k++) {
      const d = span * (toks[k].text.length + 1) / chars;
      toks[k].start = t; toks[k].end = t + d * 0.9; t += d;
    }
    i = j + 1;
  }
  const words: Word[] = toks.slice(0, own).map((t) => ({ text: t.text, start: t.start!, end: t.end!, score: t.score }));
  // sounds wav2vec2 heard between Whisper's words (fillers, false starts, repeated words)
  if (res && res.heard) {
    const lastEnd = words[words.length - 1].end;
    for (const h of res.heard) {
      const s = t0 + h.start, e = t0 + h.end;
      if (h.p < 0.35 || e - s < 0.06 || s > lastEnd) continue;
      if (words.some((w) => w.kind !== 'extra' && s < w.end + 0.03 && e > w.start - 0.03)) continue;
      const [rs, re] = snapEdges(E, t0, s, e);
      words.push({ text: h.text, start: rs, end: re, score: h.p, kind: 'extra' });
    }
    words.sort((x, y) => x.start - y.start);
  }
  // edges were widened independently: split any overlap between neighbours at its middle
  for (let k = 0; k + 1 < words.length; k++) {
    const w = words[k], n = words[k + 1];
    if (w.end > n.start) {
      const b = Math.max(w.start + 0.01, Math.min(n.end - 0.01, (w.end + n.start) / 2));
      w.end = b; n.start = b;
    }
  }
  for (const w of words) { const [s0, e0] = map.wordSpan(w.start, w.end); w.start = s0; w.end = e0; }
  return { words, squeezed: isSqueezed };
}

function groupSegments(segs: Seg[]): Seg[][] {
  const groups: Seg[][] = [];
  for (const s of segs) {
    const g = groups[groups.length - 1];
    if (g && s.end - g[0].start <= 28 && s.start - g[g.length - 1].end < 2) g.push(s);
    else groups.push([s]);
  }
  return groups;
}

/** Paragraph starts: after long pauses, or after a sentence end once the paragraph is long. */
export function markParagraphs(words: Word[]) {
  let len = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], p = words[i - 1];
    w.para = false;
    if (!p) { w.para = true; len = 0; }
    else {
      const pause = w.start - p.end, sentEnd = /[.!?…]["»”')\]]*$/.test(p.text);
      if (pause >= 3 || (sentEnd && (pause >= 1.2 || len > 650))) { w.para = true; len = 0; }
    }
    len += w.text.length + 1;
  }
}

// ---------------------------------------------------------------------------
export interface TranscribeHooks {
  onProgress: (p: TProgress) => void;
  onPartial?: (words: Word[]) => void;
  loadCheckpoint?: () => Promise<Checkpoint | undefined>;
  saveCheckpoint?: (c: Checkpoint) => Promise<void>;
  signal?: AbortSignal;
  log?: (...a: unknown[]) => void;
}

let shared: RPC | null = null;
const files = new Map<string, { loaded: number; total: number }>();
export function getSpeechRPC(): RPC {
  if (!shared) shared = new RPC(newSpeechWorker());
  return shared;
}
export function disposeSpeechRPC() { if (shared) { shared.terminate(); shared = null; } inflight = null; lastAsr = null; }

/** Download (if needed) and initialise both models. Used by first-run setup and before transcription. */
/** Result of the last Whisper load in the worker: `{ device: 'webgpu'|'wasm', dtype, pref, why }` (why = reason it is NOT on the GPU). */
export let lastAsr: { device: string; dtype?: any; pref?: string; why?: string | null } | null = null;
let inflight: { key: string; p: Promise<any>; listeners: Set<(f: number, t: string) => void> } | null = null;
export function loadModels(opts: { model: string; device: string }, onProgress: (frac: number, text: string) => void): Promise<{ whisper: any; ctc: any }> {
  const key = opts.model + '|' + opts.device;
  if (inflight && inflight.key === key) { inflight.listeners.add(onProgress); return inflight.p; }
  const listeners = new Set([onProgress]);
  const p = loadModelsNow(opts, (f, t) => { for (const l of listeners) l(f, t); });
  inflight = { key, p, listeners };
  p.catch(() => {}).finally(() => { if (inflight?.p === p) inflight = null; });
  return p;
}
async function loadModelsNow(opts: { model: string; device: string }, onProgress: (frac: number, text: string) => void) {
  const rpc = getSpeechRPC();
  files.clear();
  rpc.onEvent = (m) => {
    if (m.event === 'load' && m.file && (m.status === 'progress' || m.status === 'done')) {
      const f = files.get(m.name + '/' + m.file) || { loaded: 0, total: 0 };
      if (m.total) f.total = m.total;
      f.loaded = m.status === 'done' ? f.total || f.loaded : m.loaded || f.loaded;
      files.set(m.name + '/' + m.file, f);
      let l = 0, t = 0; for (const x of files.values()) { l += x.loaded; t += x.total; }
      if (t > 1e6) onProgress(l / t, `Загрузка моделей: ${(l / 1e6).toFixed(0)} из ${(t / 1e6).toFixed(0)} МБ`);
    } else if (m.event === 'gpu-progress') onProgress(0, m.text || 'Проверка GPU…');
    else if (m.event === 'warn') { console.warn(m.text); onProgress(0, '⚠️ ' + m.text); }
  };
  onProgress(0, 'Подготовка моделей…');
  const w = await rpc.call('load', { model: opts.model, device: opts.device });
  lastAsr = w;
  const c = await rpc.call('ctcLoad', { device: opts.device });
  return { whisper: w, ctc: c };
}

export async function transcribeAll(pcm: Int16Array, opts: TranscribeOptions, hooks: TranscribeHooks): Promise<Word[]> {
  const { onProgress, signal } = hooks;
  const log = hooks.log || ((...a: unknown[]) => console.log('[transcribe]', ...a));
  const check = () => { if (signal?.aborted) throw new DOMException('cancelled', 'AbortError'); };
  const total = pcm.length / SR;
  const t0 = performance.now();

  const info = await loadModels(opts, (f, text) => onProgress({ stage: 'load', frac: f, text }));
  check();
  const rpc = getSpeechRPC();
  const device = String(info.whisper.device).toUpperCase();
  log('models ready', JSON.stringify(info));

  onProgress({ stage: 'vad', frac: 0, text: 'Поиск речи…' });
  const regions = detectSpeech(pcm);
  log('Найдены участки речи (VAD)', regions);
  const map = new TimeMap(regions);
  const comp = map.total / SR;
  log(`VAD: ${regions.length} regions, ${(comp / 60).toFixed(1)} min of speech in ${(total / 60).toFixed(1)} min`);

  const key = `${opts.model}|${opts.language}|${pcm.length}`;
  let segs: Seg[] = [], words: Word[] = [], t = 0;
  const saved = await hooks.loadCheckpoint?.();
  if (saved && saved.v === 3 && saved.key === key && saved.t > 0 && saved.t < comp) {
    segs = saved.segs; words = saved.words; t = saved.t;
    log(`resuming at ${t.toFixed(1)} s of speech`);
    markParagraphs(words); hooks.onPartial?.(words);
  }
  const startT = t, tStart = performance.now();
  let rpcEventsWindow: { done: number; total: number } = { done: 0, total: 1 };
  let live = '';
  rpc.onEvent = (m) => {
    if (m.event === 'chunk') rpcEventsWindow = m;
    else if (m.event === 'text') { live = (live + m.text).slice(-300); }
    else if (m.event === 'warn') log('WARN', m.text);
  };

  while (t < comp - 0.05) {
    check();
    const end = Math.min(comp, t + WINDOW_S), isLast = end >= comp - 0.01, L = end - t, winStart = t;
    log('Начало окна Whisper', { speechStart: t, speechEnd: end, isLast, language: opts.language });
    rpcEventsWindow = { done: 0, total: 1 }; live = '';
    const ticker = setInterval(() => {
      const within = Math.min(1, rpcEventsWindow.done / rpcEventsWindow.total);
      const pos = winStart + within * (isLast ? L : L - MARGIN_S);
      const el = (performance.now() - tStart) / 1000, speed = (pos - startT) / Math.max(1, el);
      const left = speed > 0 ? (comp - pos) / speed : NaN;
      onProgress({ stage: 'transcribe', frac: pos / comp, device, live,
        text: `Расшифровка ${Math.round(100 * pos / comp)}%` + (isFinite(left) && pos > startT + 5 ? ` · осталось ≈ ${Math.ceil(left / 60)} мин` : '') });
    }, 500);
    let res: { chunks: Seg[] };
    try {
      const callWhisper = (gen: any) => {
        const buf = map.read(pcm, t, end);
        return rpc.call<{ chunks: Seg[] }>('transcribe', { buffer: buf.buffer, language: opts.language, chunk: CHUNK_S, stride: STRIDE_S, gen }, [buf.buffer]);
      };
      res = await callWhisper(null);
      const bad = degeneracy(res.chunks);
      if (bad > 0) {
        log(`window ${winStart.toFixed(0)}: ${bad} repetitive block(s), retrying with repetition guard`);
        rpcEventsWindow = { done: 0, total: 1 };
        const res2 = await callWhisper({ no_repeat_ngram_size: 5, repetition_penalty: 1.1 });
        if (degeneracy(res2.chunks) <= bad) res = res2;
      }
    } finally { clearInterval(ticker); }
    check();
    const cutoff = isLast ? Infinity : L - MARGIN_S;
    let lastEnd: number | null = null;
    const fresh: Seg[] = [];
    for (const c of res.chunks) {
      let s = c.start ?? 0, e = c.end;
      if (e == null || !isFinite(e)) { if (!isLast) continue; e = L; }
      if (e > cutoff) continue;
      e = Math.min(e, L); s = Math.min(s, e);
      const text = (c.text || '').trim();
      lastEnd = e;
      if (!text) continue;
      // full original extent (alignment finds the words inside; span() would squeeze a segment
      // that straddles a removed silence onto one side of it)
      const os = map.toOrig(t + s), oe = Math.max(os + 0.05, map.toOrig(t + e, true));
      fresh.push({ start: os, end: oe, text });
    }
    const cleaned = cleanSegments(fresh, segs);
    log('Сегменты Whisper после очистки и перевода в исходное время', cleaned);
    segs.push(...cleaned);
    // word alignment of the new segments
    onProgress({ stage: 'transcribe', frac: (isLast ? comp : t + L - MARGIN_S) / comp, device, text: 'Точные границы слов…' });
    const groups = groupSegments(cleaned);
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      check();
      const left = words.length ? words[words.length - 1].end : 0;
      // audio up to the next group (or what this window has heard) may belong to this group's words
      const winEnd = map.toOrig(t + (isLast ? L : L - MARGIN_S), true);
      const right = gi + 1 < groups.length ? groups[gi + 1][0].start : winEnd;
      let r = await alignGroup(map, rpc, pcm, g, left, right, gi + 1 >= groups.length, groups[gi + 1]?.[0], log);
      if (r.squeezed && gi + 1 < groups.length) {
        // still squeezed: Whisper's boundary between these groups is badly off — align them as one
        const merged = [...g, ...groups[gi + 1]];
        const right2 = gi + 2 < groups.length ? groups[gi + 2][0].start : winEnd;
        log(`squeezed alignment at ${g[0].start.toFixed(1)} s: aligning together with the next group`);
        r = await alignGroup(map, rpc, pcm, merged, left, right2, true, groups[gi + 2]?.[0], log);
        gi++;
      }
      const ws = r.words;
      log('Точные границы слов группы', { group: gi + 1, groups: groups.length, squeezed: r.squeezed, words: ws });
      for (const w of ws) if (!words.length || w.start >= words[words.length - 1].start) words.push(w);
    }
    let next = isLast ? comp : (lastEnd != null && lastEnd > L / 3 ? t + lastEnd : t + L - MARGIN_S);
    if (next <= t) next = t + L - MARGIN_S;
    t = next;
    markParagraphs(words);
    hooks.onPartial?.(words);
    await hooks.saveCheckpoint?.({ v: 3, key, t, segs, words });
    log(`window ${winStart.toFixed(0)}–${end.toFixed(0)} s → ${cleaned.length} segments, ${words.length} words total`);
  }
  markParagraphs(words);
  const wall = (performance.now() - t0) / 1000;
  onProgress({ stage: 'done', frac: 1, device, text: `Готово: ${words.length} слов за ${Math.round(wall)} с (×${(total / wall).toFixed(1)} реального времени)` });
  return words;
}
