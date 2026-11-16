#!/usr/bin/env node
// Downloads the exact model files the app can request into ./models, laid out as
//   models/<model-id>/resolve/<revision>/<path>
// i.e. the same layout Hugging Face uses, so the app's fallback can fetch them with the same
// relative path it would use for huggingface.co.
//
// Usage:
//   node deploy/sync-models.mjs            # default models (turbo + wav2vec2 + small + base)
//   node deploy/sync-models.mjs --only=whisper-large-v3-turbo,wav2vec2
//   node deploy/sync-models.mjs --list     # print what would be downloaded, no downloads
//
// Requires network access to huggingface.co (the operator's proxy is fine). Re-running skips
// files whose size already matches, so it is safe to resume.

import { mkdir, stat, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');           // carver/
const OUT = join(ROOT, 'models');
const HF = 'https://huggingface.co';
const REV = 'main';

// Onnx variants the app can ask for, by dtype:
//   turbo  webgpu f16 -> encoder fp16 / decoder q4 ; webgpu no-f16 -> encoder q4 / decoder q4 ; wasm -> q8/q8
//   small/base webgpu -> encoder fp32 / decoder q4 ; wasm -> q8/q8
//   ctc    webgpu f16 -> fp16 ; webgpu no-f16 -> q4 ; wasm -> q8
const ONNX = {
  'onnx-community/whisper-large-v3-turbo': [
    // fp32 encoder: the graph is a stub, its weights live in the external `_data` file. Some
    // WebGPU/CPU paths fall back to this when the requested dtype cannot be used; without it the
    // fallback 404s (seen in production: encoder_model.onnx + encoder_model.onnx_data).
    'onnx/encoder_model.onnx',
    'onnx/encoder_model.onnx_data',
    'onnx/encoder_model_fp16.onnx',
    'onnx/encoder_model_q4.onnx',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_q4.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
  ],
  'onnx-community/wav2vec2-large-xlsr-53-russian-ONNX': [
    'onnx/model_fp16.onnx',
    'onnx/model_q4.onnx',
    'onnx/model_quantized.onnx',
  ],
  // «Реставрация» (Sidon speech restoration). The app pins a commit on Hugging Face; the mirror is `main`.
  'soniqo/Sidon-ONNX': [
    'fp16/sidon-predictor.onnx',
    'fp32/sidon-vocoder.onnx',   // fp16 vocoder breaks on WebGPU (fp16 overflow in weight-norm)
  ],
  'onnx-community/whisper-small': [
    'onnx/encoder_model.onnx',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_q4.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
  ],
  'onnx-community/whisper-base': [
    'onnx/encoder_model.onnx',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_q4.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
  ],
};

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const list = args.includes('--list');

const models = Object.entries(ONNX).filter(([id]) => !only.length || only.some((s) => id.includes(s)));

async function fetchJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function fileSize(p) { try { return (await stat(p)).size; } catch { return -1; } }

async function download(id, path, size) {
  const url = `${HF}/${id}/resolve/${REV}/${path}`;
  const dest = join(OUT, id, 'resolve', REV, path);
  const have = await fileSize(dest);
  if (size > 0 && have === size) { console.log(`  = ${path} (${(size / 1e6).toFixed(0)} MB, already there)`); return; }
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // curl is used instead of Node's fetch: several times faster through the operator's proxy.
      await execFileP('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', tmp, url], { maxBuffer: 1 << 20 });
      const got = await fileSize(tmp);
      if (size > 0 && got !== size) throw new Error(`size mismatch: got ${got}, expected ${size}`);
      await rename(tmp, dest);
      console.log(`  + ${path} (${(got / 1e6).toFixed(0)} MB)`);
      return;
    } catch (e) {
      console.log(`  ! ${path} attempt ${attempt}: ${e.message.split('\n')[0]}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

let total = 0;
for (const [id, onnx] of models) {
  console.log(`\n${id}`);
  if (list) {
    for (const p of onnx) console.log(`  ${p}`);
    continue;
  }
  // The tree gives sizes for every file; root-level files (config/tokenizer/...) are taken as a set
  // so a renamed/extra JSON in the repo does not silently break the mirror.
  const tree = await fetchJson(`${HF}/api/models/${id}/tree/${REV}?recursive=true`);
  const sizes = new Map(tree.filter((f) => f.type === 'file').map((f) => [f.path, f.size || 0]));
  const rootFiles = tree
    .filter((f) => f.type === 'file' && !f.path.includes('/') && /\.(json|txt)$/.test(f.path))
    .map((f) => f.path);

  for (const path of [...rootFiles, ...onnx]) {
    await download(id, path, sizes.get(path) || 0);
    total += sizes.get(path) || 0;
  }
}
console.log(`\ndone. ${(total / 1e9).toFixed(2)} GB accounted for (existing files may be larger).`);
