// Serves the built site from dist/ locally:  node serve.mjs  (or: node serve.mjs 8123)
// Needed because Chrome blocks module scripts, workers, WASM and fetch() on file:// pages,
// so dist/index.html must be opened over HTTP even for local use.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist', import.meta.url));
const modelsRoot = fileURLToPath(new URL('./models', import.meta.url));
const port = +process.argv[2] || 8123;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    // Hugging Face fallback mirror: the app asks for ./models/<model>/resolve/<rev>/<file>.
    if (p.startsWith('models/')) {
      const mf = join(modelsRoot, p.slice('models/'.length));
      if (!mf.startsWith(modelsRoot)) { res.writeHead(403).end(); return; }
      const data = await readFile(mf);
      res.writeHead(200, { 'Content-Type': MIME[extname(mf)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
      return;
    }
    const file = join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': file.includes('/assets/') ? 'max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Carver → http://127.0.0.1:${port}/   (dist/, Ctrl+C to stop)`));
