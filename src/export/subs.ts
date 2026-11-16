// Text outputs of the carved result, all on the OUTPUT timeline: SRT, JSON, timecoded and plain text.
import type { Word } from '../lib/types';
import { type Edl, srcToOut, segAt } from '../lib/edl';
import { ts } from '../lib/util';
import { maskWord } from '../lib/profanity';

export interface OutWord { text: string; start: number; end: number; i: number; para: boolean }

/** Kept Whisper words (no "extra" sounds) with output times. */
/** `mask`: per-word flags; masked words are written as «х****» (muted мат in subtitles). */
export function outWords(words: Word[], state: ArrayLike<number>, edl: Edl, mask?: ArrayLike<number>, toOut?: (t: number) => number): OutWord[] {
  const s2o = toOut || ((t: number) => srcToOut(edl, t));
  const out: OutWord[] = [];
  let para = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.para) para = true;
    if (state[i] || w.kind) continue;
    const mid = (w.start + w.end) / 2;
    if (segAt(edl, mid) < 0 && segAt(edl, w.start) < 0 && segAt(edl, w.end - 0.001) < 0) continue;   // fully inside a removed range
    const s = s2o(w.start), e = Math.max(s + 0.02, s2o(w.end));
    out.push({ text: mask && mask[i] ? maskWord(w.text) : w.text, start: s, end: e, i, para });
    para = false;
  }
  return out;
}

const SRT_LINE = 42, SRT_CUE = 84, SRT_MAXDUR = 6.5;
function wrapLines(text: string) {
  if (text.length <= SRT_LINE) return text;
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < text.length; i++) if (text[i] === ' ') { const d = Math.abs(i - text.length / 2); if (d < bestDist) { bestDist = d; best = i; } }
  return best < 0 ? text : text.slice(0, best) + '\n' + text.slice(best + 1);
}
export function makeCues(ws: OutWord[]) {
  const cues: { start: number; end: number; text: string }[] = [];
  let cur: OutWord[] = [];
  const push = () => { if (cur.length) cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') }); cur = []; };
  for (const w of ws) {
    if (cur.length) {
      const text = cur.map((x) => x.text).join(' ');
      const prev = cur[cur.length - 1];
      const sentEnd = /[.!?…]["»”')]*$/.test(prev.text), comma = /[,;:—]$/.test(prev.text);
      if (text.length + 1 + w.text.length > SRT_CUE || w.end - cur[0].start > SRT_MAXDUR || w.start - prev.end > 1.0 || w.para
        || (sentEnd && text.length > 25) || (comma && text.length > 55)) push();
    }
    cur.push(w);
  }
  push();
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i], n = cues[i + 1];
    if (c.end < c.start + 0.7) c.end = c.start + 0.7;
    if (n && c.end > n.start) c.end = Math.max(n.start - 0.001, c.start + 0.01);
    else if (n && n.start - c.end < 0.25) c.end = n.start - 0.001;   // close tiny gaps (less flicker)
  }
  return cues;
}
export function makeSRT(ws: OutWord[]) {
  return makeCues(ws).map((c, i) => `${i + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${wrapLines(c.text)}\n`).join('\n');
}

export function paragraphs(ws: OutWord[]) {
  const ps: { start: number; end: number; text: string }[] = [];
  for (const w of ws) {
    const p = ps[ps.length - 1];
    if (!p || w.para) ps.push({ start: w.start, end: w.end, text: w.text });
    else { p.text += ' ' + w.text; p.end = w.end; }
  }
  return ps;
}
/** "[HH:MM:SS] paragraph" lines — input for chapters/timecodes steps. */
export function makeTimedText(ws: OutWord[]) {
  return paragraphs(ws).map((p) => `[${ts(p.start).slice(0, 8)}] ${p.text}`).join('\n\n') + '\n';
}
export function makePlainText(ws: OutWord[]) {
  return paragraphs(ws).map((p) => p.text).join('\n\n') + '\n';
}

export function makeJSON(meta: { source: string; duration: number }, words: Word[], state: ArrayLike<number>, edl: Edl, mask?: ArrayLike<number>, mutes?: [number, number][], toOut?: (t: number) => number, outDuration?: number) {
  const ws = outWords(words, state, edl, mask, toOut);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return JSON.stringify({
    app: 'carver', version: 1, source: meta.source, sourceDuration: r3(meta.duration), duration: r3(outDuration ?? edl.outDuration),
    created: new Date().toISOString(),
    segments: edl.segments.map((s, k) => ({ sourceStart: r3(s.start), sourceEnd: r3(s.end), start: r3(edl.outStarts[k]) })),
    paragraphs: paragraphs(ws).map((p) => ({ start: r3(p.start), end: r3(p.end), text: p.text })),
    words: ws.map((w) => ({ text: w.text, start: r3(w.start), end: r3(w.end), sourceStart: r3(words[w.i].start), sourceEnd: r3(words[w.i].end), ...(mask && mask[w.i] ? { muted: true } : {}) })),
    muted: (mutes || []).map(([a, b]) => ({ sourceStart: r3(a), sourceEnd: r3(b) })),
  }, null, 1) + '\n';
}
