// «Реставрация» (Sidon speech restoration) on the main thread: model lifecycle, the tile cache of the
// restored ("wet") signal and the scheduling of renders. Nothing is rendered for the whole recording
// except during export; otherwise only tiles around the playhead (ahead of playback) are made.
//
// Tiles: tile k covers SOURCE seconds [kH − XH, (k+1)H + XH] (H = 10 s, XH = 0.1 s), rendered with 1 s of
// context on both sides; neighbours are joined with a 0.2 s raised-cosine crossfade centred on kH. The
// wet signal is length-locked to the source (each 20 ms feature frame = exactly 960 samples at 48 kHz),
// so dry and wet can be mixed sample by sample. Each tile is loudness-matched to the dry signal
// (K-weighted, gated), so the loudness processing after it (leveler, ducking, compressor) still fits.
import { RPC } from '../lib/rpc';

export const TILE_S = 10, XH_S = 0.1, CTX_S = 1;
const AHEAD_S = 60, MAX_TILES = 60, EXPORT_AHEAD = 8;

/** Dry/wet gains for amount a (0..1). The restored signal is phase-INCOHERENT with the original above ~200 Hz
 *  (the vocoder makes its own phase; measured coherence ≈ 0.01), so their powers add: a linear 60/40 mix was
 *  2.6 dB quieter than either alone. Constant power with the wet:dry amplitude ratio a/(1−a) keeps the level. */
export function restoreGains(a: number): [dry: number, wet: number] {
  if (a <= 0) return [1, 0];
  if (a >= 1) return [0, 1];
  const n = Math.hypot(1 - a, a);
  return [(1 - a) / n, a / n];
}

export type RestoreStatus = 'off' | 'waiting' | 'download' | 'init' | 'ready' | 'error';
type Tile = { wet: Float32Array; gainDb: number; used: number };

export class Restorer {
  /** dry/wet, 0..1 (0 = off: no model is loaded) */
  amount = 0;
  status: RestoreStatus = 'off';
  error = '';
  dl = { done: 0, total: 0 };
  ep = '';
  /** test/diagnostics: tiles rendered, render time per tile */
  stats = { rendered: 0, ms: 0, lastMs: 0 };
  private rpc: RPC | null = null;
  private loading: Promise<void> | null = null;
  private pcm: Int16Array | null = null;
  private sr = 48000;
  private dur = 0;
  private tiles = new Map<number, Tile>();
  private busy = false;
  private waiters = new Map<number, (() => void)[]>();
  private failed = new Map<number, string>();
  private clock = 0;
  private gains: number[] = [];
  /** export in progress: the ordered tile plan and the consumer's position in it */
  private exp: { plan: number[]; pos: number } | null = null;
  /** set by the store */
  onChange: () => void = () => {};
  onTile: (k: number) => void = () => {};
  canRun: () => boolean = () => true;
  /** tiles to have ready for preview, in priority order (from the playhead along the kept timeline) */
  plan: () => number[] = () => [];

  get K() { return Math.max(1, Math.ceil(this.dur / TILE_S)); }
  get ready() { return this.status === 'ready'; }
  get cached() { return this.tiles.size; }
  has(k: number) { return this.tiles.has(k); }

  /** New recording (or none). Rendered tiles belong to the PCM, so they are dropped. */
  setSource(pcm: Int16Array | null, sr: number) {
    if (pcm === this.pcm && sr === this.sr) return;
    this.pcm = pcm; this.sr = sr; this.dur = pcm ? pcm.length / 16000 : 0;
    this.tiles.clear(); this.failed.clear(); this.gains = [];
    this.kick();
  }

  setAmount(a: number) {
    const v = Math.max(0, Math.min(1, a));
    if (v === this.amount) return;
    this.amount = v;
    if (v === 0) this.unload();
    this.kick();
    this.onChange();
  }

  /** Free the model (GPU memory) — the rendered tiles stay valid. */
  private unload() {
    this.rpc?.terminate(); this.rpc = null; this.loading = null; this.busy = false;
    this.status = 'off'; this.error = '';
    for (const ws of this.waiters.values()) ws.forEach((w) => w());
    this.waiters.clear();
  }

  retry() { if (this.status === 'error') { this.status = 'off'; this.error = ''; this.failed.clear(); this.unload(); this.kick(); this.onChange(); } }

  /** The model downloads/loads when restoration is on and nothing else is running (or for an export). */
  private wantModel() { return this.amount > 0 && !!this.pcm && (this.canRun() || !!this.exp); }

