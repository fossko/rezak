// Admin page in a real browser: the workspace list, create / duplicate / delete buttons and the stats.
//   node tests/admin-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const port = 19500 + Math.floor(Math.random() * 400);
const dir = await mkdtemp(join(tmpdir(), 'carver-admin-ui-'));
const server = spawn(process.execPath, ['server/workspace-server.mjs', String(port)], {
  env: { ...process.env, CARVER_ADMIN_SECRET: 'secret', CARVER_ADMIN_PASSWORD: 'carver', CARVER_WORKSPACE_DIR: dir, CARVER_PUBLIC_ORIGIN: 'https://example.test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${port}`;
const auth = 'Basic ' + Buffer.from('rezak:carver').toString('base64');
const admin = (path, init = {}) => fetch(base + path, { ...init, headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) } });

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/admin'); if (r.status === 401 || r.status === 200) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

let browser;
try {
  await waitForServer();
  const created = await (await admin('/admin/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Нейрокурс' }) })).json();
  const token = created.link.split('workspace=')[1];
  const enter = await fetch(base + '/api/workspace/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = enter.headers.get('set-cookie').split(';')[0];
  for (const id of ['p1', 'p2', 'p3']) {
    await fetch(`${base}/api/workspace/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ data: { id, name: id, words: [] }, revision: 0 }) });
  }

  browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
  const context = await browser.newContext({ httpCredentials: { username: 'rezak', password: 'carver' }, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  await page.goto(base + '/admin', { waitUntil: 'networkidle' });
  const rows = () => page.locator('#rows tr');
  const rowByName = (name) => page.locator('#rows tr').filter({
    has: page.locator('.name').filter({ hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }),
  });

  // 1. The stored workspace is listed with its project count and link.
  await page.waitForSelector('#rows tr:has-text("Нейрокурс")');
  assert.equal(await rows().count(), 1);
  const firstRow = rowByName('Нейрокурс');
  assert.match(await firstRow.innerText(), /3/, 'project count is shown');
  assert.match(await firstRow.locator('input').inputValue(), /^\?workspace=/);
  await firstRow.locator('input').click();
  assert.match(await firstRow.locator('input').inputValue(), /^https:\/\/example\.test\/\?workspace=/);
  await page.screenshot({ path: '/tmp/admin-ui.png' });

  // 2. Stats: workspaces / projects / open.
  assert.match(await page.locator('#stats').innerText(), /1\s*Пространств/);
  assert.match(await page.locator('#stats').innerText(), /3\s*Проектов всего/);

  // 3. Duplicate creates a copy with its own link and the same projects.
  await firstRow.locator('button', { hasText: 'Дублировать' }).click();
  await page.waitForSelector('#rows tr:has-text("Нейрокурс (копия)")');
  assert.equal(await rows().count(), 2);
  const copyRow = rowByName('Нейрокурс (копия)');
  assert.match(await copyRow.innerText(), /3/, 'the copy keeps the projects');
  const originalLink = await rowByName('Нейрокурс').locator('input').inputValue();
  const copyLink = await copyRow.locator('input').inputValue();
  assert.notEqual(copyLink, originalLink, 'the copy has a new URL');
  assert.match(await page.locator('#stats').innerText(), /2\s*Пространств/);
  assert.match(await page.locator('#stats').innerText(), /6\s*Проектов всего/);

  // 4. Delete removes only the copy.
  await copyRow.locator('button', { hasText: 'Удалить' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
  assert.equal(await rows().count(), 1);
  assert.match(await rowByName('Нейрокурс').innerText(), /3/);
  assert.match(await page.locator('#stats').innerText(), /3\s*Проектов всего/);

  // 5. The create form adds an empty workspace.
  await page.fill('#name', 'Редакция');
  await page.click('#create');
  await page.waitForSelector('#rows tr:has-text("Редакция")');
  assert.equal(await rows().count(), 2);
  assert.match(await rowByName('Редакция').innerText(), /0/, 'a new workspace starts empty');

  // 6. The page reports the new link so it can be sent to the team.
  assert.match(await page.locator('#msg').innerText(), /https:\/\/example\.test\/\?workspace=/);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('admin ui: ok');
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
