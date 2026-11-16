// Filler-sound detection: «эээ», «ааа», «ммм», «эммм». Whisper leaves these out of the text, so
// they live in the gaps between its words. A candidate is a voiced, spectrally steady stretch with
// a flat pitch (hesitations are sustained vowels or hums), at least ~0.15 s long. wav2vec2 then
// listens to it: if it hears consonants it's a real word Whisper missed (rejected); otherwise its
// letters (э/а/м) name the filler. Without wav2vec2 the label comes from the spectrum (hum = «ммм»).
import type { Word } from '../lib/types';
import { SR } from '../lib/util';
import { pcmSlice } from '../lib/pcm';
import type { RPC } from '../lib/rpc';

export type FillerSensitivity = 'low' | 'normal' | 'high';
const STAB_MIN: Record<FillerSensitivity, number> = { low: 0.95, normal: 0.93, high: 0.91 };
const PITCH_RANGE_MAX: Record<FillerSensitivity, number> = { low: 3, normal: 4.5, high: 6 };   // semitones
const MIN_DUR: Record<FillerSensitivity, number> = { low: 0.3, normal: 0.2, high: 0.15 };      // seconds

const HOP = 160, WIN = 480, NFFT = 512;   // 10 ms hop, 30 ms window @16 kHz
const VOWELS_M = /^[аэеыоуюяимн-]*$/;      // letters wav2vec2 may emit for a hesitation (no real consonants)
const CONS = /[бвгджзйклпрстфхцчшщ]/;

// ---------------------------------------------------------------- small real FFT (radix-2)
const cosT = new Float32Array(NFFT / 2), sinT = new Float32Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / NFFT); sinT[i] = -Math.sin(2 * Math.PI * i / NFFT); }
const rev = new Uint16Array(NFFT);
for (let i = 0, j = 0; i < NFFT; i++) { rev[i] = j; let b = NFFT >> 1; while (j & b) { j ^= b; b >>= 1; } j |= b; }
function fftMag(x: Float32Array, out: Float32Array, re: Float32Array, im: Float32Array) {
  for (let i = 0; i < NFFT; i++) { re[rev[i]] = x[i]; im[rev[i]] = 0; }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let i = 0; i < NFFT; i += size) for (let j = 0; j < half; j++) {
      const k = j * step, a = i + j, b = a + half;
      const tr = re[b] * cosT[k] - im[b] * sinT[k], ti = re[b] * sinT[k] + im[b] * cosT[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(re[i], im[i]);
}
const hann = new Float32Array(WIN).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN));
// 24 log-spaced bands, 100–4000 Hz (bin = 31.25 Hz)
const BANDS = (() => { const e: number[] = []; for (let i = 0; i <= 24; i++) e.push(Math.round(100 * Math.pow(40, i / 24) / 31.25)); return e; })();

interface Frame { db: number; voiced: number; f0: number; lb: Float32Array; lowr: number }

function analyse(pcm: Int16Array, k0: number, k1: number): Frame[] {
  const x = new Float32Array(NFFT), mag = new Float32Array(NFFT / 2), re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  const s8 = new Float32Array(WIN / 2);
  const out: Frame[] = [];
  for (let k = k0; k < k1; k++) {
    const o = k * HOP;
    let e = 0;
    for (let i = 0; i < WIN; i++) { const v = (pcm[o + i] || 0) / 32768; x[i] = v * hann[i]; e += x[i] * x[i]; }
    x.fill(0, WIN);
    const db = 10 * Math.log10(e / WIN + 1e-10);
    // voicing: normalised autocorrelation on an 8 kHz copy, 70–400 Hz
    let mean = 0;
    for (let i = 0; i < s8.length; i++) { s8[i] = ((pcm[o + 2 * i] || 0) + (pcm[o + 2 * i + 1] || 0)) / 65536; mean += s8[i]; }
    mean /= s8.length; for (let i = 0; i < s8.length; i++) s8[i] -= mean;
    let best = 0, lag = 0;
    for (let L = 20; L < 115; L++) {
      let ab = 0, aa = 0, bb = 0;
      for (let i = 0; i + L < s8.length; i++) { const a = s8[i], b = s8[i + L]; ab += a * b; aa += a * a; bb += b * b; }
      const r = ab / Math.sqrt(aa * bb + 1e-12);
      if (r > best) { best = r; lag = L; }
    }
    fftMag(x, mag, re, im);
    const lb = new Float32Array(24);
    for (let b = 0; b < 24; b++) { let s = 0; for (let i = BANDS[b]; i < Math.max(BANDS[b] + 1, BANDS[b + 1]); i++) s += mag[i]; lb[b] = Math.log(s + 1e-6); }
    let low = 0, mid = 0; for (let i = 3; i < 13; i++) low += mag[i]; for (let i = 13; i < 100; i++) mid += mag[i];
    out.push({ db, voiced: best, f0: lag ? 8000 / lag : 0, lb, lowr: low / (low + mid + 1e-9) });
  }
  return out;
}

function cosSim(a: Float32Array, b: Float32Array) {
  let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; } ma /= a.length; mb /= b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return ab / Math.sqrt(aa * bb + 1e-12);
}
const pctl = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export interface FillerOptions { sensitivity: FillerSensitivity; floorDb: number; signal?: AbortSignal; onProgress?: (f: number) => void }

