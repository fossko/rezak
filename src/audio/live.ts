// Live master: the main-thread side of the loudness processing. Owns the block analysis, the current
// settings (project state), the fast model of the processed wave, the exact tiles coming back from the
// DSP worker and the exact samples for the zoomed-in view. Nothing here walks the whole recording on
// the UI thread except the block model (≈ 540 k blocks per 1.5 h — milliseconds).
import type { LoudnessReport } from '../lib/loudness';
import {
  DEFAULT_DUCK, TILE_BLOCKS, addCurves, calibrate, curveBlocks, duckPoints, compBlocks, limitBlocks, modelLevels, modelLufs as modelLufsOf, renderRange,
  type BlockAnalysis, type CurvePt, type DuckSettings, type PhraseLevel,
} from '../lib/dsp';
import type { ChainSettings, CompressorSettings } from '../lib/masterchain';

export interface MasterOpt {
  kind: 'leveler'; maxGainDb: number; targetLufs: number;
  /** phrase leveling (⚙ «Звук»); false = compressor + make-up only. Missing in older projects = on. */
  leveler?: boolean;
}

/** Everything that defines the processed sound (persisted in the project as `project.master`). */
export interface MasterSaved {
  opt: MasterOpt;
  comp: CompressorSettings;
  ceilingDb: number;
  phrases: PhraseLevel[];
  trim: number;
  /** make-up gain after the compressor, dB (solved to the target unless `makeupAuto === false`) */
  makeupDb: number;
  /** false = the user set `makeupDb` by hand (slider «Компенсация»); missing = automatic */
  makeupAuto?: boolean;
  curve: CurvePt[];
  /** exact − model loudness from the last exact measurement (keeps the model calibrated) */
  bias: number;
  /** «Приглушение тишины» (missing = off). `curve` stays the leveler alone; the ducking is rebuilt from the
   *  silence regions on every set (thousands of points — not persisted). */
  duck?: DuckSettings;
  /** «Усиление звука» (⚙ «Звук») this processing follows; missing = projects from before the setting (≈ 'medium' aim) */
  mode?: import('../store').GainMode;
  /** the compressor was edited by hand — a mode change no longer replaces it */
  compManual?: boolean;
}
export interface MasterState extends MasterSaved {
  /** the gain curve actually applied: leveler `curve` + silence ducking */
  full: CurvePt[];
  /** how many quiet stretches the ducking lowers */
  duckRegions: number;
  /** model prediction for the current settings */
  modelLufs: number;
  /** largest modelled compression, dB */
  maxGrDb: number;
  /** every phrase sits at the gain cap: the target cannot be reached with this variant */
  capped: boolean;
  /** exact measurement of the current settings (null while the worker is still measuring) */
  lufs: number | null;
  tp: number | null;
  exactGrDb: number | null;
}

const fitLength = (a: Float32Array | null, n: number) => { const o = new Float32Array(n).fill(-100); if (a) o.set(a.subarray(0, n)); return o; };

type Analyzed = { an: BlockAnalysis; report: LoudnessReport };

export class LiveMaster {
  private worker: Worker | null = null;
  private pcm: Int16Array | null = null;
  private rms: Float32Array | null = null;
  private analysis: Promise<Analyzed> | null = null;
  private resolveAnalysis: ((a: Analyzed) => void) | null = null;
  private rejectAnalysis: ((e: Error) => void) | null = null;
  private ids = 0;
  private measureTimer = 0;
  an: BlockAnalysis | null = null;
  state: MasterState | null = null;
  /** quiet stretches for «Приглушение тишины» (set by the store: under the silence threshold) */
  duckSource: (() => { start: number; end: number }[]) | null = null;
  private duckPts: CurvePt[] = [];
  private duckRegions = 0;
  private duckKey = '';
  private duckSrc: { start: number; end: number }[] | null = null;
  /** Rebuild the ducking only when its settings or the regions changed (the regions are cached by the store). */
  private prepDuck(d: DuckSettings | undefined) {
    const regs = d && d.depthDb < -0.01 && this.duckSource ? this.duckSource() : [];
    const key = d ? `${d.depthDb}|${d.attackMs}|${d.releaseMs}` : '';
    if (key === this.duckKey && regs === this.duckSrc) return;
    this.duckKey = key; this.duckSrc = regs;
    this.duckPts = d ? duckPoints(regs, d) : [];
    this.duckRegions = this.duckPts.length / 4;
  }
  rev = 0;
  /** model of the processed level per 10 ms block (instant) */
  levels: Float32Array | null = null;
  /** exact processed level per block, valid where `covered[tile]` (for `rev`) */
  exact: Float32Array | null = null;
  covered: Uint8Array | null = null;
  private requested: Uint8Array | null = null;
  private samplesCache: { rev: number; a: number; b: number; data: Int16Array } | null = null;
  /** ms the last model update took (test hook / diagnostics) */
  lastModelMs = 0;
  analyzeFrac = 0;
  measureFrac = 0;
  measuring = false;
  private waveSubs = new Set<() => void>();
  onMeasured: ((rev: number, report: LoudnessReport, maxGrDb: number) => void) | null = null;
  onProgress: (() => void) | null = null;

