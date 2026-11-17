import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { servedFile } from './server/served-file.mjs';
import { createChatGptPlan } from './server/chatgpt-plan.mjs';

const MODELS_MIME: Record<string, string> = {
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.onnx': 'application/octet-stream',
};

/** Serve ./models at /models in `vite dev` and `vite preview` — the Hugging Face fallback mirror. */
function serveModels(): Plugin {
  const dir = join(process.cwd(), 'models');
  const handler = async (req: any, res: any, next: any) => {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/models/')) return next();
    try {
      const rel = decodeURIComponent(url.slice('/models/'.length));
      const file = await servedFile(dir, rel);
      if (!file) { res.statusCode = 403; res.end(); return; }
      const data = await readFile(file);
      res.setHeader('Content-Type', MODELS_MIME[extname(rel)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  };
  return {
    name: 'carver-serve-models',
    configureServer: (s) => { s.middlewares.use(handler); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); },
  };
}

function chatGptPlan(): Plugin {
  return {
    name: 'rezak-chatgpt-plan',
    configureServer: server => { server.middlewares.use(createChatGptPlan()); },
    configurePreviewServer: server => { server.middlewares.use(createChatGptPlan()); },
  };
}

export default defineConfig({
  plugins: [react(), serveModels(), chatGptPlan()],
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  preview: { host: '127.0.0.1' },
});
