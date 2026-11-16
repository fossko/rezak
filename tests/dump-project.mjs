// Dumps a saved project (by name substring) from the test profile to JSON: node tests/dump-project.mjs "test video" out.json
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const [name, out] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(join(process.env.TMPDIR, 'carver-test-profile'), { channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('http://127.0.0.1:5200/');
const p = await page.evaluate(async (name) => {
  const db = await new Promise((r) => { const q = indexedDB.open('carver'); q.onsuccess = () => r(q.result); });
  const all = await new Promise((r) => { const q = db.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => r(q.result); });
  return all.filter((p) => p.name.includes(name)).sort((a, b) => b.createdAt - a.createdAt)[0];
}, name);
writeFileSync(out, JSON.stringify(p));
console.log(p.name, p.words.length, 'words');
await ctx.close();