  /** Re-evaluate: load the model or render the next tile if allowed. Cheap; call on any state change. */
  kick() {
    if (this.amount <= 0 || !this.pcm) { if (this.status === 'waiting') { this.status = 'off'; this.onChange(); } return; }
    if (this.status === 'error') return;
    if (!this.rpc && !this.loading) {
      if (!this.wantModel()) { if (this.status !== 'waiting') { this.status = 'waiting'; this.onChange(); } return; }
      this.load();
      return;
    }
    if (this.status === 'ready') void this.pump();
  }

  private load() {
    this.status = 'download'; this.dl = { done: 0, total: 0 }; this.onChange();
    const w = new Worker(new URL('./restore.worker.ts', import.meta.url), { type: 'module' });
    const rpc = new RPC(w, (m) => {
      if (m?.type === 'progress' && this.rpc === rpc) {
        this.status = m.phase === 'init' ? 'init' : 'download';
        this.dl = { done: m.done, total: m.total };
        this.onChange();
      }
    });
    this.rpc = rpc;
    this.loading = rpc.call<{ ep: string }>('load', { ep: (globalThis as any).__carverRestoreEp }).then((r) => {
      if (this.rpc !== rpc) return;
      this.ep = r.ep; this.status = 'ready'; this.loading = null;
      console.log(`[carver] Sidon loaded (${r.ep})`);
      this.onChange(); void this.pump();
    }, (e) => {
      if (this.rpc !== rpc) return;
      this.fail(e?.message || String(e));
    });
  }

  private fail(msg: string) {
    this.rpc?.terminate(); this.rpc = null; this.loading = null; this.busy = false;
    this.status = 'error'; this.error = msg;
    for (const ws of this.waiters.values()) ws.forEach((w) => w());
    this.waiters.clear();
    this.onChange();
  }

  /** Next tile to render: the export plan first, then (when idle) the preview plan. */
  private next(): number | null {
    if (this.exp) {
      const { plan, pos } = this.exp;
      for (let i = pos; i < Math.min(plan.length, pos + EXPORT_AHEAD); i++) if (!this.tiles.has(plan[i]) && !this.failed.has(plan[i])) return plan[i];
      return null;
    }
    if (!this.canRun()) return null;
    for (const k of this.plan()) if (k >= 0 && k < this.K && !this.tiles.has(k) && !this.failed.has(k)) return k;
    return null;
  }

  private async pump() {
    if (this.busy || !this.rpc || this.status !== 'ready' || !this.pcm) return;
    const k = this.next();
    if (k == null) return;
    this.busy = true;
    const rpc = this.rpc, pcm = this.pcm, sr = this.sr;
    try {
      const a = Math.max(0, k * TILE_S - XH_S), b = Math.min(this.dur, (k + 1) * TILE_S + XH_S);
      const w0 = Math.max(0, Math.round((a - CTX_S) * 16000)), w1 = Math.min(pcm.length, Math.round((b + CTX_S) * 16000));
      const c0 = Math.round(a * 16000) - w0, c1 = Math.min(w1, Math.round(b * 16000)) - w0;
      const x = new Float32Array(w1 - w0);
      for (let i = 0; i < x.length; i++) x[i] = pcm[w0 + i] / 32768;
      const r = await rpc.call<{ wet: Float32Array; gainDb: number; ms: number }>('tile', { x, c0, c1, sr }, [x.buffer]);
      if (rpc !== this.rpc || pcm !== this.pcm) return;
      this.tiles.set(k, { wet: r.wet, gainDb: r.gainDb, used: ++this.clock });
      if (Number.isFinite(r.gainDb)) this.gains.push(r.gainDb);
      this.stats.rendered++; this.stats.ms += r.ms; this.stats.lastMs = r.ms;
      this.evict();
      const ws = this.waiters.get(k); this.waiters.delete(k); ws?.forEach((w) => w());
      this.onTile(k);
      this.onChange();
    } catch (e: any) {
      if (rpc !== this.rpc) return;
      if (e?.name === 'AbortError') return;
      // a broken worker (GPU lost, out of memory) fails everything; a single bad tile only itself
      if (/Сбой фонового обработчика|device|memory/i.test(e?.message || '')) { this.fail(e.message); return; }
      this.failed.set(k, e?.message || String(e));
      console.warn('[carver] Sidon tile', k, 'failed', e);
      const ws = this.waiters.get(k); this.waiters.delete(k); ws?.forEach((w) => w());
    } finally {
      if (rpc === this.rpc) { this.busy = false; void this.pump(); }
    }
  }

