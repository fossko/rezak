// Human-readable status of LLM requests in flight.
import type { Phase } from './client';

const n = (x: number) => x.toLocaleString('ru-RU');
const sec = (ms: number) => Math.max(0, Math.round(ms / 1000));

/** One line for one or more parallel requests, e.g.
 *  «модель размышляет · 3 400 симв. · 12 с», «ожидание ответа сервера · 9 с (загрузка модели?)». */
export function describePhases(phases: (Phase | null)[]): string {
  const act = phases.filter(Boolean) as Phase[];
  if (!act.length) return '';
  const now = performance.now();
  const retry = act.find((p) => p.stage === 'retry');
  if (retry) return `сервер ответил ${retry.reason || 'ошибкой'} — повтор через ${retry.retryIn} с`;
  const write = act.filter((p) => p.stage === 'write'), think = act.filter((p) => p.stage === 'think');
  const thinkChars = act.reduce((a, p) => a + p.thinkChars, 0), textChars = act.reduce((a, p) => a + p.textChars, 0);
  if (write.length) return `пишет ответ · ${n(textChars)} симв.` + (thinkChars ? ` (размышления: ${n(thinkChars)})` : '');
  if (think.length) return `модель размышляет · ${n(thinkChars)} симв. · ${sec(now - Math.min(...think.map((p) => p.since)))} с`;
  const w = sec(now - Math.min(...act.map((p) => p.since)));
  return `ожидание ответа сервера · ${w} с` + (w >= 8 ? ' (модель загружается или очередь у сервиса)' : '');
}
