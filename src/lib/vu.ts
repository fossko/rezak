/** Bottom of the meter scale, dBFS. */
export const VU_FLOOR_DB = -60;

/** 0 at the noise floor, 100 at 0 dBFS. */
export function vuPercent(db: number): number {
  const x = (db - VU_FLOOR_DB) / (0 - VU_FLOOR_DB);
  return Math.max(0, Math.min(1, x)) * 100;
}

/** RMS and sample peak of the played (post-processing) signal, in dBFS. */
export function vuDb(rms: number, peak: number): { rmsDb: number; peakDb: number } {
  const db = (v: number) => 20 * Math.log10(Math.max(1e-7, v));
  return { rmsDb: Math.max(VU_FLOOR_DB, db(rms)), peakDb: Math.max(VU_FLOOR_DB, db(peak)) };
}
