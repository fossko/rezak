// DSP worker: everything that has to walk the WHOLE recording runs here, off the UI thread, and never
// blocks an interaction:
//   analyze  — one pass over the original PCM: loudness report + per-10 ms block analysis (dsp.ts)
//   tiles    — EXACT processed levels for the visible part of the waveform, tile by tile (60 s each),
//              posted as they are ready so the wave "renders in" like in Final Cut
//   measure  — exact loudness of the processed programme for the meter (seconds; runs last)
// Jobs are prioritised (tiles > analyze > measure), resumable, and a newer request of the same kind
// supersedes the older one, so dragging a slider never queues stale work.
import { LoudnessMeter } from '../lib/loudness';
import { ExactStream, rmsBlocks, BLK, SUB, TILE_BLOCKS, type CurvePt } from '../lib/dsp';
import type { ChainSettings } from '../lib/masterchain';

const PREROLL = 16000;                      // 1 s: lets the compressor envelope settle before a tile range

interface Job { kind: 'analyze' | 'tiles' | 'measure'; id: number; step: () => boolean }

let pcm: Int16Array | null = null;
const jobs: { tiles: Job | null; analyze: Job | null; measure: Job | null } = { tiles: null, analyze: null, measure: null };
const post = (m: any, tr: Transferable[] = []) => (self as any).postMessage(m, tr);

function analyzeJob(id: number): Job {
  const p = pcm!, m = new LoudnessMeter(16000, p.length, SUB), STEP = 1 << 20;
  let pos = 0;
  return {
    kind: 'analyze', id, step: () => {
      const b = Math.min(p.length, pos + STEP);
      m.push(p, pos, b); pos = b;
      post({ type: 'progress', id, kind: 'analyze', frac: pos / p.length });
      if (pos < p.length) return false;
      const report = m.finish();
      const peakDb = m.subPeak!;
      for (let k = 0; k < peakDb.length; k++) peakDb[k] = 20 * Math.log10(peakDb[k] + 1e-9);
      const kwE = m.blockE!;
      post({ type: 'analyzed', id, report, peakDb, kwE }, [peakDb.buffer, kwE.buffer]);
      return true;
    },
  };
}

function tilesJob(id: number, rev: number, pts: CurvePt[], chain: ChainSettings, t0: number, t1: number): Job {
  const p = pcm!, nb = Math.ceil(p.length / BLK);
  const start = t0 * TILE_BLOCKS * BLK;
  const st = new ExactStream(p, pts, chain, start - PREROLL);
  const buf = new Float32Array(TILE_BLOCKS * BLK);
  let tile = t0, warmed = false;
  return {
    kind: 'tiles', id, step: () => {
      if (!warmed) { warmed = true; const pre = start - st.pos; if (pre > 0) st.next(new Float32Array(pre), pre); }
      const b0 = tile * TILE_BLOCKS, b1 = Math.min(nb, b0 + TILE_BLOCKS);
      const n = st.next(buf, (b1 - b0) * BLK);
      const lv = new Float32Array(b1 - b0);
      const full = rmsBlocks(buf.subarray(0, n), lv);
      if (full < lv.length && n > full * BLK) {          // last partial block of the file
        let acc = 0; for (let i = full * BLK; i < n; i++) acc += buf[i] * buf[i];
        lv[full] = 10 * Math.log10(acc / (n - full * BLK) + 1e-10);
      }
      post({ type: 'tile', id, rev, tile, levels: lv }, [lv.buffer]);
      tile++;
      return tile > t1 || b1 >= nb;
    },
  };
}

function measureJob(id: number, rev: number, pts: CurvePt[], chain: ChainSettings): Job {
  const p = pcm!, st = new ExactStream(p, pts, chain, 0), m = new LoudnessMeter(16000);
  const buf = new Float32Array(1 << 19);
  return {
    kind: 'measure', id, step: () => {
      const n = st.next(buf, buf.length);
      if (n > 0) m.push(buf, 0, n);
      if (st.pos < p.length && n > 0) { post({ type: 'progress', id, kind: 'measure', frac: st.pos / p.length }); return false; }
      post({ type: 'measured', id, rev, report: m.finish(), maxReductionDb: st.maxReductionDb });
      return true;
    },
  };
}

// zero-delay yield (setTimeout is clamped to 4 ms after a few nested calls)
const ch = new MessageChannel();
let wake: (() => void) | null = null;
ch.port1.onmessage = () => { const w = wake; wake = null; w?.(); };
const yieldNow = () => new Promise<void>((r) => { wake = r; ch.port2.postMessage(0); });

let running = false;
async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = jobs.tiles || jobs.analyze || jobs.measure;
      if (!job) break;
      let done = false;
      try { done = job.step(); } catch (e: any) { post({ type: 'error', id: job.id, kind: job.kind, error: String(e?.message || e) }); done = true; }
      if (done && jobs[job.kind] === job) jobs[job.kind] = null;
      await yieldNow();
    }
  } finally { running = false; }
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': pcm = m.pcm; jobs.tiles = jobs.analyze = jobs.measure = null; break;
    case 'analyze': if (pcm) jobs.analyze = analyzeJob(m.id); break;
    case 'tiles': if (pcm) jobs.tiles = tilesJob(m.id, m.rev, m.pts, m.chain, m.t0, m.t1); break;
    case 'measure': if (pcm) jobs.measure = measureJob(m.id, m.rev, m.pts, m.chain); break;
    case 'cancel': if (m.kind) jobs[m.kind as keyof typeof jobs] = null; break;
  }
  void pump();
};