  onWave(f: () => void) { this.waveSubs.add(f); return () => { this.waveSubs.delete(f); }; }
  private wave() { for (const f of this.waveSubs) f(); }

  get chain(): ChainSettings | null { const s = this.state; return s ? { ...s.comp, makeupDb: s.makeupDb ?? 0, ceilingDb: s.ceilingDb } : null; }

  private ensureWorker() {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./dsp.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => this.onMessage(ev.data);
    w.onerror = (e) => { e.preventDefault?.(); this.rejectAnalysis?.(new Error('Сбой фонового обработчика звука: ' + (e.message || ''))); };
    this.worker = w;
    return w;
  }

  /** Forget everything (project closed). The worker is terminated to free its copy of the PCM. */
  reset() {
    this.worker?.terminate(); this.worker = null;
    this.pcm = null; this.analysis = null; this.an = null; this.state = null;
    this.levels = this.exact = this.covered = this.requested = null; this.samplesCache = null;
    this.measuring = false; clearTimeout(this.measureTimer);
    this.rev++; this.wave();
  }

  /** One pass over the original PCM in the worker: loudness report + block analysis. Cached per PCM. */
  analyze(pcm: Int16Array, rmsDb: Float32Array): Promise<Analyzed> {
    if (this.pcm === pcm && this.analysis) return this.analysis;
    const w = this.ensureWorker();
    this.pcm = pcm; this.an = null; this.analyzeFrac = 0; this.rms = rmsDb;
    w.postMessage({ type: 'init', pcm });              // structured clone: the worker keeps its own copy
    this.analysis = new Promise<Analyzed>((res, rej) => { this.resolveAnalysis = res; this.rejectAnalysis = rej; });
    w.postMessage({ type: 'analyze', id: ++this.ids });
    return this.analysis;
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'progress':
        if (m.kind === 'analyze') this.analyzeFrac = m.frac; else this.measureFrac = m.frac;
        this.onProgress?.();
        break;
      case 'analyzed': {
        // the RMS grid is the app's `levels` (computeLevels, same 10 ms blocks)
        const nb = m.kwE.length;
        const rmsDb = this.rms && this.rms.length === nb ? this.rms : fitLength(this.rms, nb);
        this.an = { rmsDb, subPeakDb: m.peakDb, kwE: m.kwE };
        this.resolveAnalysis?.({ an: this.an, report: m.report });
        break;
      }
      case 'tile': {
        if (m.rev !== this.rev || !this.exact || !this.covered) break;
        this.exact.set(m.levels, m.tile * TILE_BLOCKS);
        this.covered[m.tile] = 1;
        this.wave();
        break;
      }
      case 'measured':
        if (m.rev !== this.rev) break;
        this.measuring = false; this.measureFrac = 1;
        this.onMeasured?.(m.rev, m.report, m.maxReductionDb);
        break;
      case 'error':
        console.warn('[carver] dsp worker:', m.kind, m.error);
        if (m.kind === 'analyze') this.rejectAnalysis?.(new Error(m.error));
        break;
    }
  }

  /** Apply settings. `recalibrate` re-solves the leveler trim with the block model (user changes);
   *  without it the stored curve is used as is (restoring a saved project reproduces the exact sound). */
  set(saved: MasterSaved, recalibrate: boolean) {
    const an = this.an; if (!an) throw new Error('analysis missing');
    const t0 = performance.now();
    const n = an.rmsDb.length;
    this.prepDuck(saved.duck ?? DEFAULT_DUCK);
    let full: CurvePt[], lvDb: Float32Array, grDb: Float32Array, limDb: Float32Array, modelLufs = NaN, maxGrDb = 0, capped = false;
    if (recalibrate) {
      const c = calibrate(an, saved.phrases, saved.opt, saved.comp, saved.ceilingDb, saved.bias, saved.trim, saved.makeupAuto === false ? saved.makeupDb : undefined, this.duckPts);
      saved = { ...saved, trim: c.trim, curve: c.pts, makeupDb: c.makeupDb };
      full = c.full;
      ({ lvDb, grDb, limDb, modelLufs, maxGrDb, capped } = c);
    } else {
      full = addCurves(saved.curve, this.duckPts);
      lvDb = curveBlocks(full, n);
      const post = new Float32Array(an.subPeakDb.length);
      grDb = compBlocks(an.subPeakDb, lvDb, saved.comp, undefined, post);
      limDb = limitBlocks(post, saved.makeupDb ?? 0, saved.ceilingDb, new Float32Array(n));
      for (let k = 0; k < n; k++) if (grDb[k] > maxGrDb) maxGrDb = grDb[k];
      modelLufs = modelLufsOf(an, lvDb, grDb, limDb, saved.makeupDb ?? 0);
    }
    this.levels = modelLevels(an.rmsDb, lvDb, grDb, limDb, saved.ceilingDb, saved.makeupDb ?? 0, this.levels?.length === n ? this.levels as Float32Array<ArrayBuffer> : undefined);
    this.state = { ...saved, full, duckRegions: this.duckRegions, modelLufs, maxGrDb, capped, lufs: null, tp: null, exactGrDb: null };
    this.lastModelMs = performance.now() - t0;
    this.bumpRev();
    this.scheduleMeasure();
  }

  /** Back to the original sound. */
  clear() {
    this.state = null; this.levels = null; clearTimeout(this.measureTimer); this.measuring = false;
    this.worker?.postMessage({ type: 'cancel', kind: 'measure' });
    this.worker?.postMessage({ type: 'cancel', kind: 'tiles' });
    this.bumpRev();
  }

  private bumpRev() {
    this.rev++;
    const nb = this.an?.rmsDb.length ?? 0, nt = Math.ceil(nb / TILE_BLOCKS);
    if (!this.exact || this.exact.length !== nb) this.exact = new Float32Array(nb);
    this.covered = new Uint8Array(nt); this.requested = new Uint8Array(nt);
    this.samplesCache = null;
    this.worker?.postMessage({ type: 'cancel', kind: 'tiles' });
    this.wave();
  }

  /** Exact loudness of the whole processed programme — after the user stops changing things. */
  private scheduleMeasure() {
    clearTimeout(this.measureTimer);
    this.measuring = true; this.measureFrac = 0;
    this.worker?.postMessage({ type: 'cancel', kind: 'measure' });
    const rev = this.rev;
    this.measureTimer = window.setTimeout(() => {
      const s = this.state; if (!s || rev !== this.rev) return;
      this.worker?.postMessage({ type: 'measure', id: ++this.ids, rev, pts: s.full, chain: this.chain });
    }, 400);
  }

  /** The waveform needs exact levels for blocks [b0, b1): ask the worker for the tiles not yet rendered. */
  requestVisible(b0: number, b1: number) {
    const s = this.state, req = this.requested; if (!s || !req || !this.worker) return;
    const t0 = Math.max(0, Math.floor(b0 / TILE_BLOCKS)), t1 = Math.min(req.length - 1, Math.floor(Math.max(b0, b1 - 1) / TILE_BLOCKS));
    let a = -1, b = -1;
    for (let t = t0; t <= t1; t++) if (!req[t]) { if (a < 0) a = t; b = t; }
    if (a < 0) return;
    // a newer request supersedes the running one: forget what it had not delivered yet
    for (let t = 0; t < req.length; t++) if (req[t] && !this.covered![t]) req[t] = 0;
    for (let t = a; t <= b; t++) req[t] = 1;
    this.worker.postMessage({ type: 'tiles', id: ++this.ids, rev: this.rev, pts: s.full, chain: this.chain, t0: a, t1: b });
  }

  /** Exact processed samples (Int16 scale) for [a, b) — the zoomed-in wave. Cached around the request. */
  samples(pcm: Int16Array, a: number, b: number): { data: Int16Array; off: number } {
    const c = this.samplesCache;
    if (c && c.rev === this.rev && a >= c.a && b <= c.b) return { data: c.data, off: c.a };
    const s = this.state!;
    const span = b - a, A = Math.max(0, a - span), B = Math.min(pcm.length, b + span);
    const f = renderRange(pcm, A, B, s.full, this.chain!);
    const data = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) data[i] = Math.round(Math.max(-1, Math.min(1, f[i])) * 32767);
    this.samplesCache = { rev: this.rev, a: A, b: B, data };
    return { data, off: A };
  }
}
