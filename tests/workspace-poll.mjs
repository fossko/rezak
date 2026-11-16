// The 5 s workspace poll must be light: a manifest of revisions, and a project body only when it changed.
//   npx vite preview --port 5200 &
//   node tests/workspace-poll.mjs --url=http://localhost:5200/
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const url = args.find((x) => x.startsWith('--url='))?.slice(6) || 'http://localhost:5200/';
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });

// One workspace with 8 projects, each with a ~1 MB body: the old client downloaded this every 5 s.
const WORDS = Array.from({ length: 12000 }, (_, i) => ({ text: 'слово' + i, start: i, end: i + 0.5 }));
const projects = Array.from({ length: 8 }, (_, i) => ({
  id: `p${i}`, name: `Проект ${i}`, revision: 3, updatedAt: 10,
  data: {
    id: `p${i}`, workspaceId: 'ws-poll', name: `Проект ${i}`, createdAt: 1, updatedAt: 10,
    media: { name: `video-${i}.mp4`, size: 1, lastModified: 1, duration: 10, width: 1920, height: 1080, fps: 30, videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoBitrate: 0 },
    words: WORDS, wordState: [], silence: { enabled: true, thresholdDb: -42, minDuration: 1, padBefore: 0.15, padAfter: 0.12 },
    cut: { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 }, keptSilences: [], rangeCuts: [], suggestions: [], pipeline: [], version: 1,
    batch: { settings: { transcribe: false, fillers: false, carve: false, texts: false, strength: 'careful', textSteps: [], model: 'm', targetLufs: -14.9 }, stages: { prepare: { status: 'pending' }, transcribe: { status: 'skipped' }, fillers: { status: 'skipped' }, carve: { status: 'skipped' }, texts: { status: 'skipped' }, video: { status: 'pending' } }, status: 'queued' },
  },
}));
const stats = { manifest: 0, project: 0, manifestBytes: 0, projectBytes: 0, full: 0, fullBytes: 0 };
await context.route('**/api/workspace**', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  if (req.url().endsWith('/enter')) return route.fulfill({ status: 204, body: '' });
  const send = async (status, value, bucket) => {
    const body = JSON.stringify(value);
    stats[bucket]++; stats[bucket + 'Bytes'] += body.length;
    await route.fulfill({ status, contentType: 'application/json', body });
  };
  if (path.endsWith('/manifest')) {
    return send(200, { id: 'ws-poll', name: 'Тяжёлое пространство', updatedAt: 10, locks: [], deleted: [], projects: projects.map((p) => ({ id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt })) }, 'manifest');
  }
  const single = path.match(/\/api\/workspace\/projects\/([^/?]+)$/);
  if (single) {
    const p = projects.find((x) => x.id === decodeURIComponent(single[1]));
    return send(p ? 200 : 404, p ?? { error: 'project not found' }, 'project');
  }
  return send(200, { id: 'ws-poll', name: 'Тяжёлое пространство', updatedAt: 10, locks: [], deleted: [], projects }, 'full');
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(url + '?workspace=T', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__carver.scope?.kind === 'workspace');
  await page.waitForFunction(() => document.querySelectorAll('[data-project-row]').length === 8, null, { timeout: 20000 });

  const firstSync = { ...stats };
  assert.equal(firstSync.project, 8, 'every project body is fetched once on the first sync');
  assert.equal(firstSync.full, 0, 'the full workspace endpoint is never used');
  assert.ok(firstSync.projectBytes > 2_000_000, `the fixture really is heavy (${firstSync.projectBytes} B)`);

  // Two more poll cycles: only manifests, no project bodies.
  await page.waitForTimeout(11_000);
  const after = { ...stats };
  assert.ok(after.manifest >= firstSync.manifest + 2, 'the manifest is polled');
  assert.equal(after.project, firstSync.project, 'unchanged projects are not downloaded again');
  const pollBytes = (after.manifestBytes - firstSync.manifestBytes) + (after.projectBytes - firstSync.projectBytes);
  assert.ok(pollBytes < 20_000, `polling stays small (${pollBytes} bytes over ${after.manifest - firstSync.manifest} polls)`);

  // A change on the server (new revision) is picked up and only that project is downloaded.
  projects[2].revision = 4;
  projects[2].data.notes = 'обновлено';
  await page.waitForTimeout(6000);
  assert.equal(stats.project, firstSync.project + 1, 'a changed project is fetched exactly once');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-project-row]').length), 8);

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`workspace poll: ok (first sync ${(firstSync.projectBytes / 1048576).toFixed(1)} MB, ` +
    `${after.manifest - firstSync.manifest} polls → ${pollBytes} B)`);
} finally {
  await browser.close();
}
