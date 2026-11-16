// Preview player of the carved result: frames drawn to a canvas (WebCodecs via mediabunny), audio
// scheduled on an AudioContext with short fades at every join. The AudioContext clock is the master
// clock; time runs on the OUTPUT timeline (removed parts don't exist). The timeline is composite:
// kept main-video content interleaved with заставки from other files.
import { CanvasSink, AudioBufferSink, type WrappedCanvas } from 'mediabunny';
import type { OpenedMedia } from '../lib/media';
import type { Composite, Clip } from '../lib/composite';
import { clipEnd } from '../lib/composite';
import { openTitle, type TitleMedia } from '../lib/titles';
import { Emitter } from '../lib/util';
import { VU_FLOOR_DB, vuDb } from '../lib/vu';
import { Stretcher } from './stretch';
import { restoreGains } from '../restore/engine';
import { MasterChain, type CompressorSettings } from '../lib/masterchain';

export type PlayerEvents = { time: { out: number; src: number }; state: { playing: boolean }; error: string };

const QUEUE = 10, AUDIO_AHEAD = 1.2;

export class Player extends Emitter<PlayerEvents> {
  private media: OpenedMedia;
  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private csink: CanvasSink | null = null;
  private asink: AudioBufferSink;
  private ac: AudioContext;
  private master: GainNode;
  /** Post-processing analyser: leveler/restoration → compressor/limiter → volume → this node. */
  private analyser: AnalyserNode;
  private meterData: Float32Array<ArrayBuffer>;
  private comp: Composite;
  private fps: number;
  fade = 0.012;

  playing = false;
  private outPos = 0;
  /** Paused playhead parked at a SOURCE time. It may sit inside a removed fragment: the output
   *  timeline has no such position, but the user must be able to put the playhead (and therefore the
   *  "selection follows playback") on a deleted word. Cleared as soon as playback starts. */
  private parked: number | null = null;
  private acStart = 0;
  private gen = 0;
  private frames: { c: HTMLCanvasElement | OffscreenCanvas; out: number }[] = [];
  private sources = new Set<AudioScheduledSourceNode>();
  private scrubSrcs = new Set<AudioScheduledSourceNode>();
  private scrubTok = 0;
  private raf = 0;
  private stillToken = 0;
  volume = 1;
  rate = 1;
  /** Processed-sound monitoring: leveler gain per SOURCE second + the master chain (null = original). */
  private mLeveler: ((t: number) => number) | null = null;
  private mChainCfg: (CompressorSettings & { ceilingDb: number }) | null = null;
  /** audio-only generation: bumps on every stop AND on a processed-sound re-sync (refreshAudio) */
  private agen = 0;
  /** per-generation audio bus (lets a re-sync crossfade old → new audio without touching the clock) */
  private bus: GainNode | null = null;
  private mutes: [number, number][] = [];
  private muteFade = 0.004;
  stats = { drawn: 0, late: 0, maxGap: 0, audio: 0 };
  /** How many buffers went through the leveler/chain (0 = monitoring the original sound). */
  masterBuffers = 0;
  /** «Реставрация»: restored (wet) source samples, null where not rendered yet; mixed BEFORE the gain curve
   *  and the compressor. `restoredBuffers`/`dryBuffers` count main buffers with/without wet (test hook). */
  private mRestore: ((s0: number, n: number) => Float32Array | null) | null = null;
  private mRestoreAmt = 0;
  restoredBuffers = 0;
  dryBuffers = 0;
  private lastDrawAt = 0;
  private titles = new Map<string, { media: Promise<TitleMedia>; csink: CanvasSink | null; asink: AudioBufferSink | null }>();

