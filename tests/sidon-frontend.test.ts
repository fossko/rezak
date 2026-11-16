// Front-end parity with HF SeamlessM4TFeatureExtractor. Reference files are produced by Python:
//   fe_in.f32 (16 kHz input incl. padding) and fe_ref.f32 ([T,160]) in $SIDON_FE_DIR (default $TMPDIR/sidon-test).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { w2vBertFeatures } from '../src/restore/frontend.ts';
const dir = process.env.SIDON_FE_DIR || join(process.env.TMPDIR || '/tmp', 'sidon-test');
const f32 = (p: string) => { const b = readFileSync(join(dir, p)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const x = f32('fe_in.f32'), ref = f32('fe_ref.f32');
const t0 = performance.now();
const { data, T } = w2vBertFeatures(x);
const ms = performance.now() - t0;
let maxErr = 0, sum = 0;
for (let i = 0; i < ref.length; i++) { const e = Math.abs(data[i] - ref[i]); sum += e; if (e > maxErr) maxErr = e; }
console.log(`T=${T} (ref ${ref.length / 160}), max abs err ${maxErr.toExponential(2)}, mean ${(sum / ref.length).toExponential(2)}, ${ms.toFixed(0)} ms for ${(x.length / 16000).toFixed(1)} s`);
if (T * 160 !== ref.length || maxErr > 1e-2) { console.error('FAIL'); process.exit(1); }
console.log('ok');
