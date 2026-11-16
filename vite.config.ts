import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

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
      const rel = normalize(decodeURIComponent(url.slice('/models/'.length)));
      const file = join(dir, rel);
      if (!file.startsWith(dir)) { res.statusCode = 403; res.end(); return; }
      const data = await readFile(file);
      res.setHeader('Content-Type', MODELS_MIME[extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(data);
    } catch { next(); }
  };
  return {
    name: 'carver-serve-models',
    configureServer: (s) => { s.middlewares.use(handler); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [react(), serveModels()],
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  server: { port: 5199, strictPort: true },
});
