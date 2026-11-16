// Live master model. The leveler + compressor + limiter used to be "printed" over the whole recording
// (≈ 86 M samples per 1.5 h) every time anything changed. Nothing interactive needs that:
//
//   • the waveform when zoomed out shows 10 ms blocks, so the chain is modelled at BLOCK rate on a compact
//     analysis of the original (per block: RMS, sample peak, K-weighted energy — 540 k numbers per 1.5 h);
//     a full re-model takes milliseconds, so the wave follows the compressor sliders live;
//   • the same block model predicts the integrated loudness, so the leveler calibration is instant too
//     (the exact measurement runs later in the DSP worker and corrects the small model bias);
//   • when zoomed in, or once the worker has rendered the visible range, the wave is drawn from the EXACT
//     chain (`renderRange`): only what is on screen is computed, plus one second of pre-roll so the
//     compressor envelope has settled;
//   • the player and the export always run the exact chain on the fly.
//
// All times are SOURCE seconds; the analysis is the 16 kHz mono PCM the app already has.
import { SR } from './util';
import { MasterChain, gainReductionDb, type ChainSettings, type CompressorSettings } from './masterchain';

/** Block length: 10 ms at 16 kHz (same grid as `computeLevels` / LV_HOP). */
export const BLK = 160;
export const BLK_S = BLK / SR;
/** Exact waveform tiles rendered by the DSP worker: 60 s of 10 ms blocks. */
export const TILE_BLOCKS = 6000;
/** 100 ms loudness hop = 10 blocks. */
const HOP_B = 10;
const PHRASE_GAP = 0.35;      // a pause at least this long ends a phrase

/** Compressor detector sub-block: 20 samples = 1.25 ms (8 per block). Measured against the exact chain
 *  on the 1.5 h test file: mean |error| 0.05–0.7 dB per 10 ms block for threshold −5…−25 dB, ratio 3…10,
 *  attack 2…30 ms; one peak per whole 10 ms block was 0.4–3.5 dB off. */
export const SUB = 20;
const SUB_PER = BLK / SUB;

export interface BlockAnalysis {
  /** RMS level per block, dBFS (the app's `levels`). */
  rmsDb: Float32Array;
  /** sample peak per SUB-block (1.25 ms), dBFS */
  subPeakDb: Float32Array;
  /** K-weighted energy (sum of squares) per block */
  kwE: Float32Array;
}

export interface PhraseLevel { start: number; end: number; lufs: number }
export interface LevelerParams {
  targetLufs: number; maxGainDb: number; minGainDb?: number;
  /** phrase leveling on (default). Off: flat 0 dB curve — compressor + make-up only. */
  leveler?: boolean;
}
export type CurvePt = { t: number; db: number };

const loudnessOf = (z: number) => -0.691 + 10 * Math.log10(Math.max(1e-20, z));

/** Gated loudness of 100 ms hop energies (sliding 400 ms blocks, absolute + relative gate). */
function gatedLufs(hops: Float64Array | number[], nHops: number, minHops = 4): number {
  if (nHops < minHops) return -Infinity;
  const hb = HOP_B * BLK * 4;
  const z: number[] = [];
  for (let k = 0; k + 4 <= nHops; k++) z.push((hops[k] + hops[k + 1] + hops[k + 2] + hops[k + 3]) / hb);
  let sum = 0, cnt = 0;
  for (const v of z) if (loudnessOf(v) > -70) { sum += v; cnt++; }
  if (!cnt) return -Infinity;
  const thr = loudnessOf(sum / cnt) - 10;
  let s2 = 0, c2 = 0;
  for (const v of z) if (loudnessOf(v) > -70 && loudnessOf(v) > thr) { s2 += v; c2++; }
  return c2 ? loudnessOf(s2 / c2) : -Infinity;
}

