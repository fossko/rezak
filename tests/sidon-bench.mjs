// Sidon WebGPU benchmark in real Chrome (dev server, imports onnxruntime-web straight from node_modules).
// node tests/sidon-bench.mjs [--url=http://127.0.0.1:5299/] [--variant=fp16|int8] [--secs=10,20,30] [--ep=webgpu|wasm]
import { chromium } from 'playwright-core';
import { join } from 'node:path';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3);
const url = opt('url', 'http://127.0.0.1:5299/');
const variant = opt('variant', 'fp16');
const secs = opt('secs', '10,20,30').split(',').map(Number);
const ep = opt('ep', 'webgpu');
const ctx = await chromium.launchPersistentContext(join(process.env.TMPDIR || '/tmp', 'carver-sidon-bench-profile'), {
  channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true, args: ['--enable-unsafe-webgpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
});
const page = ctx.pages()[0] || await ctx.newPage();
page.on('console', (m) => console.log('  page', m.text().slice(0, 300)));
await page.goto(url + 'index.html');
const r = await page.evaluate(async ({ variant, secs, ep }) => {
  const ort = await import('/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs');
  ort.env.wasm.numThreads = 1;
  const base = `/models/soniqo/Sidon-ONNX/resolve/main/`;
  const predFile = variant === 'int8' ? 'int8/sidon-predictor.onnx' : 'fp16/sidon-predictor.onnx';
  const out = { adapter: null, timings: [] };
  try { const a = await navigator.gpu.requestAdapter(); out.adapter = a?.info?.vendor + ' ' + a?.info?.architecture + ' f16:' + a?.features.has('shader-f16'); } catch (e) { out.adapter = String(e); }
  let t = performance.now();
  const [pb, vb] = await Promise.all([fetch(base + predFile).then((r) => r.arrayBuffer()), fetch(base + 'fp16/sidon-vocoder.onnx').then((r) => r.arrayBuffer())]);
  out.fetchMs = Math.round(performance.now() - t);
  t = performance.now();
  const so = { executionProviders: [ep], graphOptimizationLevel: 'all' };
  const pred = await ort.InferenceSession.create(new Uint8Array(pb), so);
  const voc = await ort.InferenceSession.create(new Uint8Array(vb), so);
  out.createMs = Math.round(performance.now() - t);
  for (const s of secs) {
    const T = s * 50;
    const feat = new Float32Array(T * 160); for (let i = 0; i < feat.length; i++) feat[i] = Math.sin(i * 0.37) * 0.8;
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const f = await pred.run({ input_features: new ort.Tensor('float32', feat, [1, T, 160]) });
      const t1 = performance.now();
      const a = await voc.run({ features: f.features });
      const t2 = performance.now();
      runs.push({ pred: Math.round(t1 - t0), voc: Math.round(t2 - t1), len: a.audio.dims[1] });
      f.features.dispose?.(); a.audio.dispose?.();
    }
    out.timings.push({ secs: s, runs, xRealtime: +(s / ((runs[2].pred + runs[2].voc) / 1000)).toFixed(1) });
  }
  return out;
}, { variant, secs, ep });
console.log(JSON.stringify(r, null, 1));
await ctx.close();
