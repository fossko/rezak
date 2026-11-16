// Unit test of the WSOLA stretcher (run: node tests/stretch.test.ts): length, pitch and continuity.
import { Stretcher } from '../src/player/stretch.ts';
import { readFileSync, existsSync } from 'node:fs';

const sr = 48000;
function run(x: Float32Array[], rate: number, block = 1024) {
  const st = new Stretcher(x.length, sr, rate);
  const outs: Float32Array[][] = [];
  for (let i = 0; i < x[0].length; i += block) { st.push(x.map((c) => c.subarray(i, i + block))); const o = st.pull(); if (o) outs.push(o); }
  st.flush(); const o = st.pull(); if (o) outs.push(o);
  return x.map((_, c) => { const n = outs.reduce((a, b) => a + b[c].length, 0); const r = new Float32Array(n); let p = 0; for (const b of outs) { r.set(b[c], p); p += b[c].length; } return r; });
}
// pitch by autocorrelation (lag of the strongest period between 2 and 20 ms)
function pitch(x: Float32Array) {
  const a = Math.floor(x.length / 2) - 4000, seg = x.subarray(a, a + 4096);
  let best = 0, bl = 0;
  for (let lag = Math.round(sr * 0.002); lag < sr * 0.02; lag++) {
    let s = 0; for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    if (s > best) { best = s; bl = lag; }
  }
  return sr / bl;
}
let fail = 0;
const check = (ok: boolean, msg: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; };
const N = sr * 3, tone = new Float32Array(N), tone2 = new Float32Array(N);
for (let i = 0; i < N; i++) { tone[i] = 0.5 * Math.sin(2 * Math.PI * 180 * i / sr) + 0.2 * Math.sin(2 * Math.PI * 360 * i / sr); tone2[i] = tone[i] * 0.7; }
for (const rate of [0.75, 1.25, 1.5, 2]) {
  const [y, y2] = run([tone, tone2], rate);
  const want = Math.round(N / rate);
  check(Math.abs(y.length - want) <= 1, `rate ${rate}: length ${y.length} (want ${want})`);
  const f = pitch(y);
  check(Math.abs(f - 180) < 4, `rate ${rate}: pitch ${f.toFixed(1)} Hz (want 180)`);
  // steady-state amplitude ≈ input (no comb filtering / dropouts)
  let mx = 0, mn = Infinity;
  for (let b = sr * 0.2; b + 960 < y.length - sr * 0.2; b += 960) { let e = 0; for (let i = b; i < b + 960; i++) e += y[i] * y[i]; e = Math.sqrt(e / 960); mx = Math.max(mx, e); mn = Math.min(mn, e); }
  check(mn > 0.3 && mx < 0.45, `rate ${rate}: RMS per 20 ms within ${mn.toFixed(3)}..${mx.toFixed(3)} (input 0.381)`);
  check(Math.abs(y2[sr] / (y[sr] || 1e-9) - 0.7) < 0.01 || Math.abs(y[sr]) < 1e-3, `rate ${rate}: channels stay aligned`);
}
// real speech from the test clip (16 kHz mono raw, if present): length check only
const raw = (process.env.TMPDIR || '/tmp') + '/clip.raw';
if (existsSync(raw)) {
  const b = readFileSync(raw); const s16 = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
  const x = new Float32Array(sr * 10); for (let i = 0; i < x.length; i++) x[i] = s16[Math.floor(i / 3) + 16000 * 60] / 32768;
  const t0 = performance.now();
  const [y] = run([x, x], 2);
  const ms = performance.now() - t0;
  check(Math.abs(y.length - x.length / 2) <= 1, `speech 10 s @2×: ${y.length} samples, processed in ${ms.toFixed(0)} ms (${(10000 / ms).toFixed(0)}× real time)`);
}
process.exit(fail ? 1 : 0);
