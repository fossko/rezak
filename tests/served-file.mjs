import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';
import { servedFile } from '../server/served-file.mjs';

const temp = await mkdtemp(join(tmpdir(), 'rezak-served-file-'));
try {
  const root = join(temp, 'models');
  const sibling = join(temp, 'models-backup');
  const configured = join(temp, 'configured');
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
  await mkdir(root);
  await mkdir(sibling);
  await writeFile(join(root, 'asset.txt'), 'модель');
  await writeFile(join(sibling, 'asset.txt'), 'резерв');
  await symlink(root, configured, directoryLink);
  await symlink(sibling, join(root, 'other'), directoryLink);

  const expected = await realpath(join(root, 'asset.txt'));
  assert.equal(await servedFile(root, 'asset.txt'), expected);
  assert.equal(await servedFile(configured, 'asset.txt'), expected);
  assert.equal(await servedFile(root, join(sibling, 'asset.txt')), null);
  assert.equal(await servedFile(root, join('other', 'asset.txt')), null);
  await assert.rejects(servedFile(root, 'missing.txt'), { code: 'ENOENT' });

  await mkdir(join(temp, 'dist'));
  await mkdir(join(temp, 'server'));
  await writeFile(join(temp, 'dist', 'index.html'), '<title>Резак</title>');
  await copyFile(new URL('../serve.mjs', import.meta.url), join(temp, 'serve.mjs'));
  await copyFile(new URL('../server/served-file.mjs', import.meta.url), join(temp, 'server', 'served-file.mjs'));
  const server = spawn(process.execPath, [join(temp, 'serve.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const stopped = once(server, 'exit');
  try {
    const [output] = await Promise.race([
      once(server.stdout, 'data'),
      stopped.then(() => { throw new Error('Сервер статики завершился до запуска'); }),
    ]);
    const base = output.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(base);
    const index = await fetch(base + '/');
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await index.text(), '<title>Резак</title>');
    const model = await fetch(base + '/models/asset.txt');
    assert.equal(model.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await model.text(), 'модель');
  } finally {
    server.kill();
    await stopped;
  }

  const previousDirectory = process.cwd();
  const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
  try {
    process.chdir(temp);
    const network = { host: '127.0.0.1', port: 0 };
    const options = { root: temp, configFile, logLevel: 'silent', server: network, preview: network };
    const dev = await createServer(options);
    try {
      await dev.listen();
      await checkModel(dev.httpServer);
    } finally {
      await dev.close();
    }
    const built = await preview(options);
    try {
      await checkModel(built.httpServer);
    } finally {
      await built.close();
    }
  } finally {
    process.chdir(previousDirectory);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function checkModel(server) {
  const { port } = server.address();
  const result = await fetch(`http://127.0.0.1:${port}/models/asset.txt`);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(result.headers.get('cache-control'), 'no-cache');
  assert.equal(await result.text(), 'модель');
}
