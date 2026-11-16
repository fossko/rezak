// MP4 export of the carved result: frame-accurate video re-encoded with WebCodecs (hardware H.264),
// audio cut sample-accurately with short fades at every join, encoded to AAC. Written straight to
// disk through the File System Access API, so output size is not limited by memory. The timeline is
// composite: kept main content interleaved with заставки (their frames are scaled to the main size).
import {
  Output, Mp4OutputFormat, StreamTarget, BufferTarget, VideoSampleSink, VideoSampleSource,
  AudioSampleSource, AudioSample, canEncodeAudio, canEncodeVideo, type VideoSample,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { streamAudioComposite, titlePcm, type ClipAudio } from './audio';
import { clipEnd, type Composite } from '../lib/composite';
import type { OpenedMedia } from '../lib/media';
import type { TitleMedia } from '../lib/titles';
import type { MasterOptions, RestoreOptions } from './audio';

export interface ExportOptions {
  videoBitrate: number;
  audioBitrate: number;
  fade: number;
  mutes?: [number, number][];
  muteFade?: number;
  onProgress?: (frac: number, info: string) => void;
  signal?: AbortSignal;
  /** Phrase leveler + master compressor/limiter for the exported audio. */
  master?: MasterOptions;
  restore?: RestoreOptions;
}

let aacChecked = false;
async function ensureAac() {
  if (aacChecked) return;
  aacChecked = true;
  if (!(await canEncodeAudio('aac'))) registerAacEncoder();
}

const delayCache = new Map<string, number>();
export async function measureAacDelay(sr: number, ch: number, bitrate: number): Promise<number> {
  const key = `${sr}|${ch}|${bitrate}`;
  if (delayCache.has(key)) return delayCache.get(key)!;
  let result = 1024;
  try {
    const cfg: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, bitrate };
    if (!(await AudioEncoder.isConfigSupported(cfg)).supported) throw new Error('no native AAC');
    const N = sr, at = Math.round(sr * 0.3), bl = Math.round(sr * 0.01);
    const burst = new Float32Array(bl);
    for (let i = 0; i < bl; i++) burst[i] = Math.sin(2 * Math.PI * 1000 * i / sr) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / bl)) * 0.8;
    const pcm = new Float32Array(N * ch);
    for (let c = 0; c < ch; c++) pcm.set(burst, c * N + at);
    const chunks: EncodedAudioChunk[] = []; let dcfg: AudioDecoderConfig | null = null;
    const enc = new AudioEncoder({ output: (c, m) => { chunks.push(c); if (m?.decoderConfig) dcfg = m.decoderConfig; }, error: (e) => { throw e; } });
    enc.configure(cfg);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: N, numberOfChannels: ch, timestamp: 0, data: pcm }));
    await enc.flush(); enc.close();
    const out: Float32Array[] = [];
    const dec = new AudioDecoder({ output: (d) => { const f = new Float32Array(d.numberOfFrames); d.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); out.push(f); d.close(); }, error: (e) => { throw e; } });
    dec.configure(dcfg || { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch });
    for (const c of chunks) dec.decode(c);
    await dec.flush(); dec.close();
    const y = new Float32Array(out.reduce((a, f) => a + f.length, 0)); let o = 0; for (const f of out) { y.set(f, o); o += f.length; }
    let best = -1, bv = -Infinity;
    for (let s = 0; s + bl < y.length; s++) { let v = 0; for (let i = 0; i < bl; i += 2) v += y[s + i] * burst[i]; if (v > bv) { bv = v; best = s; } }
    const d = best - at;
    if (best >= 0 && d >= 0 && d < 8192) result = d;
  } catch (e) { console.warn('AAC delay measurement failed, assuming 1024', e); }
  delayCache.set(key, result);
  return result;
}

export function defaultVideoBitrate(srcBitrate: number) {
  const b = srcBitrate > 0 ? srcBitrate * 1.3 : 10e6;
  return Math.round(Math.min(40e6, Math.max(8e6, b)) / 1e5) * 1e5;
}

export async function pickOutputFile(suggestedName: string, kind: 'mp4' | 'mp3' = 'mp4'): Promise<FileSystemFileHandle | null> {
  const w = window as any;
  if (w.__carverTestHandle) return await w.__carverTestHandle(suggestedName);
  if (!w.showSaveFilePicker || w.__carverNoPicker) return null;
  try {
    const types = kind === 'mp3' ? [{ description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } }] : [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }];
    return await w.showSaveFilePicker({ suggestedName, types, id: 'carver-' + kind });
  } catch (e: any) {
    if (e && e.name === 'AbortError') throw e;
    return null;
  }
}

/** Audio clips of the whole composite (title audio resolved and resampled once). */
export async function buildClipAudio(media: OpenedMedia, comp: Composite, titles: Map<string, TitleMedia>): Promise<ClipAudio[]> {
  const sr = media.meta.sampleRate, ch = Math.min(2, media.meta.channels);
  const out: ClipAudio[] = [];
  for (const c of comp.clips) {
    if (c.kind === 'main') out.push({ a: c.a, b: c.b, isMain: true, pcm: null });
    else {
      const tm = titles.get(c.titleId!);
      out.push({ a: c.a, b: c.b, isMain: false, pcm: tm ? await titlePcm(tm, c.a, c.b, sr, ch) : null });
    }
  }
  return out;
}