  private evict() {
    if (this.tiles.size <= MAX_TILES) return;
    const keep = new Set(this.exp ? this.exp.plan.slice(this.exp.pos, this.exp.pos + EXPORT_AHEAD) : this.plan().slice(0, MAX_TILES / 2));
    const list = [...this.tiles.entries()].filter(([k]) => !keep.has(k)).sort((x, y) => x[1].used - y[1].used);
    for (const [k] of list) { if (this.tiles.size <= MAX_TILES) break; this.tiles.delete(k); }
  }

  /** Gain of a tile: its own match, kept within ±3 dB of the recording's median (silent tiles use the median). */
  private gainOf(t: Tile) {
    const g = this.gains;
    const med = g.length ? [...g].sort((a, b) => a - b)[g.length >> 1] : 0;
    const db = Number.isFinite(t.gainDb) ? Math.max(med - 3, Math.min(med + 3, t.gainDb)) : med;
    return Math.pow(10, db / 20);
  }

  private tileSpan(k: number) {
    const H = TILE_S * this.sr, X = Math.round(XH_S * this.sr);
    return { s0: Math.max(0, k * H - X), H, X };
  }

  /** Tiles needed for source samples [s0, s0 + n) at the source rate. */
  tilesFor(s0: number, n: number): number[] {
    const H = TILE_S * this.sr, X = Math.round(XH_S * this.sr);
    const kA = Math.max(0, Math.floor((s0 - X) / H)), kB = Math.min(this.K - 1, Math.floor((s0 + n - 1 + X) / H));
    const out: number[] = [];
    for (let k = kA; k <= kB; k++) out.push(k);
    return out;
  }

  /** Restored samples for [s0, s0 + n) (source rate, mono, loudness-matched), or null if not rendered yet. */
  wet(s0: number, n: number): Float32Array | null {
    if (!this.pcm || n <= 0) return null;
    const ks = this.tilesFor(s0, n);
    for (const k of ks) if (!this.tiles.has(k)) return null;
    const out = new Float32Array(n), K = this.K;
    for (const k of ks) {
      const t = this.tiles.get(k)!; t.used = ++this.clock;
      const { s0: ts, H, X } = this.tileSpan(k), g = this.gainOf(t);
      const lo = Math.max(s0, ts), hi = Math.min(s0 + n, ts + t.wet.length);
      const inA = k * H - X, inB = k * H + X, outA = (k + 1) * H - X;
      for (let s = lo; s < hi; s++) {
        let w = g;
        if (k > 0 && s < inB) w *= 0.5 - 0.5 * Math.cos(Math.PI * (s - inA + 0.5) / (2 * X));
        else if (k < K - 1 && s >= outA) w *= 0.5 + 0.5 * Math.cos(Math.PI * (s - outA + 0.5) / (2 * X));
        out[s - s0] += t.wet[s - ts] * w;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- export
  /** Start an export: `plan` = every tile the kept timeline touches, in output order. */
  beginExport(plan: number[]) { this.exp = { plan, pos: 0 }; this.failed.clear(); this.kick(); }
  endExport() { this.exp = null; this.kick(); }

  /** Export path: wait until the tiles for [s0, s0+n) exist, then return the wet signal. */
  async wetAsync(s0: number, n: number, signal?: AbortSignal): Promise<Float32Array> {
    for (;;) {
      await this.ensure(s0, n, signal);
      const w = this.wet(s0, n);
      if (w) return w;   // (a tile evicted meanwhile ⇒ render it again)
    }
  }
  private async ensure(s0: number, n: number, signal?: AbortSignal) {
    const ks = this.tilesFor(s0, n);
    if (this.exp) {
      const i = this.exp.plan.indexOf(ks[0], Math.max(0, this.exp.pos - 2));
      if (i >= 0) this.exp.pos = i;
    }
    for (const k of ks) {
      while (!this.tiles.has(k)) {
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        if (this.status === 'error') throw new Error('Реставрация: ' + this.error);
        if (this.failed.has(k)) throw new Error('Реставрация: ' + this.failed.get(k));
        if (this.amount <= 0) throw new Error('Реставрация выключена во время экспорта');
        if (this.exp && !this.exp.plan.includes(k)) this.exp.plan.splice(this.exp.pos, 0, k);
        this.kick();
        await new Promise<void>((res) => {
          const arr = this.waiters.get(k) || []; arr.push(res); this.waiters.set(k, arr);
          const onAbort = () => res(); signal?.addEventListener('abort', onAbort, { once: true });
          setTimeout(res, 1000);   // re-check status periodically
        });
      }
    }
  }
}
