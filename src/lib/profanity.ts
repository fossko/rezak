// Russian obscenity (мат) detector — ported from whisper-web (word-accurate-stt.html, @@PROFANITY).
// Core roots: хуй, пизд, еб/ёб, бля(дь), in every inflection and with prefixes. Works on tokens, so
// «страхуй», «корабля», «небо», «тебе», «хлеб» are not hits.
import type { Word } from './types';

export const PROF_TOKEN_RE = /[\p{L}*]+/gu;
export const profNorm = (w: string) => w.toLowerCase().replace(/ё/g, 'е');
// Prefixes are anchored at the start of the word; consonant prefixes before «еб» need ъ/ь
// (съебаться, въебать, отъебись) — otherwise «себе», «веб» would match.
const PROF_RULES = [
  { id: 'хуй', re: /^(?:на|по|ни|не|до|за|от|о|а|об|при|раз|рас|вы|у|под|с|из|ис|в)?ху(?:[йеяюи]|л[иь]$)/ },
  { id: 'пизд', re: /п[ие]зд/ },
  { id: 'бля', re: /^(?:вы|по|за|на|рас|раз|у)?бл(?:я+(?:$|д|т)|$)/ },
  { id: 'еб', re: /^(?:вы|за|на|по|у|до|пере|недо|при|про|о|об|обо|подо|ото|не|ни|раз|рас){0,2}(?:съ|сь|въ|вь|взъ|взь|отъ|оть|разъ|разь|расъ|рась|подъ|подь|объ|обь|изъ|изь|надъ|надь)?еб/ },
  { id: 'еб', re: /(?:долбо|мозго|дуро|хуе|поху|шизо)еб/ },
];
// «ёб твою мать», «еб вашу мать», «ёб твою в душу мать», «ебёна мать» — the whole phrase is removed.
const PROF_PHRASE_MID = /^(?:вашу|твою|твоя|его|ее|их|нашу|мою|всех|вас|тебя|в|через|за|ногу|душу|бога)$/;
const PROF_PHRASE_END = /^(?:мать|матери|мамашу|маму|мамку|бога|душу|налево|кочерыжку)$/;
// prefix written as a separate word by the recogniser: «вы ебу», «на хуй», «за ебал», «по пизде»
const PROF_LOOSE_PREFIX = /^(?:вы|за|на|по|от|до|раз|рас|при|под|об|обо|о|у|с|съ|из|вз|пере|недо|про|в|во|не|ни)$/;
const PROF_ROOT_START = /^(?:е|ху|пизд|пезд)/;
// «твою мать» without a recognised first word: Whisper often softens «ёб» to «ё», «ее», «но»…
const PROF_ORPHAN_MID = /^(?:твою|вашу|его|ее|их|нашу)$/;

/** Base list shown to the user (always on). */
export const BASE_LIST: { root: string; examples: string }[] = [
  { root: 'хуй', examples: 'хуйня, нахуй, охуеть, нихуя…' },
  { root: 'пизд', examples: 'пиздец, спиздил, распиздяй…' },
  { root: 'еб / ёб', examples: 'ебать, заебал, съебался, уёбок, долбоёб…' },
  { root: 'бля', examples: 'блять, блядь, выблядок…' },
  { root: '«ёб твою мать»', examples: 'и другие фразы целиком' },
  { root: 'б**дь', examples: 'слова, записанные со звёздочками' },
];

