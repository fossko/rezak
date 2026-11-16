// LLM-powered auto-carving: find false starts, repetitions, fillers, slips and asides in the
// transcript and turn them into word-range suggestions. The model QUOTES what to remove (models
// copy text reliably, unlike counting word indices); quotes are matched back to word indices.
import type { Suggestion, SuggestionType, Word } from '../lib/types';
import { chatComplete, llmConfig, parseJsonLoose, pool, type LlmConfig, type Phase } from './client';
import { uid } from '../lib/util';

export type Strength = 'careful' | 'normal' | 'aggressive';

const MIN_CONF: Record<Strength, number> = { careful: 0.8, normal: 0.6, aggressive: 0.4 };

export const TYPE_LABELS: Record<SuggestionType, string> = {
  false_start: 'фальстарт', repetition: 'повтор', filler: 'паразит', slip: 'оговорка', aside: 'отступление', other: 'другое',
};

const STRENGTH_TEXT: Record<Strength, string> = {
  careful: 'Будь осторожен: предлагай только очевидные фальстарты, повторы, оговорки и ‹звуки›. Слова-паразиты внутри нормальной фразы не трогай. При сомнении — не предлагай.',
  normal: 'Предлагай все фальстарты, повторы, оговорки и ‹звуки›. Слова-паразиты («ну», «вот», «то есть», «как бы») вырезай, только когда они явно пустые — например, в начале фразы или удвоены («вот этот вот»). Содержательные слова не трогай.',
  aggressive: 'Режь плотно, как для динамичного ролика: кроме фальстартов, повторов и оговорок убирай почти все слова-паразиты, затянутые вводные конструкции, служебные фразы и необязательные отступления, если текст после удаления остаётся связным и смысл не теряется.',
};

export const DEFAULT_CARVE_PROMPT = `Ты — опытный монтажёр разговорного видео. Перед тобой расшифровка видеомонолога, разбитая на строки (новая строка — после паузы или конца предложения). В начале каждой строки стоит её номер в формате #123.
Слова в угловых скобках ‹…› — звуки, которые распознаватель услышал, но не включил в основной текст: обычно «э-э», «м-м», обрывки слов, повторно начатые слова.

Найди фрагменты, которые нужно вырезать из видео, чтобы речь стала чистой:
- false_start — фальстарт: человек начал фразу, оборвал и начал заново. Вырезай неудачную попытку, оставляй последнюю удачную.
- repetition — повтор: одно и то же сказано два раза подряд (слово, фраза или целое предложение). Оставляй лучший, обычно последний вариант.
- filler — паразиты и звуки: «э-э», «м-м», «ну», «вот», «как бы», «это самое», «короче», ‹звуки› — только там, где они не несут смысла.
- slip — оговорка: неверное слово, которое сразу исправлено. Вырезай ошибочный вариант (и слова-исправления вроде «то есть», «вернее», если они нужны только для исправления).
- aside — служебные фразы и отступления не для зрителя: «так, сейчас», «стоп, давай заново», «ещё раз», обращения к оператору, проверка звука.

Правила:
1. Главное — фальстарты, повторы и оговорки: это ошибки речи, их нужно найти все.
2. Смысл сказанного не должен измениться. Не удаляй слова, которые несут смысл: определения («безопасные», «опасные»), уточнения, мнение автора («на мой взгляд», «мне кажется»), примеры, связки, нужные для грамматики («это», «он», «что», «который»). Если сомневаешься — не вырезай.
3. После удаления оставшийся текст должен читаться связно и грамматично; проверь это, мысленно прочитав фразу без вырезанного.
4. "text" — ТОЧНАЯ цитата из расшифровки, слово в слово (без номера строки), только то, что нужно удалить. Цитата может продолжаться на следующие строки.
5. "line" — номер строки, в которой цитата начинается.
6. "confidence" — уверенность от 0 до 1, что вырезать нужно и смысл не пострадает.
{strength}

Пример. Строка: «#40 Мы сделали, мы сделали э-э новый, то есть обновлённый сайт.»
Ответ: {"cuts": [{"line": 40, "text": "Мы сделали,", "type": "repetition", "reason": "повтор начала фразы", "confidence": 0.95}, {"line": 40, "text": "э-э новый, то есть", "type": "slip", "reason": "оговорка с исправлением", "confidence": 0.85}]}

Ответь только JSON-объектом без пояснений вокруг:
{"cuts": [{"line": 123, "text": "точная цитата", "type": "false_start|repetition|filler|slip|aside|other", "reason": "кратко, почему", "confidence": 0.9}]}
Если вырезать нечего, верни {"cuts": []}.`;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
const quoteWords = (q: string) => q.replace(/[‹›]/g, ' ').split(/\s+/).map(norm).filter(Boolean);

