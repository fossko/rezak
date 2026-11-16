// node tests/masterchain.test.ts — look-ahead limiter: fixed latency, hard ceiling, speed.
import { MasterChain } from '../src/lib/masterchain.ts';
const ok = (c: boolean, m: string) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok', m); };
const sr = 48000, c = { thresholdDb: -5, ratio: 5, attackMs: 8, releaseMs: 120, kneeDb: 6, makeupDb: 6 };
const m = new MasterChain(1, sr, { ...c, makeupDb: 0, thresholdDb: 0 }, -3);
const imp = new Float32Array(400); imp[10] = 0.1; m.process([imp], 400);
ok(imp.findIndex((v) => Math.abs(v) > 0.05) === 10 + m.latency, `latency ${m.latency} samples`);
const N = sr * 20, L = new Float32Array(N), R = new Float32Array(N);
for (let i = 0; i < N; i++) { const b = (i % 9000) < 300 ? 3 : 0.3; L[i] = (Math.random() * 2 - 1) * b; R[i] = Math.sin(i / 7) * b * 0.8; }
const m2 = new MasterChain(2, sr, c, -3);
for (let o = 0; o < N; o += 4096) { const n = Math.min(4096, N - o); m2.process([L.subarray(o, o + n), R.subarray(o, o + n)], n); }
let pk = 0, at = 0; const cl = 10 ** (-3 / 20);
for (let i = 0; i < N; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); pk = Math.max(pk, a); if (a >= cl * 0.99999) at++; }
ok(pk <= cl + 1e-6, `peak ${(20 * Math.log10(pk)).toFixed(3)} dBFS ≤ −3`);
ok(at < N * 0.001, `samples touching the ceiling: ${at} of ${N} (look-ahead, not clipping)`);
const t = performance.now(), big = new Float32Array(sr * 60).map(() => Math.random() * 0.5 - 0.25);
new MasterChain(1, sr, c, -3).process([big], big.length);
ok(performance.now() - t < 1000, `60 s @48k in ${(performance.now() - t).toFixed(0)} ms`);