/** Group word-like items into phrases (split at pauses ≥ PHRASE_GAP) and measure each phrase like the meter. */
export function measurePhrases(words: { start: number; end: number }[], an: BlockAnalysis): PhraseLevel[] {
  const out: PhraseLevel[] = [];
  const nb = an.kwE.length;
  let s = -1, e = -1;
  const flush = () => {
    if (s < 0) return;
    const a = Math.max(0, Math.round((s - 0.1) / BLK_S)), b = Math.min(nb, Math.round((e + 0.1) / BLK_S));
    const nh = Math.floor((b - a) / HOP_B), hops = new Float64Array(Math.max(0, nh));
    for (let h = 0; h < nh; h++) { let acc = 0; for (let k = a + h * HOP_B, K = k + HOP_B; k < K; k++) acc += an.kwE[k]; hops[h] = acc; }
    out.push({ start: s, end: e, lufs: gatedLufs(hops, nh) });
  };
  for (const w of words) {
    if (s >= 0 && w.start - e >= PHRASE_GAP) { flush(); s = -1; }
    if (s < 0) s = w.start;
    e = Math.max(e, w.end);
  }
  flush();
  return out;
}

const clipDb = (db: number, p: LevelerParams) => Math.max(p.minGainDb ?? -12, Math.min(p.maxGainDb, db));
const phraseDb = (ph: PhraseLevel, p: LevelerParams) => Number.isFinite(ph.lufs) ? clipDb(p.targetLufs - ph.lufs, p) : 0;

/** Breakpoints of the leveler: the gain holds for the whole phrase and ramps inside the pause between phrases. */
export function curvePoints(phrases: PhraseLevel[], p: LevelerParams, trim: number): CurvePt[] {
  const pts: CurvePt[] = [];
  const db = phrases.map((ph) => phraseDb(ph, p));
  for (let i = 0; i < phrases.length; i++) {
    const ph = phrases[i], d = clipDb(db[i] + trim, p);
    if (i === 0) { pts.push({ t: 0, db: d }); continue; }
    const prev = phrases[i - 1], pause = ph.start - prev.end;
    const ramp = Math.max(0.02, Math.min(0.15, pause * 0.5)), mid = prev.end + pause / 2;
    pts.push({ t: Math.max(prev.end + 0.01, mid - ramp / 2), db: clipDb(db[i - 1] + trim, p) });
    pts.push({ t: Math.min(ph.start - 0.01, mid + ramp / 2), db: d });
  }
  if (phrases.length) pts.push({ t: phrases[phrases.length - 1].end + 1, db: clipDb(db[db.length - 1] + trim, p) });
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

/** «Приглушение тишины»: lowers the quiet stretches (under the silence threshold) that stay in the cut —
 *  breaths. The attack starts AT the start of a stretch and the release ends AT its end, so the sound
 *  around it is untouched (a look-ahead of the release length; the boundaries are known in advance).
 *  When attack + release do not fit into a stretch the ramps keep their speed and meet in the middle:
 *  the depth is then only partly reached (a short breath is lowered less, never abruptly). */
export interface DuckSettings { depthDb: number; attackMs: number; releaseMs: number }
export const DEFAULT_DUCK: DuckSettings = { depthDb: -5, attackMs: 30, releaseMs: 30 };
export function duckPoints(regions: { start: number; end: number }[], d: DuckSettings): CurvePt[] {
  const pts: CurvePt[] = [];
  if (!(d.depthDb < -0.01)) return pts;
  for (const r of regions) {
    const dur = r.end - r.start; if (dur < 0.002) continue;
    let A = d.attackMs / 1000, R = d.releaseMs / 1000;
    let depth = d.depthDb;
    if (A + R > dur) { const k = dur / (A + R); A *= k; R *= k; depth *= k; }
    pts.push({ t: r.start, db: 0 }, { t: r.start + A, db: depth }, { t: r.end - R, db: depth }, { t: r.end, db: 0 });
  }
  return pts;
}

/** Sum of two continuous piecewise-linear dB curves (exact: evaluated at the union of breakpoints). */
export function addCurves(a: CurvePt[], b: CurvePt[]): CurvePt[] {
  if (!b.length) return a;
  if (!a.length) return b;
  const fa = curveCursor(a), fb = curveCursor(b), out: CurvePt[] = [];
  let i = 0, j = 0, last = -Infinity;
  while (i < a.length || j < b.length) {
    const t = j >= b.length || (i < a.length && a[i].t <= b[j].t) ? a[i++].t : b[j++].t;
    if (t === last) continue;
    last = t; out.push({ t, db: fa(t) + fb(t) });
  }
  return out;
}

/** Monotonic evaluator of a breakpoint curve (dB, linear-in-dB interpolation). Cheap for increasing t;
 *  falls back to a binary search when t goes backwards. */
export function curveCursor(pts: CurvePt[]) {
  let i = 0;
  return (t: number): number => {
    const n = pts.length;
    if (!n) return 0;
    if (t <= pts[0].t) { i = 0; return pts[0].db; }
    if (i >= n || pts[i].t > t) {
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].t <= t) lo = m; else hi = m - 1; }
      i = lo;
    }
    while (i + 1 < n && pts[i + 1].t <= t) i++;
    const a = pts[i], b = pts[Math.min(n - 1, i + 1)];
    if (b.t <= a.t) return b.db;
    return a.db + (b.db - a.db) * ((t - a.t) / (b.t - a.t));
  };
}

