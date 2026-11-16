// Slow phrase leveler: raises or lowers each phrase of speech towards a target LUFS, and changes the
// gain ONLY inside the pauses between phrases. No compression, no timbre change — this is clip gain,
// done automatically, which is why it sounds transparent where a compressor would pump.
//
// The phrase measurement, the breakpoints and the calibration against the master chain live in
// dsp.ts (block model, instant). This file only turns the stored breakpoints into a gain function for
// the player and the export.
import { curveCursor, type CurvePt } from './dsp';

/** Linear-in-dB interpolation of the gain breakpoints, evaluated at a SOURCE time. */
export function interpDb(pts: CurvePt[], t: number): number {
  if (!pts.length) return 0;
  if (t <= pts[0].t) return pts[0].db;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].t <= t) lo = m; else hi = m - 1; }
  const a = pts[lo], b = pts[Math.min(pts.length - 1, lo + 1)];
  if (b.t <= a.t) return b.db;
  return a.db + (b.db - a.db) * ((t - a.t) / (b.t - a.t));   // linear in dB = smooth to the ear
}

export interface Leveler {
  /** Linear gain for a SOURCE time. */
  gainAt: (t: number) => number;
  /** dB gain for a SOURCE time (for the UI / tests). */
  dbAt: (t: number) => number;
  pts: CurvePt[];
}

/** The gain curve as functions. Calls with increasing t (players, renderers) are O(1) via a cursor. */
export function levelerFromPoints(pts: CurvePt[]): Leveler {
  const at = curveCursor(pts);
  return { pts, dbAt: at, gainAt: (t) => Math.pow(10, at(t) / 20) };
}
