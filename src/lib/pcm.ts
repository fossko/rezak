// Decodes the primary audio track to 16 kHz mono s16 PCM (used by Whisper, wav2vec2, silence
// detection and the waveform). Decoding uses WebCodecs via mediabunny (reads only audio packets,
// so a 15 GB video costs only its audio bytes); resampling uses the browser's native resampler
// (OfflineAudioContext) on overlapping chunks.
import { AudioBufferSink, type InputAudioTrack } from 'mediabunny';
import { SR } from './util';

export async function extractPcm16(
  track: InputAudioTrack, duration: number,
  onProgress?: (frac: number) => void, signal?: AbortSignal,
): Promise<Int16Array> {
  const sr = await track.getSampleRate();
  const r = SR / sr;
  const total = Math.ceil(duration * SR);
  const out = new Int16Array(total);

  // chunking of the input timeline (in source samples)
  const C = sr * 20;                       // 20 s per chunk -> C*r is an integer for common rates
  const OV = Math.round(sr * 0.1);         // overlap on each side
  let pend = new Float32Array(C + 2 * OV + sr);   // mono input starting at global index pendStart
  let pendStart = -OV, pendLen = OV;      // first chunk: OV zeros of "virtual" history
  let nextChunk = 0;                       // chunk index to render next
  let inPos = 0;                           // global index of the next input sample

  const render = async (k: number, final: boolean) => {
    // chunk k: input [k*C - OV, (k+1)*C + OV) -> output [k*C*r, (k+1)*C*r)
    const inStart = k * C - OV;
    const off = inStart - pendStart;
    const len = Math.min(pendLen - off, C + 2 * OV);
    if (len <= OV) return;
    const ctx = new OfflineAudioContext(1, Math.max(1, Math.round(len * r)), SR);
    const buf = ctx.createBuffer(1, len, sr);
    buf.copyToChannel(pend.subarray(off, off + len), 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start(0);
    const res = (await ctx.startRendering()).getChannelData(0);
    const j0 = Math.round(OV * r), oStart = Math.round(k * C * r);
    const n = final ? res.length - j0 : Math.round(C * r);
    for (let j = 0; j < n && j0 + j < res.length; j++) {
      const o = oStart + j; if (o >= total) break;
      const v = res[j0 + j];
      out[o] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
    }
  };
  const push = (mono: Float32Array) => {
    if (pendLen + mono.length > pend.length) {
      const np = new Float32Array(Math.max(pend.length * 2, pendLen + mono.length));
      np.set(pend.subarray(0, pendLen)); pend = np;
    }
    pend.set(mono, pendLen); pendLen += mono.length; inPos += mono.length;
  };
  const drain = async (final: boolean) => {
    // render every chunk whose full input (incl. right overlap) is available
    while (true) {
      const needEnd = (nextChunk + 1) * C + OV;
      if (!final && pendStart + pendLen < needEnd) break;
      if (final && nextChunk * C >= inPos) break;
      await render(nextChunk, final && pendStart + pendLen < needEnd);
      nextChunk++;
      // drop input no longer needed (keep from next chunk's start - OV)
      const keepFrom = nextChunk * C - OV - pendStart;
      if (keepFrom > 0) { pend.copyWithin(0, keepFrom, pendLen); pendLen -= keepFrom; pendStart += keepFrom; }
    }
  };

  const sink = new AudioBufferSink(track);
  let expected = 0;   // global source-sample index where the next buffer should start
  let first = true;
  for await (const { buffer, timestamp } of sink.buffers()) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const ch = buffer.numberOfChannels, n = buffer.length;
    let mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i]; }
    if (ch > 1) for (let i = 0; i < n; i++) mono[i] /= ch;
    let at = Math.round(timestamp * sr);
    if (first) { expected = 0; first = false; }
    if (at > expected + 1) { push(new Float32Array(at - expected)); expected = at; }   // gap -> silence
    if (at < expected) {                                                                 // overlap / priming -> drop
      const drop = expected - at; if (drop >= n) continue;
      mono = mono.subarray(drop); at = expected;
    }
    push(mono); expected += mono.length;
    await drain(false);
    onProgress?.(Math.min(1, timestamp / Math.max(1e-6, duration)));
  }
  push(new Float32Array(OV));   // right padding for the last chunk
  await drain(true);
  onProgress?.(1);
  return out;
}

/** Level envelope: dBFS RMS per 10 ms frame. */
export const LV_HOP = 0.01;
export function computeLevels(pcm: Int16Array): Float32Array {
  const hop = Math.round(LV_HOP * SR), n = Math.ceil(pcm.length / hop);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let acc = 0; const a = k * hop, b = Math.min(pcm.length, a + hop);
    for (let i = a; i < b; i++) { const v = pcm[i]; acc += v * v; }
    out[k] = 10 * Math.log10(acc / Math.max(1, b - a) / 1073741824 + 1e-10);
  }
  return out;
}

/** Suggest a noise-floor threshold from the level histogram (between the noise and speech modes). */
export function suggestThreshold(levels: Float32Array): number {
  const v = Float32Array.from(levels).sort();
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  const floor = q(0.05), speech = q(0.75);
  // midpoint (in dB) between the noise floor and typical speech; denoised recordings have a very low floor
  const t = Math.max(floor + 10, (floor + speech) / 2);
  return Math.round(Math.max(-65, Math.min(-30, t)));
}

/** Float32 copy of [a, b) seconds. */
export function pcmSlice(pcm: Int16Array, a: number, b: number): { data: Float32Array; t0: number } {
  const A = Math.max(0, Math.min(pcm.length, Math.round(a * SR)));
  const B = Math.max(A, Math.min(pcm.length, Math.round(b * SR)));
  const data = new Float32Array(B - A);
  for (let i = 0; i < data.length; i++) data[i] = pcm[A + i] / 32768;
  return { data, t0: A / SR };
}
