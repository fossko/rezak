export const SR = 16000;   // analysis sample rate (Whisper / wav2vec2)

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Start of the visible waveform window when following `src`: keep the playhead on screen, but never
 *  let the window run past the end of the recording (that left a 200–300 px blank strip at the end). */
export function followViewStart(src: number, span: number, duration: number, lead = 0.25): number {
  return clamp(src - span * lead, 0, Math.max(0, duration - span));
}

/** HH:MM:SS.mmm */
export function ts(sec: number, msSep = '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${msSep}${String(r).padStart(3, '0')}`;
}
/** Compact clock: M:SS or H:MM:SS */
export function clock(sec: number, tenths = false): string {
  if (!isFinite(sec)) return '–';
  const neg = sec < 0; sec = Math.abs(sec);
  const t = tenths ? Math.floor(sec * 10) / 10 : Math.floor(sec);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60);
  const frac = tenths ? ',' + Math.floor((t * 10) % 10) : '';
  return (neg ? '−' : '') + (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0') + frac;
}
export function fmtDur(s: number): string {
  if (!isFinite(s)) return '–';
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ' ч ' : '') + (h || m ? m + ' мин ' : '') + x + ' с';
}
export const fmtBytes = (b: number) => b > 1e9 ? (b / 1e9).toFixed(2).replace('.', ',') + ' ГБ' : (b / 1e6).toFixed(1).replace('.', ',') + ' МБ';
export const fmtSec = (s: number, d = 1) => s.toFixed(d).replace('.', ',') + ' с';
export const pct = (x: number) => (clamp(x, 0, 1) * 100).toFixed(1) + '%';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

/** Binary search: index of the last element with key(el) <= x, or -1. */
export function lastLE<T>(arr: ArrayLike<T>, x: number, key: (v: T) => number): number {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal typed event emitter. */
export class Emitter<E extends Record<string, unknown>> {
  private m = new Map<keyof E, Set<(v: any) => void>>();
  on<K extends keyof E>(k: K, f: (v: E[K]) => void): () => void {
    if (!this.m.has(k)) this.m.set(k, new Set());
    this.m.get(k)!.add(f);
    return () => this.m.get(k)!.delete(f);
  }
  emit<K extends keyof E>(k: K, v: E[K]) { for (const f of this.m.get(k) || []) f(v); }
}