  constructor(media: OpenedMedia, canvas: HTMLCanvasElement) {
    super();
    this.media = media; this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d')!;
    this.fps = media.meta.fps || 30;
    this.ac = new AudioContext({ latencyHint: 'playback' });
    this.master = this.ac.createGain();
    this.analyser = this.ac.createAnalyser();
    this.analyser.fftSize = 1024;
    this.meterData = new Float32Array(this.analyser.fftSize);
    this.master.connect(this.analyser);
    this.analyser.connect(this.ac.destination);
    this.asink = new AudioBufferSink(media.audio);
    this.comp = { clips: [{ kind: 'main', a: 0, b: media.meta.duration, out: 0 }], duration: media.meta.duration, srcToOut: (t) => t, outToSrc: (o) => ({ clip: { kind: 'main', a: 0, b: media.meta.duration, out: 0 }, t: o }) };
    if (media.video) {
      const w = Math.min(960, media.meta.width || 960);
      canvas.width = w; canvas.height = Math.round(w * (media.meta.height || 540) / (media.meta.width || 960));
      this.csink = new CanvasSink(media.video, { width: canvas.width, height: canvas.height, fit: 'contain', poolSize: QUEUE + 6 });
    } else {
      // Audio-only source: the preview is a black frame of the usual 16:9 size (CSS also paints the
      // canvas black, but drawing it explicitly keeps screenshots/tests honest).
      canvas.width = 640; canvas.height = 360;
      this.paintBlack();
    }
    this.drawStill(0);
  }

  get duration() { return this.comp.duration; }
  get current(): number { return this.playing ? Math.min(this.comp.duration, this.outPos + Math.max(0, this.ac.currentTime - this.acStart) * this.rate) : this.outPos; }
  private get step() { return Math.max(1, this.rate * this.fps / 30) / this.fps; }
  get currentSrc(): number {
    if (this.parked != null) return this.parked;
    const { clip, t } = this.comp.outToSrc(this.current);
    return clip.kind === 'title' ? (clip.anchor ?? t) : t;
  }
  outOfSrc(t: number) { return this.comp.srcToOut(t); }