export async function exportMp4(media: OpenedMedia, comp: Composite, titles: Map<string, TitleMedia>, handle: FileSystemFileHandle | null, o: ExportOptions): Promise<Blob | null> {
  await ensureAac();
  const fps = media.meta.fps || 30;
  const outDur = comp.duration;
  const nFrames = Math.max(1, Math.round(outDur * fps));
  const sr = media.meta.sampleRate, ch = Math.min(2, media.meta.channels);
  const W = media.meta.width, H = media.meta.height;
  const check = () => { if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError'); };

  if (media.video && !(await canEncodeVideo('avc', { width: W, height: H, bitrate: o.videoBitrate }))) {
    throw new Error('Этот браузер не умеет кодировать H.264 в таком размере.');
  }
  let writable: FileSystemWritableFileStream | null = null;
  if (handle) writable = await (handle as any).createWritable();
  const target = writable ? new StreamTarget(writable as any, { chunked: true, chunkSize: 16 << 20 }) : new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: writable ? 'reserve' : 'in-memory' }), target });

  let vsrc: VideoSampleSource | null = null;
  if (media.video) {
    vsrc = new VideoSampleSource({
      codec: 'avc', bitrate: o.videoBitrate, keyFrameInterval: 2, latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware', sizeChangeBehavior: 'contain',
    });
    output.addVideoTrack(vsrc, { frameRate: fps, maximumPacketCount: Math.ceil(nFrames * 1.05) + 64 });
  }
  const asrc = new AudioSampleSource({ codec: 'aac', bitrate: o.audioBitrate });
  output.addAudioTrack(asrc, { maximumPacketCount: Math.ceil(outDur * 100 * 1.4) + 256 });
  await output.start();

  const delay = await measureAacDelay(sr, ch, o.audioBitrate);
  console.log('[carver] AAC encoder delay', delay, 'frames');
  const clips = await buildClipAudio(media, comp, titles);
  let vOut = 0, aOut = 0;
  const t0 = performance.now();
  const report = () => {
    const done = Math.min(vsrc ? vOut : aOut, aOut) / Math.max(1e-6, outDur);
    const el = (performance.now() - t0) / 1000, speed = done > 0 ? (done * outDur) / el : 0;
    o.onProgress?.(done, speed > 0 ? `×${speed.toFixed(1)} · осталось ≈ ${Math.ceil((outDur - done * outDur) / speed / 60)} мин` : '');
  };

  // ---- video: one frame grid over the composite, decoded per source, titles scaled to main size
  const videoTask = async () => {
    if (!vsrc || !media.video) return;
    const sinks = new Map<string, VideoSampleSink>();
    const sinkFor = (clipId?: string) => {
      if (!clipId) return new VideoSampleSink(media.video!, { hardwareAcceleration: 'prefer-hardware' });
      let s = sinks.get(clipId);
      if (!s) { s = new VideoSampleSink(titles.get(clipId)!.video, { hardwareAcceleration: 'prefer-hardware' }); sinks.set(clipId, s); }
      return s;
    };
    let f = 0;
    for (const clip of comp.clips) {
      check();
      if (f / fps >= outDur) break;
      const end = clipEnd(clip), first = f / fps;
      if (end <= first) continue;
      const sink = sinkFor(clip.titleId);
      const times: number[] = [], outs: number[] = [];
      for (let o = first; o < end; o += 1 / fps) { outs.push(o); times.push(Math.min(clip.b - 1e-4, clip.a + (o - clip.out) + 0.5 / fps)); }
      let k = 0, last: VideoSample | null = null;
      for await (const s of sink.samplesAtTimestamps(times)) {
        check();
        let sample: VideoSample | null = s;
        if (!sample) { if (!last) { k++; continue; } sample = last.clone(); }
        else { last?.close(); last = sample.clone(); }
        if (clip.kind === 'title' && sample.displayWidth !== W) {
          const scaled = await sample.transform({ width: W, height: H, fit: 'contain' });
          sample.close(); sample = scaled;
        }
        sample.setTimestamp(f / fps); sample.setDuration(1 / fps);
        await vsrc.add(sample);
        sample.close();
        f++; k++; vOut = f / fps;
        if (f % 15 === 0) report();
        while (aOut < vOut - 3 && aOut < outDur - 0.01) { check(); await new Promise((r) => setTimeout(r, 5)); }
      }
      last?.close();
    }
    vOut = outDur;
  };

  const audioTask = async () => {
    await streamAudioComposite(media, clips, {
      master: o.master, restore: o.restore,
      fade: o.fade, mutes: o.mutes || [], muteFade: o.muteFade ?? 0.004, delay, padEnd: true, signal: o.signal,
      add: (smp) => asrc.add(smp),
      onAdvance: async (t) => { aOut = t; while (vsrc && vOut < aOut - 3 && vOut < outDur - 0.01) { check(); await new Promise((r) => setTimeout(r, 5)); } },
    });
    aOut = outDur;
  };

  try {
    await Promise.all([videoTask(), audioTask()]);
    check();
    o.onProgress?.(1, 'Запись файла…');
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    if (writable) await writable.abort?.().catch(() => {});
    throw e;
  }
  if (target instanceof BufferTarget) return new Blob([target.buffer!], { type: 'video/mp4' });
  return null;
}