/** Returns filler tokens (kind 'filler'), sorted by time. `words`: the transcript (fillers in it are ignored). */
export async function detectFillers(pcm: Int16Array, words: Word[], rpc: RPC | null, o: FillerOptions): Promise<Word[]> {
  const W = words.filter((w) => w.kind !== 'filler' && w.kind !== 'extra');
  const total = pcm.length / SR;
  const gaps: [number, number][] = [];
  if (W.length) {
    gaps.push([0, W[0].start]);
    for (let i = 0; i + 1 < W.length; i++) gaps.push([W[i].end, W[i + 1].start]);
    gaps.push([W[W.length - 1].end, total]);
  }
  const loud = o.floorDb + 25;
  const cands: { s: number; e: number; stab: number; prange: number; lowA: number; lowB: number; lowr: number }[] = [];
  for (let g = 0; g < gaps.length; g++) {
    if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    if (g % 200 === 0) { o.onProgress?.(0.5 * g / gaps.length); await new Promise((r) => setTimeout(r, 0)); }
    const [a, b] = gaps[g];
    if (b - a < 0.15) continue;
    const k0 = Math.floor(a * 100), k1 = Math.min(Math.floor(pcm.length / HOP) - 3, Math.ceil(b * 100));
    if (k1 - k0 < 15) continue;
    const F = analyse(pcm, k0, k1);
    const good = F.map((f) => f.db > loud && f.voiced > 0.55);
    for (let k = 0; k < good.length;) {
      if (!good[k]) { k++; continue; }
      let j = k;
      while (j + 1 < good.length && (good[j + 1] || (j + 4 < good.length && (good[j + 2] || good[j + 3] || good[j + 4])))) j++;
      const len = j - k + 1;
      if (len >= 15) {
        const seg = F.slice(k, j + 1);
        let st = 0; for (let i = 0; i + 1 < seg.length; i++) st += cosSim(seg[i].lb, seg[i + 1].lb); st /= Math.max(1, seg.length - 1);
        const f0s = seg.filter((f) => f.voiced > 0.6 && f.f0 > 0).map((f) => 12 * Math.log2(f.f0));
        const prange = f0s.length >= 5 ? pctl(f0s, 0.9) - pctl(f0s, 0.1) : 99;
        const third = Math.max(1, Math.floor(seg.length / 3));
        const avg = (fs: Frame[]) => fs.reduce((x, f) => x + f.lowr, 0) / fs.length;
        cands.push({ s: (k0 + k) / 100, e: (k0 + j + 1) / 100, stab: st, prange, lowA: avg(seg.slice(0, third)), lowB: avg(seg.slice(-third)), lowr: avg(seg) });
      }
      k = j + 1;
    }
  }
  const acoustic = cands.filter((c) => c.e - c.s >= MIN_DUR[o.sensitivity] - 1e-6 && c.stab >= STAB_MIN[o.sensitivity] && c.prange <= PITCH_RANGE_MAX[o.sensitivity]);
  // wav2vec2 second opinion
  const out: Word[] = [];
  for (let i = 0; i < acoustic.length; i++) {
    if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    o.onProgress?.(0.5 + 0.5 * i / Math.max(1, acoustic.length));
    const c = acoustic[i];
    let heard = '';
    if (rpc) {
      try {
        const { data, t0 } = pcmSlice(pcm, c.s - 0.3, c.e + 0.3);
        const r = await rpc.call<{ heard: { chars: [string, number][] }[] }>('ctcAlign', { buffer: data.buffer, words: [] }, [data.buffer]);
        // only letters emitted inside the candidate (wav2vec2 spikes lag the sound by up to ~0.1 s)
        heard = r.heard.flatMap((h) => h.chars).filter(([, t]) => t0 + t > c.s + 0.04 && t0 + t < c.e + 0.06).map(([ch]) => ch).join('');
      } catch (e) { console.warn('filler check failed', e); }
    }
    // one consonant at an edge is the neighbouring word bleeding in; «гм»/«хм» are hesitations themselves
    heard = heard.replace(/^[гх](?=м)/, '');
    const core = heard.replace(/^[бвгджзйклпрстфхцчшщ]/, '').replace(/[бвгджзйклпрстфхцчшщ]$/, '');
    if (CONS.test(core) || !VOWELS_M.test(core)) { console.log(`[carver] filler rejected @${c.s.toFixed(2)}: wav2vec2 heard «${heard}»`); continue; }   // a real word Whisper skipped
    const hasM = /м/.test(heard) || c.lowB > 0.68, startsVowel = /^[аэеыоу]/.test(heard) || c.lowA < 0.6;
    const vowel = /а/.test(heard) ? 'а' : 'э';
    const label = hasM && startsVowel && (c.lowB - c.lowA > 0.08 || /^[аэе]+м/.test(heard)) ? vowel + 'ммм'
      : hasM && !/[аэеыоу]/.test(heard) && c.lowr > 0.66 ? 'ммм'
      : vowel.repeat(3);
    out.push({ text: label, start: c.s, end: c.e, kind: 'filler', score: c.stab, auto: true });
  }
  console.log(`[carver] fillers: ${cands.length} voiced candidates, ${acoustic.length} steady, ${out.length} confirmed`);
  o.onProgress?.(1);
  return out;
}

/** Whisper words / wav2vec2 sounds that are themselves hesitations («Э-э,», «Ммм», «эм»). */
export const FILLER_TEXT = /^[^а-яё]*(э+|э-э+|а-а+|а{2,}|м+|м-м+|э+м+|эм-м+|хм+|гм+)[^а-яё]*$/i;