/** Leveler gain (dB) at every block centre. */
export function curveBlocks(pts: CurvePt[], n: number, out = new Float32Array(n)): Float32Array {
  const at = curveCursor(pts);
  for (let k = 0; k < n; k++) out[k] = at((k + 0.5) * BLK_S);
  return out;
}

/** Block-rate model of the compressor: mean gain reduction (dB) per 10 ms block, from the 1.25 ms
 *  sub-block peaks. Speech crests are short, so the attack only acts over part of each sub-block;
 *  `COMP_DUTY` is that fraction, fitted against the exact per-sample chain (see SUB). */
export const COMP_DUTY = 0.22;
export function compBlocks(subPeakDb: Float32Array, lvDb: Float32Array, c: CompressorSettings, out = new Float32Array(lvDb.length), postOut?: Float32Array): Float32Array {
  const dt = SUB / SR;
  const att = Math.exp(-(dt * COMP_DUTY) / Math.max(1e-4, c.attackMs / 1000));
  const rel = Math.exp(-dt / Math.max(1e-4, c.releaseMs / 1000));
  const thr = c.thresholdDb, slope = 1 - 1 / Math.max(1, c.ratio), k = Math.max(0, c.kneeDb), lo = thr - k / 2, hi = thr + k / 2;
  let env = 0;
  const nb = lvDb.length, ns = subPeakDb.length;
  for (let b = 0, j = 0; b < nb; b++) {
    const lv = lvDb[b];
    let sum = 0;
    for (let e = Math.min(ns, j + SUB_PER); j < e; j++) {
      const db = subPeakDb[j] + lv;
      let target = 0;
      if (db > lo) { if (db >= hi) target = (db - thr) * slope; else { const x = db - lo; target = slope * x * x / (2 * k); } }
      env = target + (env - target) * (target > env ? att : rel);
      sum += env;
      if (postOut) postOut[j] = db - env;               // sub-block peak after the compressor
    }
    out[b] = sum / SUB_PER;
  }
  return out;
}

/** Model of the look-ahead limiter: per sub-block the overshoot of the post-compressor peak (+ make-up)
 *  over the ceiling, held with the limiter's 60 ms release, averaged per block. Fitted against the exact
 *  MasterChain on 20 min of the test file: overview error 0.1–0.65 dB, loudness error ≤ 0.3 dB. */
const LIMIT_REL_S = 0.06;
export function limitBlocks(postDb: Float32Array, makeupDb: number, ceilingDb: number, out: Float32Array): Float32Array {
  const lr = Math.exp(-(SUB / SR) / LIMIT_REL_S), off = makeupDb - ceilingDb, ns = postDb.length;
  let le = 0;
  for (let b = 0, j = 0; b < out.length; b++) {
    let s = 0;
    for (let e = Math.min(ns, j + SUB_PER); j < e; j++) { const o = postDb[j] + off; le = o > le ? o : le * lr; s += le; }
    out[b] = s / SUB_PER;
  }
  return out;
}

/** Integrated loudness predicted by the block model (K-weighted energies × modelled gain²), including
 *  make-up and the limiter's loss. */
export function modelLufs(an: BlockAnalysis, lvDb: Float32Array, grDb: Float32Array, limDb?: Float32Array, makeupDb = 0): number {
  const n = an.kwE.length, nh = Math.floor(n / HOP_B), hops = new Float64Array(nh);
  const C = Math.LN10 / 10;
  for (let h = 0, k = 0; h < nh; h++) {
    let acc = 0;
    for (const K = k + HOP_B; k < K; k++) {
      const e = an.kwE[k];
      if (e) acc += e * Math.exp((lvDb[k] - grDb[k] + makeupDb - (limDb ? limDb[k] : 0)) * C);
    }
    hops[h] = acc;
  }
  return gatedLufs(hops, nh);
}

