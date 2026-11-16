// Measures where LLM latency goes for Carver's real AI-carving request.
// node tests/llm-timing.ts <baseUrl> <model> [apiKey] [extraBodyJSON]
import { readFileSync } from 'node:fs';
const [url, model, key = '', extra = '{}', limit = '180'] = process.argv.slice(2);
const p = JSON.parse(readFileSync(process.env.TMPDIR + '/full-project5.json', 'utf8'));
// the exact prompt Carver sends (taken from src/llm/carve.ts) and the same line format
const src = readFileSync(new URL('../src/llm/carve.ts', import.meta.url), 'utf8');
const DEFAULT_CARVE_PROMPT = eval(src.match(/export const DEFAULT_CARVE_PROMPT = (`[\s\S]*?`);/)![1]);
const lines: { id: number; text: string }[] = [];
p.words.forEach((w: any, i: number) => {
  const prev = p.words[i - 1], cur = lines[lines.length - 1];
  if (!cur || w.para || (prev && (w.start - prev.end >= 0.6 || /[.!?…]$/.test(prev.text)) && cur.text.length > 20)) lines.push({ id: i, text: '' });
  const l = lines[lines.length - 1]; l.text += (l.text ? ' ' : '') + (w.kind ? `‹${w.text}›` : w.text);
});
let user = 'Расшифровка:\n', n = 0;
for (const l of lines) { if (user.length + l.text.length > 8000) break; user += `#${l.id} ${l.text}\n`; n++; }
const system = DEFAULT_CARVE_PROMPT.replace('{strength}', 'Будь осторожен.');
const body = { model, stream: true, temperature: 0.2, response_format: { type: 'json_object' }, ...JSON.parse(extra),
  messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
const resp = await fetch(url.replace(/\/+$/, '') + '/chat/completions', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(+limit * 1000) });
const tHead = ms();
if (!resp.ok) { console.log('HTTP', resp.status, (await resp.text()).slice(0, 300)); process.exit(1); }
const rd = resp.body!.getReader(), dec = new TextDecoder();
let buf = '', tFirstByte = -1, tReason = -1, tContent = -1, rChars = 0, cChars = 0, fields = new Set<string>(), content = '';
let aborted = false;
for (;;) {
  let r: any; try { r = await rd.read(); } catch { aborted = true; break; }
  const { value, done } = r; if (done) break;
  if (tFirstByte < 0) tFirstByte = ms();
  buf += dec.decode(value, { stream: true });
  let i; while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
    let j: any; try { j = JSON.parse(line.slice(5)); } catch { continue; }
    const d = j.choices?.[0]?.delta || {};
    for (const k of Object.keys(d)) if (d[k]) fields.add(k);
    const r = d.reasoning_content || d.reasoning || '';
    if (r) { if (tReason < 0) tReason = ms(); rChars += r.length; }
    if (d.content) { if (tContent < 0) tContent = ms(); cChars += d.content.length; content += d.content; }
  }
}
const think = (content.match(/<think>[\s\S]*?(<\/think>|$)/) || [''])[0].length;
console.log(JSON.stringify({ model, promptChars: system.length + user.length, lines: n, headersMs: tHead, firstByteMs: tFirstByte,
  firstReasoningMs: tReason, reasoningChars: rChars, firstContentMs: tContent, contentChars: cChars, thinkTagChars: think, totalMs: ms(), aborted, deltaFields: [...fields] }));
if (process.env.DUMP) { const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.DUMP, content); }
process.exit(0);
