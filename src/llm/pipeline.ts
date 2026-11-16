// Text pipeline on the CARVED transcript (whisper-web's LLM pipeline, adapted): steps run top to
// bottom, each reading the transcript (plain / with output timecodes) or another step's result.
import { chatComplete, llmConfig, splitForLLM, pool, type LlmConfig, type Phase } from './client';

export type LongMode = 'merge' | 'concat' | 'whole';
export interface StepDef { id: string; name: string; enabled: boolean; source: string; map: string; reduce: string; mode: LongMode; custom?: boolean }

export const SYSTEM = 'Ты — внимательный редактор и маркетолог. Ты работаешь с расшифровкой видеомонолога (или с текстом, подготовленным на её основе). ' +
  'Расшифровка получена автоматическим распознаванием речи, поэтому в ней возможны ошибки распознавания, неверно услышанные имена и термины. ' +
  'Строго следуй инструкции, опирайся только на предоставленный текст и ничего не выдумывай. Отвечай на русском языке, если инструкция не требует иного. ' +
  'Если инструкция не требует иного, оформляй ответ в Markdown.';

export const STEP_PRESETS: StepDef[] = [
  {
    id: 'spelling', name: 'Орфография', enabled: true, source: 'plain', mode: 'concat', reduce: '',
    map: 'Исправь в этом тексте орфографию, пунктуацию и очевидные ошибки распознавания речи (неверно услышанные слова, имена и термины — если правильный вариант ясен из контекста). Не меняй формулировки, порядок и стиль, ничего не сокращай, не добавляй и не пересказывай. Сохрани разбивку на абзацы. Выведи только исправленный текст без комментариев.',
  },
  {
    id: 'structured', name: 'Структурированный текст', enabled: true, source: 'prev', mode: 'concat', reduce: '',
    map: 'Преврати этот текст в хорошо читаемый структурированный документ. Разбей его на 8–12 смысловых разделов с содержательными подзаголовками (##), не дробя материал на микроразделы и не создавая отдельный раздел на одну фразу; если текст короткий, разделов может быть меньше. Оформи абзацы; перечисления и последовательности оформляй маркированными или нумерованными списками, где это уместно. Убери слова-паразиты, оговорки, повторы и вводные «вот», «ну», «то есть», «как бы»; сгладь разговорные обороты, но не меняй смысл и не пересказывай. Сохрани всё содержание полностью — все мысли, аргументы, факты, примеры, имена и цифры. Это не краткое содержание: ничего существенного не выбрасывай. Если фрагмент явно искажён распознаванием и его смысл неясен, не встраивай его в авторскую речь: сохрани его в кавычках с пометкой [неразборчиво] или опусти только этот фрагмент, пояснив это в скобках. Не превращай цитаты и реплики в пересказ, сохраняй кавычки. Выведи только текст без комментариев.',
  },
  {
    id: 'chapters', name: 'Главы с таймкодами', enabled: true, source: 'timed', mode: 'merge',
    map: 'Это расшифровка смонтированного видео; в квадратных скобках — таймкоды начала абзацев. Раздели фрагмент на смысловые главы (смена темы или этапа рассказа). Для каждой главы выведи одну строку в формате:\nЧЧ:ММ:СС Название главы\nТаймкод бери из абзаца, с которого начинается глава. Название — 2–6 слов, по существу. Выведи только список глав.',
    reduce: 'Ниже — списки глав для последовательных частей одного видео. Составь единое оглавление для описания на YouTube (обычно 5–15 глав, в зависимости от длины): первая глава начинается с 00:00:00, соседние главы на одну тему объедини, сохрани исходные таймкоды и формат «ЧЧ:ММ:СС Название», расположи по времени. Выведи только оглавление.',
  },
  {
    id: 'keypoints', name: 'Тезисы', enabled: true, source: 'step:structured', mode: 'merge',
    map: 'Выпиши ключевые тезисы и мысли этого текста маркированным списком: каждая мысль — одно-два предложения, по существу, с важными фактами, цифрами и именами.',
    reduce: 'Ниже — тезисы последовательных частей одного видео. Объедини их в один список ключевых тезисов (10–25 пунктов): убери дубли, объедини близкие пункты, сохрани порядок изложения.',
  },
  {
    id: 'summary', name: 'Краткое содержание', enabled: true, source: 'step:structured', mode: 'merge',
    map: 'Составь подробное краткое содержание этого текста: основные темы, ключевые мысли и аргументы, важные факты, имена, цифры и выводы. Сохраняй порядок изложения.',
    reduce: 'Ниже — краткие содержания последовательных частей одного видео. Объедини их в единое связное краткое содержание: начни с резюме в 3–5 предложениях, затем изложи основное содержание по разделам с подзаголовками. Убери повторы.',
  },
  {
    id: 'youtube', name: 'Промо: YouTube', enabled: true, source: 'step:summary', mode: 'whole', reduce: '',
    map: 'На основе этого краткого содержания видео подготовь материалы для публикации на YouTube:\n## Варианты названия\n5 вариантов: цепляющие, честные (без кликбейта, которого нет в видео), до 70 символов.\n## Описание\n2–3 абзаца: о чём видео и что зритель из него вынесет; первая фраза должна цеплять.\n## Теги\n15–25 тегов через запятую.\n## Хэштеги\n3–5 хэштегов.',
  },
  {
    id: 'post', name: 'Промо: пост для соцсетей', enabled: true, source: 'step:summary', mode: 'whole', reduce: '',
    map: 'На основе этого краткого содержания видео напиши анонс для Telegram-канала и соцсетей: цепляющее начало, 3–5 главных мыслей из видео (списком или короткими абзацами), призыв посмотреть. Живой разговорный тон автора, без канцелярита и штампов, до 1200 знаков. Уместные эмодзи — не больше 3–4.',
  },
  {
    id: 'shorts', name: 'Моменты для Shorts / Reels', enabled: true, source: 'timed', mode: 'merge',
    map: 'Это расшифровка смонтированного видео с таймкодами абзацев. Найди 2–4 самостоятельных фрагмента по 20–60 секунд, которые сработают как короткие вертикальные ролики (яркая мысль, история, неожиданный вывод — понятные без контекста). Для каждого: таймкоды начала и конца (ЧЧ:ММ:СС–ЧЧ:ММ:СС), заголовок-крючок для обложки и почему этот момент зацепит.',
    reduce: 'Ниже — кандидаты в короткие ролики из разных частей одного видео. Выбери 5–8 самых сильных, сохрани формат (таймкоды, заголовок-крючок, почему зацепит) и расположи по силе.',
  },
  { id: 'custom', name: 'Свой запрос', enabled: false, custom: true, source: 'step:structured', mode: 'merge', map: '', reduce: '' },
];

