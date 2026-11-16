// Master chain: a soft peak compressor followed by a hard safety limiter. Works in place on planar f32
// blocks, so it drops into every streaming renderer (player, export, the DSP worker, the waveform)
// without buffering the whole programme.
//
// Defaults from the user's spec: threshold −5 dBFS, ratio 5:1; the brickwall sits at −3 dBFS (see below).
// The compressor parameters are live-editable in the Аудио tab (project state, `S.master.comp`).

export interface CompressorSettings {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeDb: number;
  /** make-up gain after the compressor, before the limiter (dB; automatic in the Аудио tab) */
  makeupDb?: number;
}
export type ChainSettings = CompressorSettings & { ceilingDb: number };

export const DEFAULT_COMPRESSOR: CompressorSettings = { thresholdDb: -4, ratio: 4, attackMs: 8, releaseMs: 120, kneeDb: 6 };
// -3 dBFS, not -1: AAC adds ~0.9-1 dB of inter-sample overshoot after the limiter, so a -1 dBFS ceiling
// measured 0.0 dBTP in the exported file. -3 leaves room for the codec; the compressor makes up the loudness.
export const DEFAULT_CEILING_DB = -3;

/** Static gain computer (dB of reduction for an input peak in dB), soft knee. Shared with the fast
 *  block-rate model in dsp.ts so both describe the same curve. */
export function gainReductionDb(db: number, c: CompressorSettings) {
  const over = db - c.thresholdDb, slope = 1 - 1 / Math.max(1, c.ratio), k = Math.max(0, c.kneeDb);
  if (over >= k / 2) return over * slope;
  if (over > -k / 2) { const x = over + k / 2; return slope * x * x / (2 * k); }
  return 0;
}

const LN10_20 = Math.LN10 / 20;

/** Look-ahead of the limiter. The signal is delayed by this much so the gain can come down BEFORE a
 *  peak instead of clipping it: hard clipping at −3 dBFS made the MP3 overshoot to 0 dBFS (626 of 357 M
 *  samples above −1 dBFS on the 1.5 h test file). */
export const LOOKAHEAD_S = 0.0015;
const LIMIT_RELEASE_S = 0.06;

export class MasterChain {
  private env = 0;                 // smoothed gain reduction, dB (>= 0)
  private readonly att: number;
  private readonly rel: number;
  private readonly ceil: number;
  private readonly mu: number;
  private maxGr = 0;               // diagnostics for the export report
  // look-ahead limiter: delay line, sliding minimum of the required gain (monotonic deque), box average
  /** latency in samples (output sample i = input sample i − latency) */
  readonly latency: number;
  // (the delay line is W = latency samples long: read-before-write at the same slot)
  private readonly W: number;
  private readonly dl: Float32Array[];
  private dp = 0;
  private readonly qv: Float32Array; private readonly qi: Int32Array;
  private qh = 0; private qt = 0;
  private readonly box: Float32Array; private bp = 0; private bsum: number;
  private gOut = 1; private readonly lrel: number;
  private t = 0;

  private readonly ch: number;
  private readonly cfg: CompressorSettings;
  // no TS parameter properties: this file is imported directly by Node in tests/masterchain.test.ts
  constructor(ch: number, sr: number, cfg: CompressorSettings, ceilingDb: number) {
    this.ch = ch; this.cfg = cfg;
    this.att = Math.exp(-1 / Math.max(1, (cfg.attackMs / 1000) * sr));
    this.rel = Math.exp(-1 / Math.max(1, (cfg.releaseMs / 1000) * sr));
    this.ceil = Math.pow(10, ceilingDb / 20);
    this.mu = Math.pow(10, (cfg.makeupDb ?? 0) / 20);
    this.W = Math.max(2, Math.round(LOOKAHEAD_S * sr));
    this.latency = this.W;
    this.dl = Array.from({ length: ch }, () => new Float32Array(this.W));
    this.qv = new Float32Array(this.W + 2); this.qi = new Int32Array(this.W + 2);
    this.box = new Float32Array(this.W).fill(1); this.bsum = this.W;
    this.lrel = Math.exp(-1 / (LIMIT_RELEASE_S * sr));
  }

  /** Peak gain reduction seen so far, dB (for the "before/after" report). */
  get maxReductionDb() { return this.maxGr; }

  /** In place; the output is delayed by `latency` samples (see `MasterChain.latency`). */
  process(planes: Float32Array[], n: number) {
    const { thresholdDb, ratio, kneeDb } = this.cfg;
    const slope = 1 - 1 / Math.max(1, ratio), k = Math.max(0, kneeDb);
    // below the knee the reduction is 0: skip the log10 for those samples (most of the speech)
    const loLin = Math.pow(10, (thresholdDb - k / 2) / 20);
    const att = this.att, rel = this.rel, ceil = this.ceil, ch = this.ch, mu = this.mu;
    const W = this.W, dl = this.dl, qv = this.qv, qi = this.qi, Q = qv.length, box = this.box, lrel = this.lrel;
    let env = this.env, maxGr = this.maxGr, dp = this.dp, qh = this.qh, qt = this.qt, bp = this.bp, bsum = this.bsum, gOut = this.gOut, t = this.t;
    for (let i = 0; i < n; i++, t++) {
      let peak = 0;
      for (let c = 0; c < ch; c++) { const v = Math.abs(planes[c][i]); if (v > peak) peak = v; }
      // ---- compressor (feed-forward, peak detector)
      let target = 0;
      if (peak > loLin) {
        const over = 20 * Math.log10(peak) - thresholdDb;
        if (over >= k / 2) target = over * slope;
        else { const x = over + k / 2; target = slope * x * x / (2 * k); }   // soft knee
      }
      env = target + (env - target) * (target > env ? att : rel);
      if (env < 1e-7) env = 0;                                             // fully released: unity gain, no pow
      if (env > maxGr) maxGr = env;
      const g = (env ? Math.exp(-env * LN10_20) : 1) * mu;
      // ---- look-ahead limiter: gain needed for this sample, minimum over the window, box-smoothed so the
      // gain is fully down when the sample leaves the delay line
      const pk = peak * g, need = pk > ceil ? ceil / pk : 1;
      while (qt !== qh && qv[(qt - 1 + Q) % Q] >= need) qt = (qt - 1 + Q) % Q;
      qv[qt] = need; qi[qt] = t; qt = (qt + 1) % Q;
      // window = the W+1 newest samples, so every box value that is averaged while sample t−W leaves the
      // delay line already includes that sample's requirement ⇒ the ceiling is guaranteed
      while (qi[qh] < t - W) qh = (qh + 1) % Q;
      const m = qv[qh];
      bsum += m - box[bp]; box[bp] = m; bp = bp + 1 === W ? 0 : bp + 1;
      const gl = bsum / W;
      gOut = gl < gOut ? gl : gl + (gOut - gl) * lrel;   // instant down, slow release
      // ---- delay line
      for (let c = 0; c < ch; c++) {
        const line = dl[c], x = planes[c][i] * g;
        let v = line[dp] * gOut;
        line[dp] = x;
        if (v > ceil) v = ceil; else if (v < -ceil) v = -ceil;           // safety only (float rounding)
        planes[c][i] = v;
      }
      dp = dp + 1 === W ? 0 : dp + 1;
    }
    this.env = env; this.maxGr = maxGr; this.dp = dp; this.qh = qh; this.qt = qt; this.bp = bp; this.bsum = bsum; this.gOut = gOut; this.t = t;
  }
}