export interface Calibrated { trim: number; makeupDb: number; pts: CurvePt[]; full: CurvePt[]; lvDb: Float32Array; grDb: Float32Array; postDb: Float32Array; limDb: Float32Array; modelLufs: number; maxGrDb: number; capped: boolean }

/** Largest automatic make-up gain, dB. */
export const MAX_MAKEUP_DB = 12;
/** Without the phrase leveler the make-up is the only gain stage, so it may go further. */
export const MAX_MAKEUP_DB_COMP_ONLY = 30;

/** Reach the target AFTER the chain. First the leveler trim (gain only inside pauses, capped by the
 *  variant); what the cap or the compressor still leaves short is made up after the compressor (the
 *  limiter catches the peaks). `bias` = (exact − model) from the last exact measurement. */
export function calibrate(an: BlockAnalysis, phrases: PhraseLevel[], p: LevelerParams, comp: CompressorSettings, ceilingDb: number, bias = 0, trim0 = 0, fixedMakeupDb?: number, extra: CurvePt[] = []): Calibrated {
  const n = an.kwE.length;
  if (p.leveler === false) { phrases = []; trim0 = 0; }       // leveler off: no phrase gain at all
  const maxMakeup = p.leveler === false ? MAX_MAKEUP_DB_COMP_ONLY : MAX_MAKEUP_DB;
  const lvDb = new Float32Array(n), grDb = new Float32Array(n), limDb = new Float32Array(n), postDb = new Float32Array(an.subPeakDb.length);
  const base = phrases.map((ph) => phraseDb(ph, p));
  const allCapped = (trim: number) => base.every((d, i) => !Number.isFinite(phrases[i].lufs) || clipDb(d + trim, p) >= p.maxGainDb - 1e-6);
  // manual make-up: the leveler aims below the target by that much, the make-up is not searched
  const manual = fixedMakeupDb != null;
  const goal = p.targetLufs - bias - (manual ? fixedMakeupDb : 0);
  let trim = trim0, pts: CurvePt[] = [], L = -Infinity;
  const evalAt = (t: number) => {
    pts = curvePoints(phrases, p, t);
    curveBlocks(addCurves(pts, extra), n, lvDb);
    compBlocks(an.subPeakDb, lvDb, comp, grDb, postDb);
    return modelLufs(an, lvDb, grDb, limitBlocks(postDb, 0, ceilingDb, limDb), 0);
  };
  // secant iteration on the trim: loudness vs trim is monotonic, flattening under compression and at the cap
  let tPrev = NaN, lPrev = NaN;
  for (let it = 0; it < 6; it++) {
    L = evalAt(trim);
    if (!Number.isFinite(L) || !phrases.length) break;
    const delta = goal - L;
    if (Math.abs(delta) < 0.05) break;
    if (delta > 0 && allCapped(trim)) break;
    let step = delta;
    if (Number.isFinite(lPrev) && Math.abs(L - lPrev) > 0.01 && Math.abs(trim - tPrev) > 1e-3) {
      const slope = (L - lPrev) / (trim - tPrev);
      if (slope > 0.05) step = delta / slope;
    }
    tPrev = trim; lPrev = L;
    trim += Math.max(-12, Math.min(12, step));
  }
  const capped = allCapped(trim);
  // make-up: the limiter eats part of it, so search (secant; loudness vs make-up is monotonic and flattens
  // as the limiter takes over — if it saturates, `capped` reports that honestly)
  let makeupDb = 0, Lm = L;
  if (manual) {
    makeupDb = fixedMakeupDb;
    Lm = modelLufs(an, lvDb, grDb, limitBlocks(postDb, makeupDb, ceilingDb, limDb), makeupDb);
  } else if (Number.isFinite(L) && goal - L > 0.05) {
    let mPrev = 0, lPrev = L, m = Math.min(maxMakeup, goal - L);
    for (let it = 0; it < 8; it++) {
      Lm = modelLufs(an, lvDb, grDb, limitBlocks(postDb, m, ceilingDb, limDb), m);
      makeupDb = m;
      if (Math.abs(goal - Lm) < 0.05 || (m >= maxMakeup && Lm < goal)) break;
      const slope = (Lm - lPrev) / (m - mPrev);
      const next = slope > 0.02 ? m + (goal - Lm) / slope : m + (goal - Lm) * 4;
      mPrev = m; lPrev = Lm;
      m = Math.max(0, Math.min(maxMakeup, next));
    }
  }
  let maxGr = 0; for (let k = 0; k < n; k++) if (grDb[k] > maxGr) maxGr = grDb[k];
  if (makeupDb === 0) limitBlocks(postDb, 0, ceilingDb, limDb);
  return { trim, makeupDb, pts, full: addCurves(pts, extra), lvDb, grDb, postDb, limDb, modelLufs: Lm, maxGrDb: maxGr, capped: !manual && capped && goal - Lm > 0.3 };
}

