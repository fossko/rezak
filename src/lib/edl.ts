// Edit decision list: removed words + long silences + manual ranges -> kept segments of the source.
import type { CutSettings, SilenceSettings, Segment, Word } from './types';
import { LV_HOP } from './pcm';

export interface Silence { start: number; end: number }   // a detected quiet stretch (full extent)

/** Quiet stretches at least `minDuration` long. Blips shorter than 60 ms inside silence are ignored. */
export function detectSilences(levels: Float32Array, s: Pick<SilenceSettings, 'thresholdDb' | 'minDuration'>): Silence[] {
  const n = levels.length, BLIP = Math.round(0.06 / LV_HOP);
  const runs: [number, number][] = [];
  let a = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && levels[i] < s.thresholdDb;
    if (quiet) { if (a < 0) a = i; }
    else if (a >= 0) { runs.push([a, i]); a = -1; }
  }
  const merged: [number, number][] = [];
  for (const r of runs) {
    const p = merged[merged.length - 1];
    if (p && r[0] - p[1] <= BLIP) p[1] = r[1]; else merged.push([r[0], r[1]]);
  }
  const out: Silence[] = [];
  for (const [x, y] of merged) {
    const st = x * LV_HOP, en = y * LV_HOP;
    if (en - st >= s.minDuration) out.push({ start: st, end: en });
  }
  return out;
}

export const silenceKey = (s: Silence) => Math.round(s.start * 1000);

type Range = [number, number];

function union(ranges: Range[]): Range[] {
  const rs = ranges.filter((r) => r[1] > r[0]).sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of rs) {
    const p = out[out.length - 1];
    if (p && r[0] <= p[1]) p[1] = Math.max(p[1], r[1]); else out.push([r[0], r[1]]);
  }
  return out;
}
/** a minus b (both sorted, disjoint) */
function subtract(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  let j = 0;
  for (const [s0, e0] of a) {
    let s = s0;
    while (j < b.length && b[j][1] <= s) j++;
    let k = j;
    while (k < b.length && b[k][0] < e0) {
      if (b[k][0] > s) out.push([s, b[k][0]]);
      s = Math.max(s, b[k][1]);
      k++;
    }
    if (s < e0) out.push([s, e0]);
  }
  return out;
}

/** Time ranges removed because of removed words. A run of removed words takes the gap that
 *  follows it, so the pause before the run becomes the pause before the next kept word. */
export function wordCuts(words: Word[], state: ArrayLike<number>, margin: number): Range[] {
  return wordRuns(words, state, margin).map((r) => [r.a, r.b] as Range);
}

/** Custom cut edges (absolute source seconds), keyed by the transcript element that forms the edge:
 *  `rs:<i>` / `re:<j>` — start / end of the cut made by the removed word run i..j (words or fillers);
 *  `gs:<g>:<k>` / `ge:<g>:<k>` — start / end of the k-th pause cut in the gap after word g (g = -1:
 *  before the first word). Overrides are kept while their cut is off and apply again when it's back on;
 *  automatic settings (threshold, padding, margins) never move them. */
export type EdgeOverrides = Record<string, number>;

/** One red region of the final edit, with the owners of its two edges. */
export interface CutRegion {
  a: number; b: number;            // final edges (after overrides)
  autoA: number; autoB: number;    // automatic edges (what a reset returns to)
  sk?: string; ek?: string;        // owner keys of the start / end edge
  custom: boolean;                 // at least one edge is overridden
}

export interface EdlInput {
  duration: number;
  words: Word[];
  wordState: ArrayLike<number>;
  silences: Silence[];             // detected (full extent)
  silence: SilenceSettings;
  keptSilences: Set<number>;
  rangeCuts: Range[];
  cut: CutSettings;
  edges?: EdgeOverrides;
}

export interface Edl {
  segments: Segment[];             // kept, sorted
  outStarts: number[];             // output time at which each segment starts
  outDuration: number;
  removed: Range[];                // complement (for display)
  regions: CutRegion[];            // = removed, with edge owners (editable in the waveform)
  silenceCuts: Range[];            // the part of each silence that is cut (after padding & word protection)
}

