import { chromium } from 'playwright-core';
import { join } from 'node:path';
const ctx = await chromium.launchPersistentContext(join(process.env.TMPDIR, 'carver-test-profile'), { channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(process.argv[2] || 'http://127.0.0.1:5200/');
await page.waitForTimeout(1000);
console.log(await page.evaluate(async () => {
  const db = await new Promise((r) => { const q = indexedDB.open('carver'); q.onsuccess = () => r(q.result); });
  const all = await new Promise((r) => { const q = db.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => r(q.result); });
  return all.map((p) => `${p.name} upd=${new Date(p.updatedAt).toLocaleTimeString()} words=${p.words.length} removed=${p.wordState.filter(Boolean).length} sugg=${p.suggestions.length}`).join('\n');
}));
await ctx.close();
