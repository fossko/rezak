import { useState } from 'react';
import { S, useStore } from '../store';
import { autoCarve, TYPE_LABELS, type Strength } from '../llm/carve';
import { llmConfigured, loadLlmSettings, saveLlmSettings } from '../llm/client';
import { ModelPicker } from './ModelPicker';
import { TaskInline } from './TaskInline';
import { describePhases } from '../llm/phase';
import type { Phase } from '../llm/client';
import type { Suggestion, SuggestionType } from '../lib/types';
import { hub } from './hub';
import { clock } from '../lib/util';
import { runPipelineUI } from './TextsPanel';

const STRENGTH_KEY = 'carver:carve';
export const loadOpts = () => ({ strength: 'normal' as Strength, auto: true, walkAway: false, fastStrength: 'careful' as Strength,
  ...JSON.parse(localStorage.getItem(STRENGTH_KEY) || '{}') });
export const STRENGTH_LABEL: Record<Strength, string> = { careful: 'осторожно', normal: 'обычно', aggressive: 'плотно' };

/** AI carving of the whole text (or the selection). Returns the number of fragments found, or null on error/stop. */
export async function runCarve(scope: 'all' | 'selection', strength: Strength, autoApply: boolean, opts: { quiet?: boolean; throwOnError?: boolean } = {}): Promise<number | null> {
  const p = S.project; if (!p || !p.words.length) return null;
  const range = scope === 'selection' ? S.selRange() || undefined : undefined;
  const ac = new AbortController();
  let done = 0, total = 0, phases: (Phase | null)[] = [];
  const status = () => {
    const part = total > 1 ? `фрагмент ${Math.min(done + 1, total)} из ${total}` : 'текст';
    const ph = describePhases(phases);
    S.setTask({ kind: 'llm', frac: total ? done / total : 0, cancel: () => ac.abort(), text: `ИИ · ${part}${ph ? ' · ' + ph : '…'}` });
  };
  status();
  const ticker = setInterval(status, 1000);   // seconds keep counting while nothing arrives
  try {
    const list = await autoCarve(p.words, S.wordState, {
      strength, range, signal: ac.signal,
      onProgress: (d, n) => { done = d; total = n; status(); },
      onPhases: (p, n) => { phases = p; total = n; },
    });
    clearInterval(ticker);
    S.setTask(null);
    S.addSuggestions(list, autoApply);
    if (!opts.quiet) S.toast(list.length ? `ИИ нашёл ${list.length} фрагментов${autoApply ? ' и вырезал их' : ''}. Проверьте их в списке.` : 'ИИ не нашёл, что вырезать.', 'ok');
    return list.length;
  } catch (e: any) {
    clearInterval(ticker);
    S.setTask(null);
    if (opts.throwOnError) throw e;
    if (e?.name === 'AbortError') S.toast('ИИ-монтаж остановлен', 'info'); else S.toast('Ошибка ИИ: ' + (e.message || e), 'err');
    return null;
  }
}

function SuggItem({ sg }: { sg: Suggestion }) {
  const p = S.project!;
  const text = p.words.slice(sg.from, sg.to + 1).map((w) => (w.kind ? `‹${w.text}›` : w.text)).join(' ');
  const before = p.words.slice(Math.max(0, sg.from - 5), sg.from).map((w) => w.text).join(' ');
  const after = p.words.slice(sg.to + 1, sg.to + 6).map((w) => w.text).join(' ');
  const go = () => { S.setSelection({ a: sg.from, b: sg.to }); hub.scrollToWord?.(sg.from, true); hub.player?.seekSrc(p.words[sg.from].start); };
  const listen = (e: React.MouseEvent) => { e.stopPropagation(); hub.player?.seekSrc(Math.max(0, p.words[sg.from].start - 2.5)); hub.player?.play(); };
  return (
    <div className={'sugg ' + sg.status} onClick={go}>
      <div className="row">
        <span className={'tag ' + sg.type}>{TYPE_LABELS[sg.type]}</span>
        <span className="dim mono" style={{ fontSize: 11.5 }}>{clock(p.words[sg.from].start)}</span>
        {sg.confidence != null && <span className="dim" style={{ fontSize: 11.5 }} title="Уверенность модели">{Math.round(sg.confidence * 100)}%</span>}
        <span className="grow" />
        <button className="small ghost" title="Послушать склейку" onClick={listen}>▶</button>
        {sg.status !== 'accepted' && <button className="small" title="Вырезать" onClick={(e) => { e.stopPropagation(); S.setSuggestionStatus([sg.id], 'accepted'); }}>✓</button>}
        {sg.status !== 'rejected' && <button className="small" title="Оставить в записи" onClick={(e) => { e.stopPropagation(); S.setSuggestionStatus([sg.id], 'rejected'); }}>✕</button>}
      </div>
      <div className="q"><span className="dim">…{before} </span><s>{text}</s><span className="dim"> {after}…</span></div>
      {sg.reason && <div className="hint">{sg.reason}</div>}
    </div>
  );
}