export function buildEdl(x: EdlInput): Edl {
  const D = x.duration;
  // silence cuts (with padding), protecting kept words
  let sil: Range[] = [];
  if (x.silence.enabled) {
    for (const s of x.silences) {
      if (x.keptSilences.has(silenceKey(s))) continue;
      const a = s.start === 0 ? 0 : s.start + x.silence.padBefore;
      const b = s.end >= D - 0.011 ? D : s.end - x.silence.padAfter;
      if (b - a > 0.05) sil.push([a, b]);
    }
    const protect: Range[] = [];
    for (let i = 0; i < x.words.length; i++) {
      if (x.wordState[i]) continue;
      const w = x.words[i];
      protect.push([w.start - 0.02, w.end + 0.02]);
    }
    sil = subtract(union(sil), union(protect)).filter((r) => r[1] - r[0] > 0.05);
  }
  // ---- pieces with owners
  const pieces: Piece[] = [];
  for (const r of wordRuns(x.words, x.wordState, x.cut.wordMargin)) pieces.push({ a: r.a, b: r.b, sk: `rs:${r.i}`, ek: `re:${r.j}` });
  // pause cuts (detected silences + pause chips cut by hand), grouped per gap between words
  const gapPieces = union([...sil, ...x.rangeCuts.map((r) => [r[0], r[1]] as Range)]);
  const ordinal = new Map<number, number>();
  for (const [a, b] of gapPieces) {
    const g = gapIndex(x.words, (a + b) / 2), k = ordinal.get(g) || 0;
    ordinal.set(g, k + 1);
    pieces.push({ a, b, sk: `gs:${g}:${k}`, ek: `ge:${g}:${k}` });
  }
  // ---- merge into groups; each group's outer edges are owned by the pieces that form them
  pieces.sort((p, q) => p.a - q.a);
  let groups: Group[] = [];
  for (const pc of pieces) {
    const gr = groups[groups.length - 1];
    if (gr && pc.a <= gr.b) { if (pc.b > gr.b) { gr.b = pc.b; gr.ek = pc.ek; } }
    else groups.push({ a: pc.a, b: pc.b, sk: pc.sk, ek: pc.ek, autoA: 0, autoB: 0 });
  }
  const ov = x.edges || {};
  for (const gr of groups) {
    gr.autoA = gr.a; gr.autoB = gr.b;
    if (ov[gr.sk] != null) gr.a = ov[gr.sk];
    if (ov[gr.ek] != null) gr.b = ov[gr.ek];
    gr.a = Math.max(0, Math.min(gr.a, D)); gr.b = Math.max(0, Math.min(gr.b, D));
    if (gr.b < gr.a + 0.005) gr.b = Math.min(D, gr.a + 0.005);   // never inverted
  }
  // overrides may make groups overlap (e.g. settings changed afterwards): merge, keeping outer owners
  groups.sort((p, q) => p.a - q.a);
  const merged: Group[] = [];
  for (const gr of groups) {
    const m = merged[merged.length - 1];
    if (m && gr.a <= m.b) { if (gr.b > m.b) { m.b = gr.b; m.ek = gr.ek; m.autoB = gr.autoB; } }
    else merged.push({ ...gr });
  }
  groups = merged;
  // ---- kept = complement, drop slivers
  const removed0: Range[] = groups.map((gr) => [gr.a, gr.b]);
  let keep: Range[] = subtract([[0, D]], removed0).filter((r) => r[1] - r[0] >= x.cut.minKeep);
  if (!keep.length && D > 0) keep = [];
  const segments = keep.map(([start, end]) => ({ start, end }));
  const outStarts: number[] = [];
  let acc = 0;
  for (const s of segments) { outStarts.push(acc); acc += s.end - s.start; }
  const removed = subtract([[0, D]], keep);
  // final regions (a dropped sliver joins neighbouring groups): owners = first / last group inside
  let gi = 0;
  const regions: CutRegion[] = removed.map(([a, b]) => {
    while (gi < groups.length && groups[gi].b <= a) gi++;
    let first: Group | undefined, last: Group | undefined;
    for (let k = gi; k < groups.length && groups[k].a < b; k++) { first ||= groups[k]; last = groups[k]; }
    const sk = first?.sk, ek = last?.ek;
    return { a, b, autoA: first && Math.abs(first.a - a) < 1e-6 ? first.autoA : a, autoB: last && Math.abs(last.b - b) < 1e-6 ? last.autoB : b,
      sk, ek, custom: (sk != null && ov[sk] != null) || (ek != null && ov[ek] != null) };
  });
  return { segments, outStarts, outDuration: acc, removed, regions, silenceCuts: sil };
}

