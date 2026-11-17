// Serves the built site from dist/ locally:  node serve.mjs  (or: node serve.mjs 8123)
// Needed because Chrome blocks module scripts, workers, WASM and fetch() on file:// pages,
// so dist/index.html must be opened over HTTP even for local use.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servedFile } from './server/served-file.mjs';
import { createChatGptPlan } from './server/chatgpt-plan.mjs';

const root = fileURLToPath(new URL('./dist', import.meta.url));
const modelsRoot = fileURLToPath(new URL('./models', import.meta.url));
const port = process.argv[2] === '0' ? 0 : +process.argv[2] || 8123;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

const chatGptPlan = createChatGptPlan();
const server = createServer((req, res) => chatGptPlan(req, res, async () => {
  try {
    const pathname = decodeURIComponent(req.url.split('?')[0]).replace(/\\/g, '/');
    const model = pathname.startsWith('/models/');
    let p = pathname.slice(model ? '/models/'.length : 1);
    if (!model && (!p || p.endsWith('/'))) p += 'index.html';
    const file = await servedFile(model ? modelsRoot : root, p);
    if (!file) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(p)] || 'application/octet-stream',
      'Cache-Control': !model && p.startsWith('assets/') ? 'max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}));
server.listen(port, '127.0.0.1', () => console.log(`Carver → http://127.0.0.1:${server.address().port}/   (dist/, Ctrl+C to stop)`));