/** Processed level per block for the waveform (model): RMS + leveler − compression, never above the ceiling. */
export function modelLevels(rmsDb: Float32Array, lvDb: Float32Array, grDb: Float32Array, limDb: Float32Array, ceilingDb: number, makeupDb: number, out = new Float32Array(rmsDb.length)) {
  for (let k = 0; k < rmsDb.length; k++) out[k] = Math.min(ceilingDb, rmsDb[k] + lvDb[k] - grDb[k] + makeupDb - limDb[k]);
  return out;
}

/** EXACT chain over samples [a, b) of the 16 kHz PCM (pre-roll before `a` lets the envelope settle). */
export function renderRange(pcm: Int16Array, a: number, b: number, pts: CurvePt[], chain: ChainSettings, prerollS = 1): Float32Array {
  a = Math.max(0, Math.min(pcm.length, a)); b = Math.max(a, Math.min(pcm.length, b));
  const s0 = Math.max(0, a - Math.round(prerollS * SR));
  const mc = new MasterChain(1, SR, chain, chain.ceilingDb), lat = mc.latency;
  const n = b - s0 + lat, buf = new Float32Array(n);   // + latency: the limiter's output lags its input
  const at = curveCursor(pts);
  for (let i = 0; i < n; i += 16) {
    const g = Math.pow(10, at((s0 + i) / SR) / 20), end = Math.min(n, i + 16);
    for (let k = i; k < end; k++) buf[k] = s0 + k < pcm.length ? pcm[s0 + k] / 32768 * g : 0;
  }
  mc.process([buf], n);
  return buf.subarray(a - s0 + lat, b - s0 + lat);
}

/** Streaming exact renderer (worker): processes consecutive chunks with one chain state. */
export class ExactStream {
  private chain: MasterChain;
  private at: (t: number) => number;
  private pcm: Int16Array;
  /** next OUTPUT sample; the input runs `latency` samples ahead of it (look-ahead limiter) */
  pos: number;
  constructor(pcm: Int16Array, pts: CurvePt[], chain: ChainSettings, start: number) {
    this.pcm = pcm;
    this.chain = new MasterChain(1, SR, chain, chain.ceilingDb);
    this.at = curveCursor(pts);
    this.pos = Math.max(0, start);
    const lat = this.chain.latency, pre = new Float32Array(lat);
    this.fill(pre, this.pos, lat);
    this.chain.process([pre], lat);                  // prime: outputs now line up with `pos`
  }
  get maxReductionDb() { return this.chain.maxReductionDb; }
  private fill(buf: Float32Array, p0: number, n: number) {
    const pcm = this.pcm;
    for (let i = 0; i < n; i += 16) {
      const g = Math.pow(10, this.at((p0 + i) / SR) / 20), end = Math.min(n, i + 16);
      for (let k = i; k < end; k++) buf[k] = p0 + k < pcm.length ? pcm[p0 + k] / 32768 * g : 0;
    }
  }
  /** Render the next `n` samples into `buf` (returns how many were rendered). */
  next(buf: Float32Array, n: number): number {
    n = Math.min(n, this.pcm.length - this.pos, buf.length);
    if (n <= 0) return 0;
    this.fill(buf, this.pos + this.chain.latency, n);
    this.chain.process([buf], n);
    this.pos += n;
    return n;
  }
}

/** RMS dBFS per block of a rendered f32 range (same formula as computeLevels). */
export function rmsBlocks(x: Float32Array, out: Float32Array, o = 0) {
  const nb = Math.floor(x.length / BLK);
  for (let k = 0; k < nb; k++) {
    let acc = 0; for (let i = k * BLK, e = i + BLK; i < e; i++) acc += x[i] * x[i];
    out[o + k] = 10 * Math.log10(acc / BLK + 1e-10);
  }
  return nb;
}
