// Browser regression for batch diagnostics. Requires a built preview and fixture2sec.mp4.
// CARVER_CHROME_PATH=... CARVER_FIXTURE=... node tests/batch-log.mjs [preview-url]
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const appUrl = process.argv[2] || process.env.CARVER_URL || 'http://127.0.0.1:5200/';
const fixture = process.env.CARVER_FIXTURE || new URL('./fixture2sec.mp4', import.meta.url).pathname;
const seen = [], wait = ms => new Promise(r => setTimeout(r, ms));
const mock = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); return res.end(); }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    seen.push({ auth: req.headers.authorization || '', headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    const isJson = !!JSON.parse(body).response_format, send = x => res.write(`data: ${JSON.stringify(x)}\n\n`);
    send({ choices: [{ delta: { reasoning_content: 'проверяю ' } }] }); await wait(160);
    send({ choices: [{ delta: { reasoning_content: 'текст ' } }] }); await wait(160);
    send({ choices: [{ delta: { content: isJson ? '{"cuts":[]}' : 'результат <b>не HTML</b>' } }] }); await wait(160);
    // No trailing newline: validates the final SSE line flush.
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } })}`);
    setTimeout(() => res.end(), 50);
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CARVER_CHROME_PATH });
const page = await browser.newPage();
try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => !!window.__carver && !!window.__carverBatch && !!window.__carverBatchLog), true, 'batch and logger hooks must be exposed');
  await page.evaluate(({ port }) => {
    localStorage.setItem('carver:llm', JSON.stringify({ provider: 'custom', url: `http://127.0.0.1:${port}/v1`, key: 'SECRET_KEY', model: 'mock', temperature: '0.2', maxTokens: '', chunkChars: '12000', parallel: '1', extraBody: '', extraHeaders: JSON.stringify({ 'X-Test-Secret': 'EXTRA_SECRET' }), thinking: 'auto' }));
    const S = window.__carver;
    S.prepareBatchFile = async () => { S.pcm = new Int16Array(16000); S.levels = new Float32Array(1000).fill(-20); S.audio = { lufs: -20, truePeak: -1, duration: 1 }; };
    S.transcribe = async () => { const words = 'это тестовая расшифровка для проверки пакетного журнала'.split(' ').map((text, i) => ({ text, start: i * .1, end: i * .1 + .08 })); S.project.words = words; S.wordState = new Uint8Array(words.length); S.wordMute = new Uint8Array(words.length); S.recompute(); };
    S.findFillers = async () => {};
  }, { port });
  // Exercise the logger directly: concurrent flushes and a secret split across stream chunks.
  const direct = await page.evaluate(async () => {
    const l = window.__carverBatchLog, a = 'logger-concurrency-a', b = 'logger-concurrency-b';
    l.protect('SPLIT_SECRET');
    l.event(a, 'direct', 'alpha', { authorization: 'SPLIT_SECRET' });
    l.stream(a, 'answer', 'stream-a', 'SPLIT_'); l.stream(a, 'answer', 'stream-a', 'SECRET');
    l.event(b, 'direct', 'unrelated', { value: 'kept' });
    // The live journal keeps only its newest 300 lines.
    const c = 'logger-cap';
    for (let i = 0; i < 450; i++) l.event(c, 'cap', 'line-' + String(i).padStart(3, '0'));
    l.stream(c, 'cap-stream', 'big', Array.from({ length: 400 }, (_, i) => 'stream-' + i).join('\n'));
    await Promise.all([l.flush(a), l.flush(a), l.flush(b), l.load(a), l.load(b), l.flush(c)]);
    const once = l.text(c);
    // A second trim/flush pass must not duplicate the entry header or grow beyond the cap.
    await l.flush(c);
    return { a: l.text(a), b: l.text(b), cap: l.text(c), capTail: l.tail(c), once, headers: (l.text(c).match(/\] cap-stream/g) || []).length };
  });
  assert.doesNotMatch(direct.a, /SPLIT_SECRET/); assert.match(direct.a, /authorization.*REDACTED/s); assert.match(direct.a, /alpha/);
  assert.match(direct.b, /unrelated/); assert.doesNotMatch(direct.a, /unrelated/);
  const capLines = direct.cap.split('\n').filter(Boolean).length;
  assert.ok(capLines <= 300, `live journal must keep at most 300 lines, got ${capLines}`);
  assert.match(direct.once, /stream-399/); assert.doesNotMatch(direct.once, /line-000/);
  assert.equal(direct.headers, 1, 'repeated trimming must not duplicate the stream header');
  assert.ok(direct.cap.split('\n').filter(Boolean).length <= 300, 'second trim pass stays within 300 lines');
  assert.ok(direct.capTail.split('\n').filter(Boolean).length <= 300, 'tail is capped at 300 lines');
  await page.locator('#carver-batch-input').setInputFiles(fixture);
  await page.getByRole('button', { name: '▶ Запустить очередь' }).click();
  await page.waitForFunction(() => document.querySelector('[data-project-row]')?.querySelector('.stage-done'), null, { timeout: 45000 });
  const log = page.locator('[data-batch-log]').first();
  // The report must update while the slow LLM request is still running.
  await page.waitForFunction(() => window.__carverBatch.running === true && /результат/.test(document.querySelector('[data-batch-log] pre')?.textContent || ''), null, { timeout: 45000 });
  const liveReport = await log.locator('pre').textContent();
  assert.match(liveReport, /проверяю/); assert.match(liveReport, /результат/);
  assert.match(await log.locator('.batch-log-head').textContent(), /последнее событие/);
  await page.waitForFunction(() => window.__carverBatch.running === false, null, { timeout: 45000 });
  // Nothing is processed or edited now, so every journal is collapsed by default.
  await page.waitForFunction(() => document.querySelector('[data-batch-log].collapsed'), null, { timeout: 5000 });
  assert.equal(await log.locator('pre').count(), 0, 'collapsed idle journal does not render its body');
  const report = await log.locator('.batch-log-head').textContent();
  assert.match(report, /Показать журнал/);
  await log.getByRole('button', { name: /показать журнал/i }).click();
  const reportBody = await log.locator('pre').textContent();
  assert.match(reportBody, /проверяю/); assert.match(reportBody, /результат/);
  assert.doesNotMatch(reportBody, /SECRET_KEY|EXTRA_SECRET|Bearer/i); assert.match(reportBody, /<b>ne HTML|<b>не HTML/); assert.match(await log.locator('pre').innerHTML(), /&lt;b&gt;/);
  assert.match(reportBody, /провайдер|ответ|размышления/i);
  assert.equal(await page.locator('[data-batch-log]').count(), 1, 'project log must be scoped');
  const dlWait = page.waitForEvent('download');
  await log.getByRole('button', { name: /скачать журнал/i }).click();
  const download = await dlWait, downloadedText = await readFile(await download.path(), 'utf8');
  assert.match(downloadedText, /проверяю/); assert.doesNotMatch(downloadedText, /SECRET_KEY|EXTRA_SECRET|Bearer/i);
  const pipelineCount = await page.evaluate(async () => await new Promise((resolve, reject) => {
    const r = indexedDB.open('carver'); r.onerror = () => reject(r.error); r.onsuccess = () => { const q = r.result.transaction('projects').objectStore('projects').getAll(); q.onerror = () => reject(q.error); q.onsuccess = () => resolve(q.result.filter(p => p.batch).reduce((n, p) => Math.max(n, p.pipeline?.length || 0), 0)); };
  }));
  assert.equal(pipelineCount, 3, 'all three final text results persisted');
  await page.reload();
  await page.waitForSelector('[data-batch-log]');
  // After a reload nothing is running, so the journal starts collapsed; expand it to read the persisted tail.
  await page.locator('[data-batch-log]').first().getByRole('button', { name: /показать журнал/i }).click();
  await page.waitForFunction(() => /результат/.test(document.querySelector('[data-batch-log] pre')?.textContent || ''), null, { timeout: 15000 });
  assert.match(await page.locator('[data-batch-log] pre').textContent(), /результат/);
  const persistedAfterReload = await page.evaluate(async () => await new Promise((resolve, reject) => { const r = indexedDB.open('carver'); r.onerror = () => reject(r.error); r.onsuccess = () => { const q = r.result.transaction('projects').objectStore('projects').getAll(); q.onerror = () => reject(q.error); q.onsuccess = () => resolve(q.result.filter(p => p.batch).reduce((n, p) => Math.max(n, p.pipeline?.length || 0), 0)); }; }));
  assert.equal(persistedAfterReload, 3, 'three final results survive reload');
  assert.ok(seen.length >= 4, `expected carve + three text requests, got ${seen.length}`);
  assert.ok(seen.every(x => x.auth === 'Bearer SECRET_KEY'));
  console.log('PASS batch diagnostics integration:', { requests: seen.length, fixture });
} finally { await browser.close(); await new Promise(r => mock.close(r)); }
