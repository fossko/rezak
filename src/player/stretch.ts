// Pitch-preserving time stretch (WSOLA) for preview playback at 0.75–2×.
// Streaming: push planar input, pull planar output. Output length ≈ input length / rate.
// Frames of W samples (Hann, 50 % overlap) are taken from the input every Ha = Hs·rate samples,
// each shifted by up to ±D samples to best match the natural continuation of the previous frame
// (cross-correlation on a decimated mono mix), then overlap-added every Hs samples.

export class Stretcher {
  readonly rate: number;
  private ch: number;
  private W: number; private Hs: number; private D: number;
  private win: Float32Array;
  private inp: Float32Array[]; private inLen = 0; private inBase = 0;   // input buffer; inBase = global index of inp[0]
  private acc: Float32Array[];                                         // overlap-add accumulator (length W)
  private k = 0; private prevPos = -1;
  private out: Float32Array[] = []; private outLen = 0;
  private flushed = false;
  private inTotal = 0; private emitted = 0; private limit = Infinity;

  constructor(channels: number, sampleRate: number, rate: number) {
    this.ch = channels; this.rate = rate;
    this.W = 2 * Math.round(sampleRate * 0.016);    // ~32 ms frames
    this.Hs = this.W / 2;
    this.D = Math.round(sampleRate * 0.006);        // ±6 ms search
    this.win = new Float32Array(this.W);
    for (let i = 0; i < this.W; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.W);   // periodic Hann: sums to 1 at 50 %
    this.inp = Array.from({ length: channels }, () => new Float32Array(sampleRate));
    this.acc = Array.from({ length: channels }, () => new Float32Array(this.W));
  }

  push(planes: Float32Array[]) {
    const n = planes[0].length;
    if (this.inLen + n > this.inp[0].length) {
      const cap = Math.max(this.inp[0].length * 2, this.inLen + n);
      this.inp = this.inp.map((b) => { const nb = new Float32Array(cap); nb.set(b.subarray(0, this.inLen)); return nb; });
    }
    for (let c = 0; c < this.ch; c++) this.inp[c].set(planes[Math.min(c, planes.length - 1)], this.inLen);
    this.inLen += n;
    if (!this.flushed) this.inTotal += n;
    this.process();
  }

  /** No more input: pad with silence and emit everything that is left. */
  flush() {
    if (this.flushed) return;
    this.flushed = true;
    this.limit = Math.round(this.inTotal / this.rate);
    this.push(Array.from({ length: this.ch }, () => new Float32Array(this.W + 2 * this.D + Math.ceil(this.W * this.rate))));
  }

  /** Take all output produced so far. */
  pull(): Float32Array[] | null {
    const n = Math.min(this.outLen, this.limit - this.emitted);
    if (n <= 0) { this.out = []; this.outLen = 0; return null; }
    const res = Array.from({ length: this.ch }, (_, c) => {
      const o = new Float32Array(this.outLen); let p = 0;
      for (let j = c; j < this.out.length; j += this.ch) { o.set(this.out[j], p); p += this.out[j].length; }
      return n < this.outLen ? o.slice(0, n) : o;
    });
    this.out = []; this.outLen = 0; this.emitted += n;
    return res;
  }

  private process() {
    const { W, Hs, D, ch } = this;
    const Ha = Hs * this.rate;
    while (true) {
      const ideal = Math.round(this.k * Ha);
      const lo = Math.max(0, ideal - D), hi = ideal + D;
      // need input up to hi + W, and the natural continuation prevPos + Hs .. + W
      if (hi + W > this.inBase + this.inLen) break;
      let pos = ideal;
      if (this.prevPos >= 0) {
        const nat = this.prevPos + Hs;
        let best = -Infinity;
        const L = W, step = 4;   // decimated correlation over the whole frame
        for (let p = lo; p <= hi; p += 2) {
          let s = 0;
          for (let i = 0; i < L; i += step) {
            let a = 0, b = 0;
            for (let c = 0; c < ch; c++) { a += this.inp[c][p - this.inBase + i]; b += this.inp[c][nat - this.inBase + i]; }
            s += a * b * this.win[i];
          }
          if (s > best) { best = s; pos = p; }
        }
      }
      // overlap-add the frame
      for (let c = 0; c < ch; c++) {
        const a = this.acc[c], x = this.inp[c], off = pos - this.inBase;
        for (let i = 0; i < W; i++) a[i] += x[off + i] * this.win[i];
        // the first Hs samples are complete
        this.out.push(a.slice(0, Hs));
        a.copyWithin(0, Hs); a.fill(0, W - Hs);
      }
      this.outLen += Hs;
      this.prevPos = pos;
      this.k++;
      // drop input that can't be needed any more
      const keepFrom = Math.min(Math.round(this.k * Ha) - D, this.prevPos + Hs);
      const drop = keepFrom - this.inBase;
      if (drop > 4096) {
        for (let c = 0; c < ch; c++) this.inp[c].copyWithin(0, drop, this.inLen);
        this.inLen -= drop; this.inBase += drop;
      }
    }
  }
}
