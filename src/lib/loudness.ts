// Loudness meter: ITU-R BS.1770-4 (integrated LUFS, gated), EBU Tech 3342 (LRA), plus a true-peak
// estimate. Streaming — the PCM is walked once, so a 1.5-hour recording costs one pass and no copies.
//
// The K-weighting filters are derived from the analog prototype at the actual sample rate, the same way
// libebur128 and pyloudnorm do it: the coefficients published in the standard are for 48 kHz, and this
// app's PCM is 16 kHz mono, where the fixed 48 kHz biquads would be off by a fraction of a dB.
//
// Caveats that belong in the UI, not hidden here:
//   • the measurement runs on the 16 kHz MONO downmix the rest of the app uses. Centred speech is
//     level-accurate, but wide stereo music can measure up to ~3 dB lower than the stereo master;
//   • the true-peak estimate is computed from that 16 kHz signal, so it can only under-report what a
//     48 kHz master contains — treat it as a floor, not as the final dBTP.

export interface LoudnessReport {
  integrated: number;    // LUFS, gated (BS.1770-4)
  shortTermMax: number;  // LUFS, loudest 3 s window
  lra: number;           // LU, 10th..95th percentile of gated short-term loudness
  samplePeakDb: number;  // dBFS
  truePeakDb: number;    // dBTP estimate
  blocks: number;        // number of 400 ms blocks that passed the gates
  seconds: number;
}

const SHELF_F = 1681.974450955533, SHELF_G = 3.999843853973347, SHELF_Q = 0.7071752369554196;
const HP_F = 38.13547087602444, HP_Q = 0.5003270373238773;
const ABS_GATE = -70, REL_GATE = -10, LRA_REL = -20;

export type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** Stage 1 of the K-weighting: high shelf (+4 dB above ~2 kHz). */
export function shelfCoefs(fs: number): Biquad {
  const K = Math.tan(Math.PI * SHELF_F / fs);
  const Vh = Math.pow(10, SHELF_G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / SHELF_Q + K * K;
  return {
    b0: (Vh + Vb * K / SHELF_Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / SHELF_Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / SHELF_Q + K * K) / a0,
  };
}

/** Stage 2 of the K-weighting: high-pass at 38 Hz. */
export function hpCoefs(fs: number): Biquad {
  const K = Math.tan(Math.PI * HP_F / fs);
  const a0 = 1 + K / HP_Q + K * K;
  return { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / HP_Q + K * K) / a0 };
}

const loudnessOf = (meanSquare: number) => -0.691 + 10 * Math.log10(Math.max(1e-20, meanSquare));

/** Streaming BS.1770-4 meter. Feed samples in any chunk sizes (Int16 PCM or processed f32), then
 *  `finish()`. With `blocks` it also records, per 10 ms block (160 samples at 16 kHz), the K-weighted
 *  energy and the sample peak — the compact description the live master model (dsp.ts) runs on. */
export class LoudnessMeter {
  private sh: Biquad; private hp: Biquad;
  private s1 = 0; private s2 = 0; private p1 = 0; private p2 = 0;
  private acc = 0; private inHop = 0; private readonly hop: number;
  private hopSums: number[] = []; private blockZ: number[] = []; private shortZ: number[] = [];
  private samplePeak = 0; private tp = 0; private n = 0;
  // last three samples + candidate flags for the 4× cubic true-peak estimate (lags two samples)
  private h0 = 0; private h1 = 0; private h2 = 0; private c1 = false; private c2 = false;
  // optional 10 ms blocks
  readonly blockLen: number;
  blockE: Float32Array | null = null;
  /** sample peak per SUB-block (`subLen` samples) — the compressor model's detector input */
  subPeak: Float32Array | null = null;
  private bi = 0; private bAcc = 0; private bIn = 0;
  private si = 0; private sPk = 0; private sIn = 0;

  constructor(private fs = 16000, blocksFor = 0, readonly subLen = 20) {
    this.sh = shelfCoefs(fs); this.hp = hpCoefs(fs);
    this.hop = Math.round(0.1 * fs);
    this.blockLen = Math.round(0.01 * fs);
    if (blocksFor > 0) {
      const nb = Math.ceil(blocksFor / this.blockLen);
      this.blockE = new Float32Array(nb); this.subPeak = new Float32Array(Math.ceil(blocksFor / subLen));
    }
  }