export const SOURCE_LABEL = (s: string, steps: StepDef[]) =>
  s === 'plain' ? 'текст результата' : s === 'timed' ? 'текст с таймкодами результата' : s === 'prev' ? 'предыдущий этап'
  : 'результат «' + (steps.find((x) => 'step:' + x.id === s)?.name || '?') + '»';

const KEY = 'carver:pipeline';
export function loadSteps(): StepDef[] {
  let saved: any[] | null = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* */ }
  if (!Array.isArray(saved)) return STEP_PRESETS.map((p) => ({ ...p }));
  const out: StepDef[] = [];
  for (const s of saved) {
    const p = STEP_PRESETS.find((x) => x.id === s.id) || (s.custom ? STEP_PRESETS.find((x) => x.custom) : null);
    if (p && !out.some((x) => x.id === s.id)) out.push({ ...p, ...s });
  }
  for (const p of STEP_PRESETS) if (!out.some((x) => x.id === p.id)) out.push({ ...p });
  return out;
}
export function saveSteps(steps: StepDef[]) { localStorage.setItem(KEY, JSON.stringify(steps)); }

export type ProjectPrompts = Record<string, { map: string; reduce?: string }>;

/** Steps as they apply to one project: the global step list with the project's own prompt overrides.
 *  Prompts are project content (they shape a project's texts), so editing one never silently changes another project. */
export function projectSteps(base: readonly StepDef[], prompts?: ProjectPrompts | null): StepDef[] {
  return base.map((s) => {
    const o = prompts?.[s.id];
    return o ? { ...s, map: o.map ?? s.map, reduce: o.reduce ?? s.reduce } : { ...s };
  });
}

const genericMerge = (instruction: string) => 'Ниже — ответы на одну и ту же инструкцию, полученные для последовательных частей одного длинного текста. ' +
  'Составь из них один итоговый ответ на эту инструкцию так, как если бы она выполнялась для всего текста целиком: объедини материал, убери повторы и дубли, ' +
  `соблюдай требования инструкции (например, к количеству пунктов и формату).\n\nИнструкция: «${instruction}»`;