/** User list: entries separated by commas / newlines; «*» = any letters; «/regex/flags» allowed. */
export function profCompile(lines: string): { res: RegExp[]; bad: string[] } {
  const res: RegExp[] = [], bad: string[] = [];
  for (let raw of String(lines || '').split(/[\n,;]+/)) {
    raw = raw.trim();
    if (!raw || raw.startsWith('#')) continue;
    try {
      const m = /^\/(.+)\/([a-z]*)$/.exec(raw);
      if (m) { res.push(new RegExp(m[1], m[2].replace(/[gy]/g, '') + (m[2].includes('u') ? '' : 'u'))); continue; }
      if (raw.startsWith('/')) throw new Error('unterminated regexp');
      const w = profNorm(raw).replace(/[^\p{L}*]/gu, '');
      if (!w.replace(/\*/g, '')) { bad.push(raw); continue; }
      res.push(new RegExp('^' + w.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\p{L}*') + '$', 'u'));
    } catch { bad.push(raw); }
  }
  return { res, bad };
}

type Matcher = ((word: string) => string | null) & { orphan?: boolean };
export function profMatcher({ extra = '', exclude = '' } = {}): Matcher {
  const ex = profCompile(extra).res, no = profCompile(exclude).res;
  const fn: Matcher = (word: string) => {
    const w = profNorm(word);
    if (!w || no.some((r) => r.test(w))) return null;
    if (w.includes('*')) return /\p{L}/u.test(w) || w.length >= 3 ? '***' : null;   // «б**дь», «п***ц», «***»
    for (const r of PROF_RULES) if (r.re.test(w)) return r.id;
    if (ex.some((r) => r.test(w))) return 'свой';
    return null;
  };
  fn.orphan = !no.some((r) => r.test('мать'));   // «мать» in the exclusions turns off the «(…) твою мать» rule
  return fn;
}

/** tokens → [{ from, to, kind }] (inclusive token indices). Adjacent hits («бля, пиздец») are joined;
 *  «ёб твою мать» is extended to the end of the phrase. */
export function profScan(tokens: { text: string }[], match: Matcher) {
  const hits: { from: number; to: number; kind: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let kind = match(tokens[i].text), from = i, to = i;
    if (!kind) {
      if (match.orphan === false || !PROF_ORPHAN_MID.test(profNorm(tokens[i].text)) || !tokens[i + 1] || profNorm(tokens[i + 1].text) !== 'мать') continue;
      kind = 'фраза'; to = i + 1;
      const p = tokens[i - 1] && profNorm(tokens[i - 1].text);
      if (p && p.length <= 3 && !match(p) && !(hits.length && hits[hits.length - 1].to >= i - 1)) from = i - 1;
    } else if (i > 0 && PROF_ROOT_START.test(profNorm(tokens[i].text)) && PROF_LOOSE_PREFIX.test(profNorm(tokens[i - 1].text))
      && !(hits.length && hits[hits.length - 1].to >= i - 1)) from = i - 1;
    if (kind === 'еб' || kind === '***') {
      for (let j = i + 1; j < Math.min(tokens.length, i + 5); j++) {
        const w = profNorm(tokens[j].text);
        if (PROF_PHRASE_END.test(w)) { to = j; if (/^ма/.test(w)) break; }
        else if (!PROF_PHRASE_MID.test(w)) break;
      }
    }
    const last = hits[hits.length - 1];
    if (last && last.to >= from - 1) { last.to = Math.max(last.to, to); if (!last.kind.split('+').includes(kind)) last.kind += '+' + kind; }
    else hits.push({ from, to, kind });
    i = to;
  }
  return hits;
}

export interface ProfHit { from: number; to: number; kind: string }

/** Hits in the transcript as WORD index ranges (Whisper words and wav2vec2 sounds; fillers skipped). */
export function findProfanity(words: Word[], opts: { extra: string; exclude: string }): ProfHit[] {
  const match = profMatcher(opts);
  const toks: { text: string; w: number }[] = [];
  words.forEach((w, i) => { if (w.kind === 'filler') return; for (const m of w.text.matchAll(PROF_TOKEN_RE)) toks.push({ text: m[0], w: i }); });
  const hits = profScan(toks, match).map((h) => ({ from: toks[h.from].w, to: toks[h.to].w, kind: h.kind }));
  const out: ProfHit[] = [];
  for (const h of hits) { const p = out[out.length - 1]; if (p && h.from <= p.to + 1) { p.to = Math.max(p.to, h.to); } else out.push({ ...h }); }
  return out;
}

/** «хуйня» → «х****» (for subtitles of a muted word). */
export const maskWord = (t: string) => t.replace(/[\p{L}]+/gu, (w) => w[0] + '*'.repeat(Math.max(1, w.length - 1)));
