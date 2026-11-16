// Composite audio renderer for MP4 and MP3 export: decodes the timeline sample-accurately — main
// content plus заставки — applies a raised-cosine fade at every join and silences muted words, then
// feeds continuous AudioSamples to an encoder. Cuts are identical for every output, so all files
// rendered from the same timeline have the same length.
import { restoreGains } from '../restore/engine';
import {
  AudioSampleSink, AudioBufferSink, AudioSample, Output, Mp3OutputFormat, StreamTarget, BufferTarget, AudioSampleSource,
  Input, BufferSource, ALL_FORMATS, canEncodeAudio,
} from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import type { OpenedMedia } from '../lib/media';
import type { TitleMedia } from '../lib/titles';
import { MasterChain, DEFAULT_COMPRESSOR, DEFAULT_CEILING_DB, type CompressorSettings } from '../lib/masterchain';

export interface ClipAudio {
  a: number; b: number; isMain: boolean;
  pcm: Float32Array[] | null;      // title clips: resampled to output rate/channels (main clips use media.audio)
}

export interface MasterOptions {
  /** Linear gain per SOURCE second from the slow phrase leveler (main content only). */
  leveler?: (srcSeconds: number) => number;
  compressor?: CompressorSettings;
  ceilingDb?: number;
}

/** «Реставрация»: dry/wet amount and the restored main-source samples (source rate, mono) for [s0, s0+n). */
export interface RestoreOptions {
  amount: number;
  wet: (s0: number, n: number, signal?: AbortSignal) => Promise<Float32Array>;
}

export interface StreamAudioOptions {
  master?: MasterOptions;
  restore?: RestoreOptions;
  fade: number;
  mutes: [number, number][];       // main source-time ranges to silence
  muteFade: number;
  delay: number;
  padEnd: boolean;
  /** Encoder sample rate when it differs from the source (e.g. 96 kHz WAV → 48 kHz MP3). The whole
   *  timeline is rendered at the source rate, then linearly resampled on the fly before encoding. */
  outSampleRate?: number;
  signal?: AbortSignal;
  add: (s: AudioSample) => Promise<void>;
  onAdvance?: (outSeconds: number) => Promise<void> | void;
}

/** Streaming linear-interpolation resampler with the phase carried across chunks. Used only when the
 *  encoder cannot take the source rate (e.g. 96/192 kHz WAV → MP3 max 48 kHz). Speech content above the
 *  new Nyquist is negligible, so the cheap kernel is enough; the timeline itself is untouched. */
class LinearResampler {
  private frac = 0;
  private prev: Float32Array | null = null;
  constructor(private readonly ratio: number, private readonly ch: number) {}
  push(planes: Float32Array[], n: number): { planes: Float32Array[]; n: number } {
    if (n <= 0) return { planes, n: 0 };
    const cap = Math.ceil(n * this.ratio) + 2;
    const out = Array.from({ length: this.ch }, () => new Float32Array(cap));
    const step = 1 / this.ratio;
    let x = this.frac, j = 0;
    while (x <= n - 1 + 1e-9 && j < cap) {
      const i0 = Math.floor(x), f = x - i0;
      for (let c = 0; c < this.ch; c++) {
        const a = i0 < 0 ? (this.prev ? this.prev[c] : 0) : planes[c][Math.min(i0, n - 1)];
        const b = i0 + 1 < n ? planes[c][i0 + 1] : planes[c][n - 1];
        out[c][j] = a + (b - a) * f;
      }
      x += step; j++;
    }
    this.frac = x - n;
    this.prev = Float32Array.from(planes, (p) => p[n - 1]);
    return { planes: out, n: j };
  }
}

