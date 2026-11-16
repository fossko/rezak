// node tests/profanity.test.ts — detector sanity: hits, non-hits, phrases, custom list, exclusions.
import { findProfanity, profCompile } from '../src/lib/profanity.ts';
const W = (s: string) => s.split(' ').map((text, i) => ({ text, start: i, end: i + 0.5 }));
let fail = 0;
const t = (text: string, want: string[], o = { extra: '', exclude: '' }) => {
  const ws = W(text), got = findProfanity(ws as any, o).map((h) => ws.slice(h.from, h.to + 1).map((w) => w.text).join(' '));
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + `«${text}» → ${JSON.stringify(got)}`);
};
t('это просто пиздец, ребята', ['пиздец,']);
t('страхуй себе небо и хлеб на корабле', []);
t('ну блять опять', ['блять']);
t('он мне сказал ёб твою мать прямо', ['ёб твою мать']);
t('да на хуй это', ['на хуй']);
t('заебал уже этот долбоёб', ['заебал', 'долбоёб']);
t('ну б**дь серьёзно', ['б**дь']);
t('это сука такая', [], { extra: '', exclude: '' });
t('это сука такая', ['сука'], { extra: 'сук*, мудак*', exclude: '' });
t('мудаки кругом', ['мудаки'], { extra: 'сук*, мудак*', exclude: '' });
t('хули ты хочешь', [], { extra: '', exclude: 'хули' });
t('пидор и пидар', ['пидор', 'пидар'], { extra: '/^пид[оа]р/', exclude: '' });
const bad = profCompile('сук*, /[/, ***, нормально').bad;
console.log(JSON.stringify(bad) === JSON.stringify(['/[/', '***']) ? 'ok   ' : 'FAIL ', 'invalid entries reported:', JSON.stringify(bad));
if (JSON.stringify(bad) !== JSON.stringify(['/[/', '***'])) fail++;
process.exit(fail ? 1 : 0);