  /** Samples [a, b) of `x`; Int16 input is scaled by 1/32768. */
  push(x: Int16Array | Float32Array, a = 0, b = x.length) {
    const sc = x instanceof Int16Array ? 1 / 32768 : 1;
    const sh = this.sh, hp = this.hp, hop = this.hop, BL = this.blockLen;
    const bE = this.blockE, sP = this.subPeak, SL = this.subLen;
    let { s1, s2, p1, p2, acc, inHop, samplePeak, tp, h0, h1, h2, c1, c2, bi, bAcc, bIn, si, sPk, sIn } = this;
    for (let i = a; i < b; i++) {
      const v0 = x[i] * sc, ax = v0 < 0 ? -v0 : v0;
      if (ax > samplePeak) samplePeak = ax;
      // candidate two samples back: interpolate between h1 and h2 with h0 and the new sample around them
      if (c1) {
        const ca = -0.5 * h0 + 1.5 * h1 - 1.5 * h2 + 0.5 * v0;
        const cb = h0 - 2.5 * h1 + 2 * h2 - 0.5 * v0;
        const cc = -0.5 * h0 + 0.5 * h2;
        for (let t = 0.25; t < 1; t += 0.25) { const y = Math.abs(((ca * t + cb) * t + cc) * t + h1); if (y > tp) tp = y; }
      }
      c1 = c2; c2 = ax > 0.25 && ax >= (h2 < 0 ? -h2 : h2);
      h0 = h1; h1 = h2; h2 = v0;
      const v = sh.b0 * v0 + s1; s1 = sh.b1 * v0 - sh.a1 * v + s2; s2 = sh.b2 * v0 - sh.a2 * v;
      const y = hp.b0 * v + p1; p1 = hp.b1 * v - hp.a1 * y + p2; p2 = hp.b2 * v - hp.a2 * y;
      const e = y * y;
      acc += e;
      if (bE) {
        bAcc += e;
        if (++bIn === BL) { bE[bi++] = bAcc; bAcc = 0; bIn = 0; }
        if (ax > sPk) sPk = ax;
        if (++sIn === SL) { sP![si++] = sPk; sPk = 0; sIn = 0; }
      }
      if (++inHop === hop) {
        const hs = this.hopSums; hs.push(acc); acc = 0; inHop = 0;
        const m = hs.length;
        if (m >= 4) this.blockZ.push((hs[m - 1] + hs[m - 2] + hs[m - 3] + hs[m - 4]) / (4 * hop));
        if (m >= 30) { let s = 0; for (let k = m - 30; k < m; k++) s += hs[k]; this.shortZ.push(s / (30 * hop)); }
      }
    }
    Object.assign(this, { s1, s2, p1, p2, acc, inHop, samplePeak, tp, h0, h1, h2, c1, c2, bi, bAcc, bIn, si, sPk, sIn });
    this.n += b - a;
  }

  finish(): LoudnessReport {
    if (this.blockE && this.bIn > 0 && this.bi < this.blockE.length) this.blockE[this.bi] = this.bAcc;
    if (this.subPeak && this.sIn > 0 && this.si < this.subPeak.length) this.subPeak[this.si] = this.sPk;
    return gateReport(this.blockZ, this.shortZ, this.samplePeak, Math.max(this.tp, this.samplePeak), this.n / this.fs);
  }
}

/** BS.1770-4 gating, EBU 3342 LRA and the report — shared by every meter in the app. */
export function gateReport(blockZ: number[], shortZ: number[], samplePeak: number, truePeak: number, seconds: number): LoudnessReport {
  const absZ = blockZ.filter((z) => loudnessOf(z) > ABS_GATE);
  let integrated = -Infinity, used = 0;
  if (absZ.length) {
    const meanAbs = absZ.reduce((s, z) => s + z, 0) / absZ.length;
    const thr = loudnessOf(meanAbs) + REL_GATE;
    const keep = absZ.filter((z) => loudnessOf(z) > thr);
    used = keep.length;
    if (keep.length) integrated = loudnessOf(keep.reduce((s, z) => s + z, 0) / keep.length);
  }
  const stAbs = shortZ.filter((z) => loudnessOf(z) > ABS_GATE);
  const shortTermMax = stAbs.length ? loudnessOf(Math.max(...stAbs)) : -Infinity;
  let lra = 0;
  if (stAbs.length > 4) {
    const meanSt = stAbs.reduce((s, z) => s + z, 0) / stAbs.length;
    const gate = loudnessOf(meanSt) + LRA_REL;
    const vals = stAbs.filter((z) => loudnessOf(z) > gate).map(loudnessOf).sort((a, b) => a - b);
    if (vals.length > 1) {
      const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
      lra = q(0.95) - q(0.10);
    }
  }
  return {
    integrated, shortTermMax, lra,
    samplePeakDb: 20 * Math.log10(Math.max(1e-10, samplePeak)),
    truePeakDb: 20 * Math.log10(Math.max(1e-10, truePeak)),
    blocks: used, seconds,
  };
}

export async function measureLoudness(
  pcm: Int16Array,
  opts: { onProgress?: (frac: number) => void; signal?: AbortSignal } = {},
): Promise<LoudnessReport> {
  const m = new LoudnessMeter(16000);
  const STEP = 1 << 21, N = pcm.length;
  for (let a = 0; a < N; a += STEP) {
    m.push(pcm, a, Math.min(N, a + STEP));
    opts.onProgress?.(Math.min(1, (a + STEP) / N));
    if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    await new Promise((r) => setTimeout(r, 0));
  }
  return m.finish();
}