export function AiPanel() {
  const p = useStore((s) => s.project!);
  useStore((s) => s.editRev);
  const task = useStore((s) => s.task);
  const [o, setO] = useState(loadOpts());
  const [filter, setFilter] = useState<'all' | 'pending' | SuggestionType>('all');
  const upd = (x: Partial<typeof o>) => { const n = { ...o, ...x }; setO(n); localStorage.setItem(STRENGTH_KEY, JSON.stringify(n)); };
  const configured = llmConfigured();
  const busy = !!task && task.kind !== 'models';
  const sel = S.selRange();
  const list = p.suggestions.filter((s) => filter === 'all' || (filter === 'pending' ? s.status === 'pending' : s.type === filter));
  const counts: Partial<Record<SuggestionType, number>> = {};
  for (const s of p.suggestions) counts[s.type] = (counts[s.type] || 0) + 1;
  const pending = p.suggestions.filter((s) => s.status === 'pending');
  const accepted = p.suggestions.filter((s) => s.status === 'accepted');

  if (!configured) return (
    <div className="panel">
      <div>ИИ-монтаж находит фальстарты, повторы, оговорки и слова-паразиты по тексту расшифровки и вырезает их.</div>
      <div className="hint tip">Нужен доступ к языковой модели (OpenAI, DeepSeek, OpenRouter, локальная Ollama и т. п.).</div>
      <button className="primary" onClick={() => S.openSettings('llm')}>Настроить подключение…</button>
    </div>
  );
  return (
    <div className="panel">
      <div className="row wrap">
        <label className="row" style={{ gap: 6 }}>Строгость
          <select value={o.strength} onChange={(e) => upd({ strength: e.target.value as Strength })}>
            <option value="careful">осторожно</option><option value="normal">обычно</option><option value="aggressive">плотно</option>
          </select>
        </label>
        <label className="row" style={{ gap: 4 }} title="Сразу вырезать найденное (можно отменить по одному или все)">
          <input type="checkbox" checked={o.auto} onChange={(e) => upd({ auto: e.target.checked })} /> вырезать сразу
        </label>
      </div>
      <div className="col" style={{ gap: 4 }}>
        <span className="muted" style={{ fontSize: 13 }}>Модель</span>
        <ModelPicker settings={loadLlmSettings()} onChange={(model) => {
          const settings = loadLlmSettings();
          saveLlmSettings(settings.chatGptPlan ? { ...settings, chatGptModel: model } : { ...settings, model });
          S.bump();
        }} />
      </div>
      <div className="row wrap">
        <button className="primary" disabled={busy || !p.words.length} onClick={() => runCarve('all', o.strength, o.auto)}>
          {task?.kind === 'llm' ? <><span className="spin" /> ИИ работает…</> : 'Найти лишнее во всём тексте'}</button>
        <button disabled={busy || !sel} onClick={() => runCarve('selection', o.strength, o.auto)} title="Только в выделенном фрагменте">в выделенном</button>
      </div>
      <button disabled={busy || !p.words.length} onClick={async () => { if (await runCarve('all', o.strength, true) != null) await runPipelineUI(null); }}
        title="ИИ-монтаж с автоматическим применением, затем все отмеченные этапы во вкладке «Тексты»">⚡ Монтаж + тексты одной кнопкой</button>
      <TaskInline kinds={['llm', 'pipeline']} />
      <label className="row" style={{ gap: 6 }} title="Открыл файл — ушёл: после расшифровки ИИ сам вырежет лишнее и подготовит тексты">
        <input type="checkbox" checked={o.walkAway} onChange={(e) => upd({ walkAway: e.target.checked })} /> после расшифровки — сразу ИИ-монтаж и тексты
      </label>
      <label className="row" style={{ gap: 6 }} title="Строгость ИИ-монтажа, когда файл перетащен на правую половину окна">
        ⚡ Быстрый путь (правая половина окна):
        <select value={o.fastStrength} onChange={(e) => upd({ fastStrength: e.target.value as Strength })}>
          <option value="careful">осторожно</option><option value="normal">обычно</option><option value="aggressive">плотно</option>
        </select>
      </label>
      <div className="hint"><a href="#" onClick={(e) => { e.preventDefault(); S.openSettings('llm'); }}>Настройки подключения</a></div>

      {p.suggestions.length > 0 && <>
        <div className="row wrap" style={{ marginTop: 6 }}>
          <b className="grow">Найдено: {p.suggestions.length}</b>
          <span className="dim" style={{ fontSize: 12.5 }}>вырезано {accepted.length}, ждут {pending.length}</span>
        </div>
        <div className="row wrap">
          <button className="small" disabled={!pending.length} onClick={() => S.setSuggestionStatus(pending.map((s) => s.id), 'accepted')}>Вырезать все ждущие</button>
          <button className="small" disabled={!pending.length} onClick={() => S.setSuggestionStatus(pending.map((s) => s.id), 'rejected')}>Отклонить ждущие</button>
          <button className="small ghost danger" onClick={() => { if (confirm('Убрать все предложения ИИ и вернуть вырезанное ими?')) S.clearSuggestions(); }}>Очистить</button>
        </div>
        <div className="row wrap" style={{ gap: 4 }}>
          {(['all', 'pending', ...Object.keys(counts)] as const).map((f) => (
            <button key={f} className={'small ' + (filter === f ? '' : 'ghost')} onClick={() => setFilter(f as any)}>
              {f === 'all' ? 'все' : f === 'pending' ? `ждут (${pending.length})` : `${TYPE_LABELS[f as SuggestionType]} (${counts[f as SuggestionType]})`}
            </button>
          ))}
        </div>
        <div className="col" style={{ gap: 6 }}>{list.map((sg) => <SuggItem key={sg.id} sg={sg} />)}</div>
      </>}
    </div>
  );
}
