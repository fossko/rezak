// w2v-BERT 2.0 front-end (HF SeamlessM4TFeatureExtractor, as used by Sidon): Kaldi-style log-mel
// fbank, 80 bins, per-bin mean/variance normalisation, stride-2 stacking → [T, 160].
// Leaf module (no imports) so Node can unit-test it against the Python reference.

const N_FFT = 512, WIN = 400, HOP = 160, N_MEL = 80, SR = 16000;
const MEL_FLOOR = 1.192092955078125e-7;

let tables: { win: Float32Array; mel: Float32Array[]; melLo: Int32Array; cos: Float32Array; sin: Float32Array; rev: Uint32Array } | null = null;

const kaldiMel = (f: number) => 1127 * Math.log(1 + f / 700);

function init() {
  if (tables) return tables;
  // Povey window: symmetric Hann ^ 0.85
  const win = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1)), 0.85);
  // triangular filters in Kaldi mel space, 20..8000 Hz, over 257 rfft bins
  const nb = N_FFT / 2 + 1;
  const fftMel = new Float64Array(nb);
  for (let k = 0; k < nb; k++) fftMel[k] = kaldiMel((k * SR) / N_FFT);
  const lo = kaldiMel(20), hi = kaldiMel(8000);
  const pts = new Float64Array(N_MEL + 2);
  for (let i = 0; i < N_MEL + 2; i++) pts[i] = lo + ((hi - lo) * i) / (N_MEL + 1);
  const mel: Float32Array[] = [], melLo = new Int32Array(N_MEL);
  for (let m = 0; m < N_MEL; m++) {
    const a = pts[m], c = pts[m + 1], b = pts[m + 2];
    let first = -1; const w: number[] = [];
    for (let k = 0; k < nb; k++) {
      const v = Math.max(0, Math.min((fftMel[k] - a) / (c - a), (b - fftMel[k]) / (b - c)));
      if (v > 0) { if (first < 0) first = k; w[k - first] = v; } else if (first >= 0) break;
    }
    melLo[m] = Math.max(0, first);
    mel.push(Float32Array.from(w));
  }
  const cos = new Float32Array(N_FFT / 2), sin = new Float32Array(N_FFT / 2);
  for (let i = 0; i < N_FFT / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / N_FFT); sin[i] = -Math.sin((2 * Math.PI * i) / N_FFT); }
  const rev = new Uint32Array(N_FFT), bits = Math.log2(N_FFT);
  for (let i = 0; i < N_FFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  return (tables = { win, mel, melLo, cos, sin, rev });
}

/** In-place radix-2 complex FFT of size N_FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const { cos, sin, rev } = tables!;
  for (let i = 0; i < N_FFT; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1, step = N_FFT / size;
    for (let s = 0; s < N_FFT; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const i = s + k, j = i + half;
        const tr = re[j] * wr - im[j] * wi, ti = re[j] * wi + im[j] * wr;
        re[j] = re[i] - tr; im[j] = im[i] - ti; re[i] += tr; im[i] += ti;
      }
    }
  }
}

/** `x`: 16 kHz mono in [-1, 1] (the caller adds the 160-sample padding Sidon's demo uses).
 *  Returns features [T, 160] row-major (T = floor(frames / 2)). */
export function w2vBertFeatures(x: Float32Array): { data: Float32Array; T: number } {
  const { win, mel, melLo } = init();
  const frames = x.length < WIN ? 0 : 1 + Math.floor((x.length - WIN) / HOP);
  const T = frames >> 1;
  const fb = new Float32Array(frames * N_MEL);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), buf = new Float64Array(WIN);
  const pw = new Float64Array(N_FFT / 2 + 1);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    let mean = 0;
    for (let i = 0; i < WIN; i++) { buf[i] = x[o + i] * 32768; mean += buf[i]; }
    mean /= WIN;
    for (let i = 0; i < WIN; i++) buf[i] -= mean;
    for (let i = WIN - 1; i > 0; i--) buf[i] -= 0.97 * buf[i - 1];
    buf[0] *= 1 - 0.97;
    re.fill(0); im.fill(0);
    for (let i = 0; i < WIN; i++) re[i] = buf[i] * win[i];
    fft(re, im);
    for (let k = 0; k <= N_FFT / 2; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < N_MEL; m++) {
      const w = mel[m], k0 = melLo[m];
      let s = 0;
      for (let j = 0; j < w.length; j++) s += w[j] * pw[k0 + j];
      fb[f * N_MEL + m] = Math.log(Math.max(MEL_FLOOR, s));
    }
  }
  // per-mel-bin normalisation over time (sample variance, ddof = 1)
  for (let m = 0; m < N_MEL; m++) {
    let s = 0;
    for (let f = 0; f < frames; f++) s += fb[f * N_MEL + m];
    const mu = s / Math.max(1, frames);
    let v = 0;
    for (let f = 0; f < frames; f++) { const d = fb[f * N_MEL + m] - mu; v += d * d; }
    const sd = Math.sqrt(v / Math.max(1, frames - 1) + 1e-7);
    for (let f = 0; f < frames; f++) fb[f * N_MEL + m] = (fb[f * N_MEL + m] - mu) / sd;
  }
  // stride-2 stacking: [frames, 80] → [T, 160] (the trailing odd frame is dropped)
  return { data: fb.subarray(0, T * 2 * N_MEL), T };
}
