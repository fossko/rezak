// The composite output timeline: the main video's kept content interleaved with заставки. A title is
// anchored to a SOURCE time of the main video (where the playhead was) and plays its own media; it does
// not consume source time, but shifts everything after it in output time. Cuts (edl) remain source-based.
import type { Edl } from './edl';
import type { TitleAsset, TitleInsert } from './types';

export interface Clip {
  kind: 'main' | 'title';
  a: number; b: number;      // media time: source time for main, asset time for a title
  titleId?: string;          // asset id of a title clip
  anchor?: number;           // source time of the main video where a title was inserted
  out: number;               // output start
}
export interface Composite {
  clips: Clip[];
  duration: number;
  srcToOut: (src: number) => number;
  outToSrc: (out: number) => { clip: Clip; t: number };
}

export const clipDur = (c: Clip) => c.b - c.a;
export const clipEnd = (c: Clip) => c.out + c.b - c.a;

export function fullComposite(duration: number): Composite {
  const clips: Clip[] = [{ kind: 'main', a: 0, b: duration, out: 0 }];
  return { clips, duration, srcToOut: (t) => t, outToSrc: (o) => ({ clip: clips[0], t: o }) };
}

export function buildComposite(edl: Edl, titles: TitleInsert[] | undefined, assets: Map<string, TitleAsset>): Composite {
  const clips: Clip[] = [];
  const ttl = (titles || [])
    .map((t) => {
      const asset = assets.get(t.assetId);
      if (!asset) return null;
      let a = Math.max(0, t.a), b = Math.min(asset.duration, t.b);
      if (b - a < 0.02) { a = 0; b = asset.duration; }   // fully collapsed -> whole title
      return { ...t, a, b };
    })
    .filter((t): t is NonNullable<typeof t> => !!t)
    .sort((x, y) => x.anchor - y.anchor);

  let ti = 0;
  for (const seg of edl.segments) {
    while (ti < ttl.length && ttl[ti].anchor < seg.start) ti++;   // anchored in a removed gap -> skip
    let cursor = seg.start;
    while (ti < ttl.length && ttl[ti].anchor < seg.end) {
      const t = ttl[ti];
      if (t.anchor > cursor) clips.push({ kind: 'main', a: cursor, b: t.anchor, out: 0 });
      clips.push({ kind: 'title', a: t.a, b: t.b, titleId: t.assetId, anchor: t.anchor, out: 0 });
      cursor = t.anchor;   // the main video resumes from exactly where it paused
      ti++;
    }
    if (cursor < seg.end) clips.push({ kind: 'main', a: cursor, b: seg.end, out: 0 });
  }

  let acc = 0;
  for (const c of clips) { c.out = acc; acc += clipDur(c); }

  const mainClips = clips.filter((c) => c.kind === 'main');
  const srcToOut = (src: number): number => {
    let lo = 0, hi = mainClips.length - 1, k = mainClips.length;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (mainClips[m].a <= src) { k = m; lo = m + 1; } else hi = m - 1; }
    // inside kept clip k? else map to the start of the next kept clip (removed -> next kept)
    const c = mainClips[k];
    if (c && src >= c.a && src < c.b) return c.out + (src - c.a);
    const n = mainClips[k + 1];
    return n ? n.out : acc;
  };
  const outToSrc = (out: number) => {
    let lo = 0, hi = clips.length - 1, k = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (clips[m].out <= out) { k = m; lo = m + 1; } else hi = m - 1; }
    const c = clips[k];
    return { clip: c, t: Math.min(c.b, c.a + Math.max(0, out - c.out)) };
  };

  return { clips, duration: acc, srcToOut, outToSrc };
}