export async function streamAudioComposite(media: OpenedMedia, clips: ClipAudio[], o: StreamAudioOptions) {
  const srcSr = media.meta.sampleRate, ch = Math.min(2, media.meta.channels);
  const sr = o.outSampleRate || srcSr;          // encoder rate (MP3 cannot take 96/192 kHz)
  const rs = sr !== srcSr ? new LinearResampler(sr / srcSr, ch) : null;
  const check = () => { if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError'); };
  const F = Math.max(1, Math.round(o.fade * srcSr)), MF = Math.max(1e-4, o.muteFade);
  // Any use of the master options means the full chain: the leveler alone would push peaks straight
  // into the encoder, so the compressor and the safety limiter always come with it.
  const chain = o.master
    ? new MasterChain(ch, srcSr, o.master.compressor || DEFAULT_COMPRESSOR, o.master.ceilingDb ?? DEFAULT_CEILING_DB)
    : null;
  const mainSink = new AudioBufferSink(media.audio);
  let outFrame = 0, accOut = 0;
  const CH = 4096;
  const buf = Array.from({ length: ch }, () => new Float32Array(CH));
  let fill = 0, skip = o.delay, encFrame = 0;
  // the limiter looks ahead, so its output lags by `latency` frames: drop that many processed frames at the
  // start and push the same number of zeros through at the end ⇒ sample-exact, same length as without it
  let latSkip = chain ? chain.latency : 0;
  /** Push frames at the ENCODER rate, dropping the codec priming delay (in encoder frames). */
  const emitOut = async (planes: Float32Array[], n: number) => {
    const off = Math.min(skip, n); skip -= off;
    n -= off; if (n <= 0) return;
    const data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(planes[c].subarray(off, off + n), c * n);
    const smp = new AudioSample({ data, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: encFrame / sr });
    await o.add(smp); smp.close();
    encFrame += n;
  };
  /** Push frames at the SOURCE rate through the master chain, then (if needed) the resampler. */
  const emit = async (planes: Float32Array[], n: number) => {
    if (chain) {
      chain.process(planes, n);
      if (latSkip) { const d = Math.min(latSkip, n); latSkip -= d; planes = planes.map((p) => p.subarray(d)); n -= d; if (!n) return; }
    }
    if (rs) { const r = rs.push(planes, n); await emitOut(r.planes, r.n); }
    else await emitOut(planes, n);
  };
  const flush = async () => {
    if (!fill) return;
    await emit(buf.map((b) => b.subarray(0, fill)), fill);
    outFrame += fill; fill = 0;
    await o.onAdvance?.(encFrame / sr);
  };
  const tmp = Array.from({ length: ch }, () => new Float32Array(0));
  for (const clip of clips) {
    check();
    accOut += clip.b - clip.a;
    const segFrames = Math.round(accOut * srcSr) - (outFrame + fill);
    if (segFrames <= 0) continue;
    const fl = Math.min(F, Math.floor(segFrames / 3));
    const mutes = clip.isMain ? o.mutes.filter(([a, b]) => b + MF > clip.a && a - MF < clip.b) : [];
    const muteAt = (t: number) => {
      let g = 1;
      for (const [a, b] of mutes) {
        if (t >= b + MF || t <= a - MF) continue;
        const v = t < a ? 0.5 + 0.5 * Math.cos(Math.PI * (t - (a - MF)) / MF) : t <= b ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * (t - b) / MF);
        if (v < g) g = v;
      }
      return g;
    };
    let pos = 0;
    const put = (getter: (c: number, i: number) => number, from: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const p = pos + i;
        let g = p < fl ? 0.5 - 0.5 * Math.cos(Math.PI * (p + 0.5) / fl)
          : p >= segFrames - fl ? 0.5 - 0.5 * Math.cos(Math.PI * (segFrames - p - 0.5) / fl) : 1;
        if (mutes.length) g *= muteAt(clip.a + p / srcSr);
        if (o.master?.leveler && clip.isMain) g *= o.master.leveler(clip.a + p / srcSr);
        for (let c = 0; c < ch; c++) buf[c][fill] = getter(c, from + i) * g;
        fill++;
        if (fill === CH) return i + 1;
      }
      return n;
    };
    const writeRange = async (getter: (c: number, i: number) => number, from: number, n: number) => {
      while (n > 0) {
        const w = put(getter, from, n);
        pos += w; from += w; n -= w;
        if (fill === CH) await flush();
      }
    };
    if (clip.pcm) {
      // title: pre-resampled planes
      const planes = clip.pcm.map((p) => p.subarray(0, segFrames));
      await writeRange((c, i) => planes[c][i], 0, segFrames);
    } else if (clip.isMain) {
      for await (const smp of mainSink.buffers(clip.a, clip.b)) {
        check();
        const sCh = smp.buffer.numberOfChannels, nf = smp.buffer.length;
        const rel = Math.round((smp.timestamp - clip.a) * srcSr);
        const i0 = Math.max(0, pos - rel);
        const i1 = Math.min(nf, segFrames - rel);
        if (i1 <= i0) { if (rel >= segFrames) break; continue; }
        if (rel + i0 > pos) await writeRange(() => 0, 0, rel + i0 - pos);
        for (let c = 0; c < ch; c++) {
          if (tmp[c].length < nf) tmp[c] = new Float32Array(nf);
          const plane = smp.buffer.getChannelData(Math.min(c, sCh - 1));
          tmp[c].set(plane, 0);
        }
        if (o.restore && o.restore.amount > 0) {
          // restoration before the gain curve (leveler + ducking) and the compressor
          const w = await o.restore.wet(Math.round(smp.timestamp * srcSr), nf, o.signal);
          const [d, am] = restoreGains(o.restore.amount);
          for (let c = 0; c < ch; c++) { const t = tmp[c]; for (let i = 0; i < nf; i++) t[i] = t[i] * d + w[i] * am; }
        }
        await writeRange((c, i) => tmp[c][i], i0, i1 - i0);
        if (pos >= segFrames) break;
      }
    } else {
      await writeRange(() => 0, 0, segFrames);   // title without audio: silence
    }
    if (pos < segFrames) await writeRange(() => 0, 0, segFrames - pos);
  }
  await flush();
  if (chain) {
    const lat = chain.latency, z = Array.from({ length: ch }, () => new Float32Array(lat));
    // the encoder-priming skip may have swallowed the start, but the tail always needs the limiter flushed
    await emit(z, lat);
  }
  // encoder priming padding is already in encoder frames, so it bypasses the resampler
  if (o.padEnd && o.delay > 0) await emitOut(Array.from({ length: ch }, () => new Float32Array(o.delay)), o.delay);
}