interface Piece { a: number; b: number; sk: string; ek: string }
interface Group extends Piece { autoA: number; autoB: number }

/** Removed word runs with their first/last word index (same geometry as wordCuts). */
function wordRuns(words: Word[], state: ArrayLike<number>, margin: number) {
  const out: { a: number; b: number; i: number; j: number }[] = [];
  let i = 0;
  while (i < words.length) {
    if (!state[i]) { i++; continue; }
    let j = i;
    while (j + 1 < words.length && state[j + 1]) j++;
    const prev = i > 0 ? words[i - 1] : null, next = j + 1 < words.length ? words[j + 1] : null;
    let a = words[i].start - margin;
    if (prev) a = Math.max(a, Math.min(prev.end + 0.01, words[i].start));
    let b = next ? next.start - margin : words[j].end + margin;
    if (next) b = Math.max(b, Math.min(words[j].end + margin, next.start));
    a = Math.max(0, a);
    if (b > a) out.push({ a, b, i, j });
    i = j + 1;
  }
  return out;
}
/** Index of the word after which time t lies (-1 = before the first word). */
function gapIndex(words: Word[], t: number) {
  let lo = 0, hi = words.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].start <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

/** Re-key overrides after words were inserted/removed: `map(oldIndex)` → new index (or -2 to drop). */
export function remapEdges(edges: EdgeOverrides, map: (i: number) => number): EdgeOverrides {
  const out: EdgeOverrides = {};
  for (const [k, v] of Object.entries(edges)) {
    const m = /^(rs|re|gs|ge):(-?\d+)(:\d+)?$/.exec(k); if (!m) continue;
    const i = +m[2], n = i < 0 ? i : map(i);
    if (n < -1) continue;
    out[`${m[1]}:${n}${m[3] || ''}`] = v;
  }
  return out;
}

/** Segment index containing source time t, or -1. */
export function segAt(edl: Edl, t: number): number {
  const s = edl.segments;
  let lo = 0, hi = s.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (t < s[m].start) hi = m - 1; else if (t >= s[m].end) lo = m + 1; else return m;
  }
  return -1;
}
/** Source -> output time. Times inside removed parts map to the start of the next kept segment. */
export function srcToOut(edl: Edl, t: number): number {
  const s = edl.segments;
  let lo = 0, hi = s.length - 1, k = s.length;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].end > t) { k = m; hi = m - 1; } else lo = m + 1; }
  if (k >= s.length) return edl.outDuration;
  return edl.outStarts[k] + Math.max(0, t - s[k].start);
}
/** Output -> source time. */
export function outToSrc(edl: Edl, o: number): number {
  const s = edl.segments;
  if (!s.length) return 0;
  let lo = 0, hi = s.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (edl.outStarts[m] <= o) { k = m; lo = m + 1; } else hi = m - 1; }
  return Math.min(s[k].end, s[k].start + Math.max(0, o - edl.outStarts[k]));
}
/** Fraction of [a,b] that is removed. */
export function removedFraction(edl: Edl, a: number, b: number): number {
  if (b <= a) return 0;
  let rem = 0;
  for (const [x, y] of edl.removed) { if (y <= a) continue; if (x >= b) break; rem += Math.min(b, y) - Math.max(a, x); }
  return rem / (b - a);
}