  setMutes(regions: [number, number][], fade: number) {
    if (JSON.stringify(regions) === JSON.stringify(this.mutes) && fade === this.muteFade) return;
    this.mutes = regions; this.muteFade = fade;
    if (this.playing) { this.stopAll(); this.startAll(); }
  }
  private muteGainAt(t: number) {
    const F = Math.max(1e-4, this.muteFade); let g = 1;
    for (const [a, b] of this.mutes) {
      if (t > b + F) continue;
      if (t < a - F) break;
      const v = t < a ? 0.5 + 0.5 * Math.cos(Math.PI * (t - (a - F)) / F) : t <= b ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * (t - b) / F);
      g = Math.min(g, v);
    }
    return g;
  }
  setRate(r: number) {
    if (r === this.rate) return;
    const was = this.playing;
    this.stopAll();
    this.rate = r;
    if (was) this.startAll();
  }

  /** Replace the timeline (composite clips). Playback continues from the same SOURCE position. */
  setComposite(comp: Composite) {
    const src = this.currentSrc;
    const was = this.playing;
    this.stopAll();
    this.comp = comp.clips.length ? comp : { clips: [{ kind: 'main', a: 0, b: 0.001, out: 0 }], duration: 0.001, srcToOut: () => 0, outToSrc: () => ({ clip: comp.clips[0] || { kind: 'main' as const, a: 0, b: 0.001, out: 0 }, t: 0 }) };
    this.outPos = Math.min(comp.srcToOut(src), this.comp.duration);
    if (was) this.startAll(); else this.drawStill(this.outPos);
    this.emit('time', { out: this.current, src: this.currentSrc });
  }

  async play() {
    if (this.playing) return;
    if (this.parked != null) {
      // The user may have parked inside a cut: skip it and start from the next kept frame.
      this.outPos = Math.min(this.comp.srcToOut(this.parked), this.comp.duration);
      this.parked = null;
    }
    if (this.outPos >= this.comp.duration - 0.05) this.outPos = 0;
    await this.ac.resume();
    await this.primeAudio(this.outPos);
    this.startAll();
    this.emit('state', { playing: true });
  }

  /** Decode the first audio buffer at `from` before the playhead clock starts. The WebCodecs audio
   *  decode and (on slow/local-network storage) the first byte-range reads can take hundreds of ms
   *  on first use; if the clock is already running then, `audioLoop` trims that late audio away and
   *  the first words play muted. Priming here absorbs that latency instead of dropping the audio. */
  private async primeAudio(from: number) {
    try {
      for (const clip of this.comp.clips) {
        if (clipEnd(clip) <= from) continue;
        const a = clip.kind === 'main' && clip.out <= from && from < clipEnd(clip)
          ? Math.max(clip.a, clip.a + (from - clip.out)) : clip.a;
        const asink = await this.clipAudio(clip);
        if (!asink) continue;
        const it = asink.buffers(a, clip.b);
        await it.next();
        await it.return(undefined as any).catch(() => {});
        return;
      }
    } catch { /* never block playback on a warm-up failure */ }
  }
  pause() {
    if (!this.playing) return;
    // stopAll() saves outPos = current. Don't also save it here: that would set outPos to the
    // current position, and stopAll() would then compute current again as outPos + elapsed, adding
    // the elapsed time a second time (the playhead jumps forward by however long playback ran).
    this.stopAll();
    this.emit('state', { playing: false });
    this.emit('time', { out: this.outPos, src: this.currentSrc });
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(out: number) {
    this.parked = null;
    out = Math.max(0, Math.min(this.comp.duration, out));
    const was = this.playing;
    this.stopAll();
    this.outPos = out;
    if (was) this.startAll(); else this.drawStill(out);
    this.emit('time', { out, src: this.currentSrc });
  }
  /** Move the playhead to a SOURCE time. While paused it parks exactly there — even inside a removed
   *  fragment — so clicking a cut word keeps the playhead (and "selection follows playback") on it.
   *  Removed fragments are skipped only when playback is requested (play()). */
  seekSrc(t: number) {
    if (this.playing) { this.parked = null; this.seek(this.comp.srcToOut(t)); return; }
    this.stopAll();
    this.parked = Math.max(0, Math.min(this.media.meta.duration, t));
    this.outPos = Math.min(this.comp.srcToOut(this.parked), this.comp.duration);
    this.drawStill(this.outPos);
    this.emit('time', { out: this.outPos, src: this.parked });
  }
  setVolume(v: number) { this.volume = v; this.master.gain.value = v; }

  /** RMS and sample peak of the final (post-leveller/restoration/compressor/volume) playback signal. */
  meterLevels(): { rmsDb: number; peakDb: number } {
    try {
      this.analyser.getFloatTimeDomainData(this.meterData);
      let sum = 0, peak = 0;
      for (let i = 0; i < this.meterData.length; i++) {
        const v = this.meterData[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      return vuDb(Math.sqrt(sum / this.meterData.length), peak);
    } catch {
      return { rmsDb: VU_FLOOR_DB, peakDb: VU_FLOOR_DB };
    }
  }
  destroy() { this.stopScrub(); this.stopAll(); this.ac.close().catch(() => {}); }

  /** Play a short snippet of the SOURCE audio at `at` (word scrubbing). Interruptible: each call stops
   *  the previous snippet immediately, so moving to the next word cuts the old sound and plays the new. */
  async scrub(at: number, ms: number) {
    this.stopScrub();
    const tok = this.scrubTok;
    if (this.playing || ms <= 0) return;
    try {
      if (this.ac.state !== 'running') await this.ac.resume();
      const a = Math.max(0, at), dur = ms / 1000;
      const it = this.asink.buffers(a, a + dur);
      const t0 = this.ac.currentTime + 0.006;
      let n = 0;
      const maxPackets = Math.ceil(ms / 10) + 4;   // fail-safe; the [a, a+dur] range already bounds it
      try {
        for await (const { buffer, timestamp, duration } of it) {
          if (tok !== this.scrubTok) return;
          const bs = Math.max(timestamp, a), be = Math.min(timestamp + duration, a + dur);
          if (be <= bs) continue;
          const src = this.ac.createBufferSource();
          src.buffer = buffer; src.connect(this.master);
          src.start(t0 + (bs - a), bs - timestamp, be - bs);
          this.scrubSrcs.add(src);
          src.onended = () => this.scrubSrcs.delete(src);
          if (++n >= maxPackets) break;
        }
      } finally { await it.return(undefined as any).catch(() => {}); }
    } catch { /* scrubbing is best-effort */ }
  }
  private stopScrub() {
    this.scrubTok++;
    for (const s of this.scrubSrcs) { try { s.stop(); } catch { /* */ } }
    this.scrubSrcs.clear();
  }

  // ---------------------------------------------------------------- title sources
  private title(id: string) {
    let t = this.titles.get(id);
    if (!t) { t = { media: openTitle(id), csink: null, asink: null }; this.titles.set(id, t); }
    return t;
  }
  private async titleCsink(id: string) {
    const t = this.title(id); if (t.csink) return t.csink;
    const m = await t.media;
    t.csink = new CanvasSink(m.video, { width: this.canvas.width, height: this.canvas.height, fit: 'contain', poolSize: QUEUE + 6 });
    return t.csink;
  }
  private async titleAsink(id: string) {
    const t = this.title(id); if (t.asink) return t.asink;
    const m = await t.media;
    t.asink = m.audio ? new AudioBufferSink(m.audio) : null;
    return t.asink;
  }
  private async clipSink(clip: Clip) {
    return clip.kind === 'main' ? this.csink : await this.titleCsink(clip.titleId!);
  }
  private async clipAudio(clip: Clip): Promise<AudioBufferSink | null> {
    return clip.kind === 'main' ? this.asink : await this.titleAsink(clip.titleId!);
  }

  // ---------------------------------------------------------------------------
  /** Turn processed monitoring on/off; the chain state is rebuilt on the next start/seek. */
  setMaster(leveler: ((t: number) => number) | null, chain: (CompressorSettings & { ceilingDb: number }) | null) {
    this.mLeveler = leveler; this.mChainCfg = chain;
  }

  setRestore(wet: ((s0: number, n: number) => Float32Array | null) | null, amount: number) {
    this.mRestore = amount > 0 ? wet : null; this.mRestoreAmt = amount;
  }
  /** Mix dry/wet in place; `t0` = SOURCE time of planes[*][0]. false if the wet part is not rendered yet. */
  private mixRestore(planes: Float32Array[], n: number, t0: number, sr: number): boolean {
    if (!this.mRestore) return false;
    const w = this.mRestore(Math.round(t0 * sr), n);
    if (!w) { this.dryBuffers++; return false; }
    const [d, a] = restoreGains(this.mRestoreAmt);
    for (const p of planes) for (let i = 0; i < n; i++) p[i] = p[i] * d + w[i] * a;
    this.restoredBuffers++;
    return true;
  }

  /** The processed sound changed while playing: re-decode the audio from ~0.1 s ahead with the new
   *  settings and crossfade into it (20 ms). Video and the clock are untouched, so there is no hitch. */
  refreshAudio() {
    if (!this.playing) return;
    const lead = 0.1, XF = 0.02, T = this.ac.currentTime + lead;
    const from = Math.min(this.comp.duration, this.outPos + (T - this.acStart) * this.rate);
    if (from >= this.comp.duration - 0.05) return;
    const old = this.bus;
    if (old) {
      old.gain.cancelScheduledValues(0); old.gain.setValueAtTime(1, T); old.gain.linearRampToValueAtTime(0, T + XF);
      setTimeout(() => old.disconnect(), (lead + XF + 0.2) * 1000);
    }
    for (const src of this.sources) { try { src.stop(T + XF + 0.005); } catch { /* */ } }
    const bus = this.ac.createGain();
    bus.gain.setValueAtTime(0, this.ac.currentTime); bus.gain.setValueAtTime(0, T); bus.gain.linearRampToValueAtTime(1, T + XF);
    bus.connect(this.master);
    this.bus = bus;
    const ag = ++this.agen;
    this.audioLoop(this.gen, ag, bus, from, this.outPos).catch((e) => this.fail(e));
    this.refreshes++;
  }
  /** test hook: number of processed-sound re-syncs */
  refreshes = 0;

  /** Apply the leveler (main content only) and the master chain to one decoded buffer. */
  private processBuffer(buffer: AudioBuffer, t0: number, useLeveler: boolean, st: { chain: MasterChain | null }): AudioBuffer {
    const master = !!(this.mChainCfg && this.mLeveler);
    if (!master && !(useLeveler && this.mRestore)) return buffer;
    const nch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate;
    const planes: Float32Array[] = [];
    for (let c = 0; c < nch; c++) planes.push(Float32Array.from(buffer.getChannelData(c)));
    // restoration first: the compressor must never squash what the restorer then "repairs" (user spec)
    const mixed = useLeveler && this.mixRestore(planes, n, t0, sr);
    if (!master && !mixed) return buffer;
    if (master) {
      if (!st.chain) st.chain = new MasterChain(nch, sr, this.mChainCfg!, this.mChainCfg!.ceilingDb);
      if (useLeveler) this.applyLeveler(planes, n, t0, sr);
      st.chain.process(planes, n);
      this.masterBuffers++;
    }
    const out = this.ac.createBuffer(nch, n, sr);
    for (let c = 0; c < nch; c++) out.copyToChannel(planes[c] as any, c);
    return out;
  }

  /** Gain curve (leveler + silence ducking) per 16 samples, shared by all channels. */
  private applyLeveler(planes: Float32Array[], n: number, t0: number, sr: number) {
    const lv = this.mLeveler!;
    for (let i = 0; i < n; i += 16) {
      const g = lv(t0 + i / sr), end = Math.min(n, i + 16);
      for (const p of planes) for (let k = i; k < end; k++) p[k] *= g;
    }
  }

  private stopAll() {
    if (this.playing) this.outPos = this.current;
    this.playing = false;
    this.gen++; this.agen++;
    this.bus?.disconnect(); this.bus = null;
    cancelAnimationFrame(this.raf);
    for (const s of this.sources) { try { s.stop(); } catch { /* */ } }
    this.sources.clear();
    this.frames = [];
  }
  private startAll() {
    this.stopScrub();   // normal playback always takes over from a scrub snippet
    this.playing = true;
    this.lastDrawAt = 0;
    const g = ++this.gen;
    this.acStart = this.ac.currentTime + 0.08;
    const bus = this.ac.createGain(); bus.connect(this.master); this.bus = bus;
    this.audioLoop(g, ++this.agen, bus, this.outPos, this.outPos).catch((e) => this.fail(e));
    this.videoLoop(g, this.outPos).catch((e) => this.fail(e));
    const tick = () => {
      if (g !== this.gen) return;
      const now = this.current;
      let pick = -1;
      for (let i = 0; i < this.frames.length; i++) if (this.frames[i].out <= now + 0.004) pick = i;
      if (pick >= 0) {
        const f = this.frames[pick];
        if (now - f.out > 1.5 * this.step) this.stats.late++;
        if (this.lastDrawAt) this.stats.maxGap = Math.max(this.stats.maxGap, now - this.lastDrawAt);
        this.lastDrawAt = now; this.stats.drawn++;
        this.draw(f.c); this.frames.splice(0, pick + 1);
      }
      this.emit('time', { out: now, src: this.currentSrc });
      if (now >= this.comp.duration - 0.001) { this.outPos = this.comp.duration; this.stopAll(); this.emit('state', { playing: false }); return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  private fail(e: any) {
    if (e && e.name === 'InputDisposedError') return;
    console.error(e);
    this.emit('error', String(e && e.message || e));
  }
  private draw(c: CanvasImageSource) { this.ctx2d.drawImage(c, 0, 0, this.canvas.width, this.canvas.height); }
  private paintBlack() {
    this.ctx2d.fillStyle = '#000';
    this.ctx2d.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
  private async drawStill(out: number) {
    const { clip, t } = this.comp.outToSrc(out);
    const csink = clip.kind === 'main' ? this.csink : await this.titleCsink(clip.titleId!).catch(() => null);
    if (!csink) { if (!this.playing) this.paintBlack(); return; }
    const tok = ++this.stillToken;
    const wc = await csink.getCanvas(Math.max(0, t)).catch(() => null);
    if (wc && tok === this.stillToken && !this.playing) this.draw(wc.canvas);
  }

  // ---------------------------------------------------------------- video
  private async videoLoop(g: number, from: number) {
    const step = this.step, tl = this.comp;
    let o = from;
    for (const clip of tl.clips) {
      if (g !== this.gen) return;
      const end = clipEnd(clip);
      if (end <= o) continue;
      if (clip.out > o) o = clip.out;
      const csink = await this.clipSink(clip);
      if (!csink) { o = end; continue; }
      const times: number[] = [], outs: number[] = [];
      for (let t = o; t < end; t += step) { outs.push(t); times.push(Math.min(clip.b - 1e-4, clip.a + (t - clip.out))); }
      if (!times.length) { o = end; continue; }
      const it = csink.canvasesAtTimestamps(times) as AsyncGenerator<WrappedCanvas | null>;
      let k = 0;
      try {
        for await (const wc of it) {
          if (g !== this.gen) return;
          if (wc) this.frames.push({ c: wc.canvas, out: outs[k] });
          k++;
          while (g === this.gen && this.frames.length >= QUEUE) await new Promise((r) => setTimeout(r, 8));
        }
      } finally { await it.return(undefined as any).catch(() => {}); }
      o = end;
    }
  }

  // ---------------------------------------------------------------- audio
  /** `base` = output time that corresponds to acStart (== from, except for a re-sync mid-playback). */
  private async audioLoop(g: number, ag: number, bus: GainNode, from: number, base: number) {
    const tl = this.comp, F = this.fade, rate = this.rate;
    const live = () => g === this.gen && ag === this.agen;
    const st = { chain: null as MasterChain | null };
    for (const clip of tl.clips) {
      if (!live()) return;
      // A clip that ends before the seek point is already in the past. Decoding it would only be
      // discarded by the late-trim below — but it costs O(position) decode (and, at rate !== 1, a full
      // WSOLA pass), so playback starts with several seconds of silence the further in you seek.
      if (clipEnd(clip) <= from) continue;
      const clipOut = clip.out, a0 = clip.a, b0 = clip.b, dur = b0 - a0;
      const isMain = clip.kind === 'main';
      const a = isMain && clipOut <= from && from < clipEnd(clip) ? Math.max(a0, clip.a + (from - clipOut)) : a0;
      const asink = await this.clipAudio(clip);
      const gain = this.ac.createGain();
      const mg = this.ac.createGain(); gain.connect(mg); mg.connect(bus);
      const when = (o: number) => this.acStart + (o - base) / rate;
      const t0 = when(clipOut + (a - a0)), t1 = when(clipOut + dur);
      const fi = Math.min(F, (t1 - t0) / 3);
      gain.gain.setValueAtTime(a > a0 + 1e-3 ? 1 : 0, Math.max(0, t0));
      if (a <= a0 + 1e-3) gain.gain.linearRampToValueAtTime(1, Math.max(0, t0 + fi));
      gain.gain.setValueAtTime(1, Math.max(0, t1 - fi));
      gain.gain.linearRampToValueAtTime(0, Math.max(0, t1));
      if (isMain) {
        const W = (t: number) => Math.max(0, when(clipOut + (t - a0)));
        const MF = this.muteFade;
        mg.gain.setValueAtTime(this.muteGainAt(a), W(a));
        for (const [ra, rb] of this.mutes) {
          if (rb + MF <= a || ra - MF >= b0) continue;
          for (const t of [ra - MF, ra, rb, rb + MF]) {
            const tc = Math.min(b0, Math.max(a, t));
            mg.gain.linearRampToValueAtTime(this.muteGainAt(tc), W(tc));
          }
        }
      }
      if (!asink) continue;   // title without audio: silence
      const it = asink.buffers(a, b0);
      if (rate !== 1) { await this.stretchedSegment(live, st, it, a, b0, t0, rate, gain, isMain); continue; }
      try {
        for await (const { buffer, timestamp, duration } of it) {
          if (!live()) return;
          const bs = Math.max(timestamp, a), be = Math.min(timestamp + duration, b0);
          if (be <= bs) continue;
          const at = when(clipOut + (bs - a0));
          const lateBy = this.ac.currentTime - at;
          let off = bs - timestamp, dur2 = be - bs, start = at;
          if (lateBy > 0) { if (lateBy >= dur2) continue; off += lateBy; dur2 -= lateBy; start = this.ac.currentTime; }
          const src = this.ac.createBufferSource();
          src.buffer = this.processBuffer(buffer, timestamp, isMain, st); src.connect(gain);
          src.start(start, off, dur2);
          this.stats.audio += dur2;
          this.sources.add(src);
          src.onended = () => this.sources.delete(src);
          while (live() && at - this.ac.currentTime > AUDIO_AHEAD) await new Promise((r) => setTimeout(r, 50));
        }
      } finally { await it.return(undefined as any).catch(() => {}); }
    }
  }

  private async stretchedSegment(live: () => boolean, cst: { chain: MasterChain | null }, it: AsyncGenerator<{ buffer: AudioBuffer; timestamp: number; duration: number }>,
    a: number, b: number, t0: number, rate: number, gain: GainNode, useLeveler = true) {
    let st: Stretcher | null = null, sr = 48000, emitted = 0;
    const schedule = (planes: Float32Array[] | null) => {
      if (!planes || !planes[0].length) return;
      const n = planes[0].length;
      let at = t0 + emitted / sr, from = 0;
      emitted += n;
      const lateBy = this.ac.currentTime - at;
      if (lateBy > 0) { from = Math.ceil(lateBy * sr); if (from >= n) return; at = this.ac.currentTime; }
      const buf = this.ac.createBuffer(planes.length, n - from, sr);
      planes.forEach((p, c) => buf.copyToChannel((from ? p.subarray(from) : p) as Float32Array<ArrayBuffer>, c));
      const src = this.ac.createBufferSource();
      src.buffer = buf; src.connect(gain); src.start(at);
      this.stats.audio += buf.duration;
      this.sources.add(src);
      src.onended = () => this.sources.delete(src);
    };
    try {
      for await (const { buffer, timestamp, duration } of it) {
        if (!live()) return;
        if (!st) { sr = buffer.sampleRate; st = new Stretcher(buffer.numberOfChannels, sr, rate); }
        const bs = Math.max(timestamp, a), be = Math.min(timestamp + duration, b);
        if (be <= bs) continue;
        const i0 = Math.round((bs - timestamp) * sr), i1 = Math.min(buffer.length, Math.round((be - timestamp) * sr));
        if (i1 <= i0) continue;
        const planes: Float32Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) planes.push(buffer.getChannelData(c).subarray(i0, i1));
        if (useLeveler && this.mRestore && !(this.mChainCfg && this.mLeveler)) {
          const proc = planes.map((p) => Float32Array.from(p));
          this.mixRestore(proc, proc[0].length, timestamp + i0 / sr, sr);
          st.push(proc);
        } else if (this.mChainCfg && this.mLeveler) {
          // the stretched path bypassed the chain before, so playback at 0.75–2× sounded like the original
          if (!cst.chain) cst.chain = new MasterChain(planes.length, sr, this.mChainCfg, this.mChainCfg.ceilingDb);
          const proc = planes.map((p) => Float32Array.from(p));
          if (useLeveler) this.mixRestore(proc, proc[0].length, timestamp + i0 / sr, sr);
          if (useLeveler) this.applyLeveler(proc, proc[0].length, bs, sr);
          cst.chain.process(proc, proc[0].length);
          this.masterBuffers++;
          st.push(proc);
        } else st.push(planes);
        schedule(st.pull());
        while (live() && t0 + emitted / sr - this.ac.currentTime > AUDIO_AHEAD) await new Promise((r) => setTimeout(r, 50));
      }
      if (st && live()) { st.flush(); schedule(st.pull()); }
    } finally { await it.return(undefined as any).catch(() => {}); }
  }
}