/** Decode and resample a title's audio [a,b] to the output rate/channels (titles are short). */
export async function titlePcm(m: TitleMedia, a: number, b: number, outSr: number, outCh: number): Promise<Float32Array[] | null> {
  if (!m.audio) return null;
  const native = await m.audio.getSampleRate(), ch = await m.audio.getNumberOfChannels();
  const parts: Float32Array[][] = Array.from({ length: ch }, () => []);
  for await (const { buffer, timestamp, duration } of new AudioBufferSink(m.audio).buffers(a, b)) {
    const bs = Math.max(timestamp, a), be = Math.min(timestamp + duration, b);
    if (be <= bs) continue;
    const i0 = Math.round((bs - timestamp) * native), i1 = Math.round((be - timestamp) * native);
    for (let c = 0; c < ch; c++) parts[c].push(buffer.getChannelData(c).slice(i0, i1));
  }
  const n = Math.max(1, Math.round((b - a) * native));
  const src = parts.map((list) => {
    const o = new Float32Array(n); let p = 0; for (const seg of list) { o.set(seg, p); p += seg.length; } return o;
  });
  // resample + down/upmix via OfflineAudioContext
  const ctx = new OfflineAudioContext(outCh, Math.max(1, Math.round((b - a) * outSr)), outSr);
  const buf = ctx.createBuffer(ch, n, native);
  for (let c = 0; c < ch; c++) buf.copyToChannel(src[c], c);
  const node = ctx.createBufferSource(); node.buffer = buf; node.connect(ctx.destination); node.start(0);
  const rendered = await ctx.startRendering();
  return Array.from({ length: outCh }, (_, c) => rendered.getChannelData(c));
}

// ---------------------------------------------------------------- MP3
let mp3Ready: Promise<void> | null = null;
const ensureMp3 = () => (mp3Ready ||= (async () => { if (!(await canEncodeAudio('mp3'))) registerMp3Encoder(); })());