export async function processText(cfg: LlmConfig, source: string, step: StepDef, o: { signal?: AbortSignal; onText?: (t: string) => void; onStatus?: (s: string) => void; onPhase?: (p: Phase | null) => void }) {
  const stepModel = cfg.stepModels?.[step.id]?.trim();
  const stepCfg = stepModel ? { ...cfg, model: stepModel } : cfg;
  try { cfg.onEvent?.({ requestId: 'pipeline', type: 'pipeline.source', message: 'Pipeline source selected', detail: { step: step.id, mode: step.mode, chars: source.length, model: stepCfg.model } }); } catch { /* diagnostics */ }
  const chunks = step.mode === 'whole' ? [source.trim()] : splitForLLM(source, cfg.chunkChars), n = chunks.length;
  const msgs = (user: string) => [{ role: 'system' as const, content: SYSTEM }, { role: 'user' as const, content: user }];
  o.onStatus?.(n > 1 ? `части: 0 из ${n}` : 'выполняется');
  const partial = new Array(n).fill('');
  let done = 0;
  await pool(chunks, cfg.parallel, async (c, i) => {
    try { cfg.onEvent?.({ requestId: 'pipeline', type: 'pipeline.map', message: 'Pipeline map chunk', detail: { step: step.id, index: i, total: n, chars: c.length } }); } catch { /* diagnostics */ }
    const user = `${step.map.trim()}\n\n` + (n > 1 ? `Это часть ${i + 1} из ${n} (длинный текст разбит на части).\n\n` : '') + `Текст:\n"""\n${c}\n"""`;
    partial[i] = await chatComplete(stepCfg, msgs(user), { signal: o.signal, onPhase: o.onPhase, onText: (t) => { partial[i] = t; o.onText?.(partial.filter(Boolean).join('\n\n')); } });
    done++; if (n > 1) o.onStatus?.(`части: ${done} из ${n}`);
  });
  if (n === 1 || step.mode === 'concat') { const result = partial.join('\n\n').trim(); try { cfg.onEvent?.({ requestId: 'pipeline', type: 'pipeline.result', message: 'Pipeline map result', detail: { step: step.id, chars: result.length } }); } catch { /* diagnostics */ } return result; }
  const reduce = step.reduce.trim() || genericMerge(step.map.trim());
  const limit = cfg.chunkChars * 1.5;
  let parts = partial.filter((p) => p.trim());
  for (let round = 1; parts.length > 1; round++) {
    const groups: string[][] = []; let g: string[] = [], len = 0;
    for (const p of parts) { if (g.length && len + p.length > limit && round < 4) { groups.push(g); g = []; len = 0; } g.push(p); len += p.length + 20; }
    if (g.length) groups.push(g);
    const out: string[] = [];
    for (let k = 0; k < groups.length; k++) {
      const last = groups.length === 1;
      o.onStatus?.(last ? 'итоговое объединение' : `объединение: этап ${round}, группа ${k + 1} из ${groups.length}`);
      if (last) o.onText?.('');
      const user = `${reduce}\n\nМатериалы (результаты обработки последовательных частей одной записи):\n"""\n` + groups[k].map((p, j) => `### Часть ${j + 1}\n${p}`).join('\n\n') + '\n"""';
      const merged = await chatComplete(stepCfg, msgs(user), { signal: o.signal, onPhase: o.onPhase, onText: (t) => { if (last) o.onText?.(t); } });
      try { cfg.onEvent?.({ requestId: 'pipeline', type: 'pipeline.merge', message: 'Pipeline merge result', detail: { step: step.id, round, group: k, groups: groups.length, chars: merged.length } }); } catch { /* diagnostics */ }
      out.push(merged);
    }
    parts = out;
  }
  return (parts[0] || '').trim();
}

/** Run the enabled steps in order. `transcript(kind)` gives the carved transcript text. */
export async function runPipeline(steps: StepDef[], only: string[] | null, transcript: (k: 'plain' | 'timed') => string,
  results: Map<string, string>, o: { signal?: AbortSignal; onStep?: (id: string, status: string, text: string) => void; onPhase?: (p: Phase | null) => void; onEvent?: LlmConfig['onEvent'] }) {
  const cfg: LlmConfig = { ...llmConfig(), onEvent: o.onEvent };
  const diag = (type: string, message: string, detail?: unknown) => { try { cfg.onEvent?.({ requestId: 'pipeline', type, message, detail }); } catch { /* diagnostics */ } };
  const run = steps.filter((s) => (only ? only.includes(s.id) : s.enabled) && s.map.trim());
  for (const s of run) {
    const i = steps.indexOf(s);
    let src = '';
    if (s.source === 'plain' || s.source === 'timed') src = transcript(s.source);
    else if (s.source === 'prev') { for (let j = i - 1; j >= 0; j--) { const r = results.get(steps[j].id); if (r && (run.includes(steps[j]) || r)) { src = r; break; } } }
    else src = results.get(s.source.slice(5)) || '';
    if (!src.trim()) { o.onStep?.(s.id, 'error', `Нет исходного текста (${SOURCE_LABEL(s.source, steps)}).`); continue; }
    o.onStep?.(s.id, 'running', '');
    try {
      const text = await processText(cfg, src, s, { signal: o.signal, onPhase: o.onPhase, onText: (t) => o.onStep?.(s.id, 'running', t) });
      results.set(s.id, text);
      o.onStep?.(s.id, 'done', text);
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      o.onStep?.(s.id, 'error', e.message || String(e));
    }
  }
}