interface Line { id: number; from: number; to: number; text: string }
/** Transcript lines: break after sentence ends and pauses ≥ 0.6 s. Line id = index of its first word. */
export function makeLines(words: Word[], state: ArrayLike<number>, skipRemoved: boolean): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (let i = 0; i < words.length; i++) {
    if (skipRemoved && state[i]) { continue; }
    const w = words[i];
    const prev = cur ? words[cur.to] : null;
    const brk = !cur || w.para || (prev && (w.start - prev.end >= 0.6 || /[.!?…]["»”)]*$/.test(prev.text)) && cur.text.length > 20) || (cur && cur.text.length > 300);
    if (brk) { cur = { id: i, from: i, to: i, text: '' }; lines.push(cur); }
    cur!.to = i;
    cur!.text += (cur!.text ? ' ' : '') + (w.kind ? `‹${w.text}›` : w.text);
  }
  return lines;
}

/** Locate a quote as a word range, starting near `startWord`. */
export function matchQuote(words: Word[], startWord: number, quote: string, skip: (i: number) => boolean): [number, number] | null {
  const q = quoteWords(quote);
  if (!q.length) return null;
  const nw: string[] = [], idx: number[] = [];
  const lo = Math.max(0, startWord - 40), hi = Math.min(words.length, startWord + 400);
  for (let i = lo; i < hi; i++) { if (skip(i)) continue; const n = norm(words[i].text); if (n) { nw.push(n); idx.push(i); } }
  let best: { s: number; score: number } | null = null;
  const startPos = idx.findIndex((i) => i >= startWord);
  for (let s = 0; s + q.length <= nw.length; s++) {
    let hit = 0;
    for (let k = 0; k < q.length; k++) if (nw[s + k] === q[k] || (q[k].length > 3 && nw[s + k].startsWith(q[k].slice(0, -1)))) hit++;
    const score = hit / q.length - Math.abs(s - Math.max(0, startPos)) * 0.002;   // prefer the stated line
    if (!best || score > best.score) best = { s, score };
  }
  if (!best) return null;
  const need = q.length <= 2 ? 1 : q.length <= 5 ? 0.79 : 0.7;
  if (best.score < need - 0.05) return null;
  return [idx[best.s], idx[best.s + q.length - 1]];
}

export interface CarveOptions {
  strength: Strength; prompt?: string; signal?: AbortSignal; range?: [number, number];
  /** Optional frozen queue config; normal interactive calls still use current settings. */
  config?: LlmConfig;
  onProgress?: (done: number, total: number) => void;
  /** characters streamed from the model so far (all chunks): shows that it is working */
  onActivity?: (chars: number) => void;
  /** live phase of every chunk that is in flight (index = chunk) */
  onPhases?: (phases: (Phase | null)[], total: number) => void;
}

export async function autoCarve(words: Word[], state: ArrayLike<number>, o: CarveOptions): Promise<Suggestion[]> {
  const cfg: LlmConfig = o.config ?? llmConfig();
  const diag = (type: string, message: string, detail?: unknown) => { try { cfg.onEvent?.({ requestId: 'carve', type, message, detail }); } catch { /* diagnostics */ } };
  const all = makeLines(words, state, false);
  const lines = o.range ? all.filter((l) => l.to >= o.range![0] && l.from <= o.range![1]) : all;
  // chunks of lines (~chunkChars/2: answers need room), with 2 lines of overlap for context
  const maxChars = Math.min(8000, Math.max(2500, cfg.chunkChars / 2));
  const chunks: Line[][] = []; let cur: Line[] = [], len = 0;
  for (const l of lines) {
    if (cur.length && len + l.text.length > maxChars) { chunks.push(cur); cur = cur.slice(-2); len = cur.reduce((a, x) => a + x.text.length, 0); }
    cur.push(l); len += l.text.length + 8;
  }
  if (cur.length) chunks.push(cur);
  const system = (o.prompt || DEFAULT_CARVE_PROMPT).replace('{strength}', STRENGTH_TEXT[o.strength]);
  let done = 0;
  o.onProgress?.(0, chunks.length);
  const streamed = new Array(chunks.length).fill(0);
  const phases: (Phase | null)[] = new Array(chunks.length).fill(null);
  const results = await pool(chunks, cfg.parallel, async (ch, ci) => {
    diag('carve.chunk', 'Carve chunk prepared', { index: ci, total: chunks.length, from: ch[0]?.from, to: ch[ch.length - 1]?.to });
    const user = 'Расшифровка:\n' + ch.map((l) => `#${l.id} ${l.text}`).join('\n');
    let parsed: any = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const ans = await chatComplete(cfg, [{ role: 'system', content: system }, { role: 'user', content: user }], {
        signal: o.signal, json: true,
        onText: (t) => { streamed[ci] = t.length; o.onActivity?.(streamed.reduce((a, b) => a + b, 0)); },
        onPhase: (p) => { phases[ci] = p; o.onPhases?.(phases, chunks.length); },
      });
      try { parsed = parseJsonLoose(ans); diag('carve.parse', 'Parsed model cuts', { index: ci, attempt: attempt + 1, cuts: Array.isArray(parsed?.cuts) ? parsed.cuts.length : 0 }); } catch (e) { if (attempt) console.warn('carve: bad JSON', ans.slice(0, 300)); diag('carve.parse_error', 'Could not parse model JSON', { index: ci, attempt: attempt + 1, message: e instanceof Error ? e.message : String(e) }); }
    }
    if (!parsed || !Array.isArray(parsed.cuts)) throw new Error('ИИ-монтаж: модель не вернула корректный список cuts. Повторите этап.');
    done++; phases[ci] = null; o.onProgress?.(done, chunks.length); o.onPhases?.(phases, chunks.length);
    const out: Suggestion[] = [];
    for (const c of (parsed?.cuts || []) as any[]) {
      if (!c || typeof c.text !== 'string') continue;
      const line = +c.line;
      const start = Number.isFinite(line) && line >= 0 && line < words.length ? line : ch[0].id;
      const m = matchQuote(words, start, c.text, () => false);
      if (!m) { diag('carve.quote_mismatch', 'Quote did not match transcript', { index: ci, line, quote: c.text }); console.warn('carve: quote not found', c); continue; }
       diag('carve.quote_match', 'Quote matched transcript', { index: ci, line, from: m[0], to: m[1] });
      if (m[1] - m[0] > 150) continue;
      const type: SuggestionType = (['false_start', 'repetition', 'filler', 'slip', 'aside', 'other'] as const).includes(c.type) ? c.type : 'other';
      const conf = Number.isFinite(+c.confidence) ? +c.confidence : 0.7;
      if (conf < MIN_CONF[o.strength]) continue;
      out.push({ id: uid(), from: m[0], to: m[1], type, reason: String(c.reason || '').slice(0, 300), status: 'pending', confidence: conf });
    }
    return out;
  });
  // merge & dedupe (overlapping chunks may report the same cut)
  const flat = results.flat().sort((a, b) => a.from - b.from || b.to - a.to);
  const out: Suggestion[] = [];
  for (const s of flat) {
    const p = out[out.length - 1];
    if (p && s.from <= p.to) { if (s.to > p.to && s.from === p.from) { p.to = s.to; } else if (s.from >= p.from && s.to <= p.to) continue; else if (s.to > p.to) { out.push({ ...s, from: p.to + 1 }); } continue; }
    out.push(s);
  }
  return out;
}

/** One-word test of the connection. */
/** Short test request with a timing breakdown: when the first byte, the first reasoning token and
 *  the first answer token arrived. Reasoning is what usually makes "time to first token" long. */
export async function testConnection(): Promise<string> {
  const cfg = llmConfig();
  const t0 = performance.now();
  let tFirst = 0, tThink = 0, tText = 0, think = 0;
  const ans = await chatComplete({ ...cfg, maxTokens: null }, [{ role: 'user', content: 'Ответь одним словом: «готово».' }], {
    onPhase: (p) => {
      const t = performance.now() - t0;
      if (p.stage === 'think' || p.stage === 'write') tFirst ||= t;
      if (p.stage === 'think') { tThink ||= t; think = p.thinkChars; }
      if (p.stage === 'write') tText ||= t;
    },
  });
  const total = performance.now() - t0, s = (ms: number) => (ms / 1000).toFixed(1).replace('.', ',') + ' с';
  const parts = [`ответ «${ans.slice(0, 40)}»`, `сервер начал отвечать через ${s(tFirst || total)}`];
  if (think) parts.push(`модель размышляла ${s((tText || total) - tThink)} (${think.toLocaleString('ru-RU')} симв.) — на длинных фрагментах это десятки секунд`);
  parts.push(`первый символ ответа: ${s(tText || total)}, всего ${s(total)}`);
  return parts.join(' · ');
}