const mp3DelayCache = new Map<string, number>();
export async function measureMp3Delay(sr: number, ch: number, bitrate: number): Promise<number> {
  const key = `${sr}|${ch}|${bitrate}`;
  if (mp3DelayCache.has(key)) return mp3DelayCache.get(key)!;
  await ensureMp3();
  let result = 1105;
  try {
    const N = sr, at = Math.round(sr * 0.3), bl = Math.round(sr * 0.01);
    const burst = new Float32Array(bl);
    for (let i = 0; i < bl; i++) burst[i] = Math.sin(2 * Math.PI * 1000 * i / sr) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / bl)) * 0.8;
    const pcm = new Float32Array(N * ch);
    for (let c = 0; c < ch; c++) pcm.set(burst, c * N + at);
    const target = new BufferTarget();
    const out = new Output({ format: new Mp3OutputFormat(), target });
    const src = new AudioSampleSource({ codec: 'mp3', bitrate });
    out.addAudioTrack(src);
    await out.start();
    const smp = new AudioSample({ data: pcm, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: 0 });
    await src.add(smp); smp.close();
    await out.finalize();
    const input = new Input({ source: new BufferSource(target.buffer!), formats: ALL_FORMATS });
    const track = (await input.getPrimaryAudioTrack())!;
    const ys: Float32Array[] = [];
    for await (const s of new AudioSampleSink(track).samples()) {
      const f = new Float32Array(s.numberOfFrames); s.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); ys.push(f); s.close();
    }
    const y = new Float32Array(ys.reduce((a, f) => a + f.length, 0)); let p = 0; for (const f of ys) { y.set(f, p); p += f.length; }
    let best = -1, bv = -Infinity;
    for (let s = 0; s + bl < y.length; s++) { let v = 0; for (let i = 0; i < bl; i += 2) v += y[s + i] * burst[i]; if (v > bv) { bv = v; best = s; } }
    const d = best - at;
    if (best >= 0 && d >= 0 && d < 8192) result = d;
  } catch (e) { console.warn('MP3 delay measurement failed, assuming 1105', e); }
  mp3DelayCache.set(key, result);
  return result;
}

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
/** MP3 (LAME) accepts only these sample rates. High-resolution audio (96/192 kHz WAV, FLAC) is
 *  resampled down for the MP3 export; other outputs keep the source rate. */
export function mp3OutputRate(src: number): number {
  if (MP3_RATES.includes(src)) return src;
  if (src > 48000) return 48000;
  return MP3_RATES.reduce((best, r) => Math.abs(r - src) < Math.abs(best - src) ? r : best, 44100);
}

export interface Mp3Options {
  bitrate: number; fade: number; mutes: [number, number][]; muteFade: number;
  signal?: AbortSignal; onProgress?: (frac: number, info: string) => void;
  master?: MasterOptions;
  restore?: RestoreOptions;
}
export async function exportMp3(media: OpenedMedia, clips: ClipAudio[], outDur: number, handle: FileSystemFileHandle | null, o: Mp3Options): Promise<Blob | null> {
  await ensureMp3();
  const srcSr = media.meta.sampleRate, ch = Math.min(2, media.meta.channels);
  const sr = mp3OutputRate(srcSr);
  const delay = await measureMp3Delay(sr, ch, o.bitrate);
  console.log('[carver] MP3 encoder delay', delay, 'frames', sr !== srcSr ? `(resampled ${srcSr} → ${sr} Hz)` : '');
  let writable: FileSystemWritableFileStream | null = null;
  if (handle) writable = await (handle as any).createWritable();
  const target = writable ? new StreamTarget(writable as any, { chunked: true, chunkSize: 8 << 20 }) : new BufferTarget();
  const output = new Output({ format: new Mp3OutputFormat(), target });
  const src = new AudioSampleSource({ codec: 'mp3', bitrate: o.bitrate });
  output.addAudioTrack(src);
  await output.start();
  const t0 = performance.now();
  try {
    await streamAudioComposite(media, clips, {
      master: o.master, restore: o.restore,
      fade: o.fade, mutes: o.mutes, muteFade: o.muteFade, delay, padEnd: false, signal: o.signal,
      outSampleRate: sr !== srcSr ? sr : undefined,
      add: (s) => src.add(s),
      onAdvance: (t) => {
        const el = (performance.now() - t0) / 1000, speed = t / Math.max(1e-3, el);
        o.onProgress?.(t / Math.max(1e-6, outDur), speed > 0 ? `×${speed.toFixed(0)} · осталось ≈ ${Math.ceil((outDur - t) / speed / 60)} мин` : '');
      },
    });
    if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    if (writable) await (writable as any).abort?.().catch(() => {});
    throw e;
  }
  if (target instanceof BufferTarget) return new Blob([target.buffer!], { type: 'audio/mpeg' });
  return null;
}
