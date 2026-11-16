import { useState } from 'react';
import { S, useStore } from '../store';
import { loadSteps, saveSteps, runPipeline, projectSteps, STEP_PRESETS, SOURCE_LABEL, type StepDef } from '../llm/pipeline';
import { llmConfigured } from '../llm/client';
import { outWords, makePlainText, makeTimedText } from '../export/subs';
import { saveBlob } from '../lib/util';
import { TaskInline } from './TaskInline';
import { TextEditor } from './TextEditor';
import { describePhases } from '../llm/phase';
import type { Phase } from '../llm/client';

const status: Record<string, { s: string; t: string }> = {};   // live status per step (not persisted)

export async function runPipelineUI(only: string[] | null) {
  const p = S.project, edl = S.edl; if (!p || !edl) return;
  const steps = projectSteps(loadSteps(), p.prompts);
  const ws = outWords(p.words, S.wordState, edl, undefined, S.composite?.srcToOut);
  const transcript = (k: 'plain' | 'timed') => (k === 'plain' ? makePlainText(ws) : makeTimedText(ws));
  const results = new Map(p.pipeline.map((r) => [r.stepId, r.text]));
  const ac = new AbortController();
  const n = steps.filter((s) => (only ? only.includes(s.id) : s.enabled)).length;
  let done = 0, cur = 'запуск', phase: Phase | null = null;
  const show = () => {
    const ph = describePhases([phase]);
    S.setTask({ kind: 'pipeline', frac: done / Math.max(1, n), text: `Тексты: ${cur}${ph ? ' · ' + ph : '…'}`, cancel: () => ac.abort() });
  };
  show();
  const ticker = setInterval(show, 1000);
  try {
    await runPipeline(steps, only, transcript, results, {
      signal: ac.signal,
      onPhase: (p) => { phase = p; },
      onStep: (id, st, text) => {
        status[id] = { s: st, t: text };
        const step = steps.find((x) => x.id === id)!;
        cur = step.name;
        if (st === 'done') {
          done++;
          p.pipeline = [...p.pipeline.filter((r) => r.stepId !== id), { stepId: id, text, at: Date.now() }];
          S.scheduleSave();
        }
        if (st !== 'running' || !text) show(); else S.bump();
      },
    });
    clearInterval(ticker);
    S.setTask(null);
    const errs = Object.values(status).filter((x) => x.s === 'error').length;
    S.toast(errs ? `Тексты готовы, с ошибками: ${errs}` : 'Тексты готовы', errs ? 'err' : 'ok');
  } catch (e: any) {
    clearInterval(ticker);
    S.setTask(null);
    S.toast(e?.name === 'AbortError' ? 'Обработка текстов остановлена' : 'Ошибка: ' + (e.message || e), e?.name === 'AbortError' ? 'info' : 'err');
  }
}

function StepRow({ st, i, steps, onUpdate, onEdit }: {
  st: StepDef; i: number; steps: StepDef[]; onUpdate: (id: string, patch: Partial<StepDef>) => void; onEdit: (stepId: string) => void;
}) {
  const p = S.project!;
  const [edit, setEdit] = useState(false);
  const [open, setOpen] = useState(false);
  const res = p.pipeline.find((r) => r.stepId === st.id);
  const live = status[st.id];
  const text = live && live.s === 'running' ? live.t : res?.text || '';
  // Structural fields (enabled / source / mode / name) live in the global step list; prompts live in the project.
  const upd = (x: Partial<StepDef>) => onUpdate(st.id, x);
  // Prompts are project content: editing one here changes this project only (see projectSteps).
  const updPrompt = (x: { map?: string; reduce?: string }) => S.setPipelinePrompt(st.id, x);
  const hasPrompt = !!p.prompts?.[st.id];
  const preset = STEP_PRESETS.find((x) => x.id === st.id);
  const sources = ['plain', 'timed', ...(i > 0 ? ['prev'] : []), ...steps.slice(0, i).map((s) => 'step:' + s.id)];
  const busy = !!S.task && S.task.kind !== 'models';
  const generated = !!(res?.text && live?.s !== 'running');
  return (
    <div className="card col" style={{ padding: 10, gap: 6 }}>
      <div className="row">
        <input type="checkbox" checked={st.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
        <b className="grow" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>{i + 1}. {st.name}</b>
        {live?.s === 'running' && <span className="dim">…</span>}
        {live?.s === 'error' && <span className="err" title={live.t}>ошибка</span>}
        {res && live?.s !== 'running' && <span className="ok" title={new Date(res.at).toLocaleString('ru-RU')}>✓</span>}
        <button className="small ghost" title="Запустить только этот этап" data-run-step={st.id} disabled={busy || !st.map.trim()} onClick={() => { setOpen(true); runPipelineUI([st.id]); }}>▶</button>
        <button className="small ghost" title="Настроить запрос" onClick={() => setEdit(!edit)}>⚙</button>
      </div>
      <div className="row">
        <span className="hint grow">из: {SOURCE_LABEL(st.source, steps)}{hasPrompt ? ' · свой запрос в проекте' : ''}</span>
        <button className={'small' + (generated ? '' : ' ghost')} title={generated ? 'Открыть большой редактор текста' : 'Текст ещё не сгенерирован'} disabled={!generated} data-edit-text={st.id} onClick={() => onEdit(st.id)}>✎ Редактировать</button>
      </div>
      {edit && (
        <div className="col" style={{ gap: 6 }}>
          {st.custom && <input value={st.name} onChange={(e) => upd({ name: e.target.value })} />}
          <label className="col" style={{ gap: 3 }}>Исходный текст
            <select value={st.source} onChange={(e) => upd({ source: e.target.value })}>{sources.map((s) => <option key={s} value={s}>{SOURCE_LABEL(s, steps)}</option>)}</select>
          </label>
          <label className="col" style={{ gap: 3 }}>Запрос<textarea rows={6} value={st.map} onChange={(e) => updPrompt({ map: e.target.value })} /></label>
          <label className="col" style={{ gap: 3 }}>Длинный текст
            <select value={st.mode} onChange={(e) => upd({ mode: e.target.value as any })}>
              <option value="merge">по частям → объединить в один ответ</option>
              <option value="concat">по частям → склеить по порядку</option>
              <option value="whole">целиком одним запросом</option>
            </select>
          </label>
          {st.mode === 'merge' && <label className="col" style={{ gap: 3 }}>Запрос объединения (пусто — стандартный)<textarea rows={3} value={st.reduce} onChange={(e) => updPrompt({ reduce: e.target.value })} /></label>}
          <div className="row">
            {preset && !preset.custom && <button className="small ghost" onClick={() => { upd({ map: preset.map, reduce: preset.reduce, mode: preset.mode, source: preset.source }); S.clearPipelinePrompt(st.id); }}>вернуть исходный запрос</button>}
            {hasPrompt && <button className="small ghost" title="Запрос этого проекта отличается от общего" onClick={() => S.clearPipelinePrompt(st.id)}>сбросить запрос проекта</button>}
          </div>
          <div className="hint tip">Запрос сохраняется в проект: у других проектов остаётся свой.</div>
        </div>
      )}
      {open && text && (
        <>
          <textarea className="result" rows={10} value={text} readOnly={live?.s === 'running'}
            onChange={(e) => { p.pipeline = p.pipeline.map((r) => (r.stepId === st.id ? { ...r, text: e.target.value } : r)); S.scheduleSave(); S.bump(); }} />
          <div className="row">
            <button className="small" onClick={() => navigator.clipboard.writeText(text).then(() => S.toast('Скопировано', 'ok'))}>Копировать</button>
            <button className="small" onClick={() => saveBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${p.name}.${i + 1}-${st.id}.md`)}>Скачать</button>
          </div>
        </>
      )}
    </div>
  );
}

export function TextsPanel() {
  useStore((s) => s.version);
  const p = S.project!;
  const [steps, setSteps] = useState<StepDef[]>(loadSteps());
  const [editing, setEditing] = useState<string | null>(null);
  const eff = projectSteps(steps, p.prompts);
  const configured = llmConfigured();
  const busy = !!S.task && S.task.kind !== 'models';
  return (
    <div className="panel">
      <div className="hint tip">Этапы выполняются сверху вниз по тексту <b>смонтированной</b> записи; таймкоды — по результату. Запускайте после монтажа.</div>
      {!configured && <div className="card col" style={{ padding: 10, gap: 8 }}>
        <div>Из текста смонтированной записи ИИ подготовит исправленный и структурированный текст, главы с таймкодами, тезисы и промо-тексты. Для генерации подключите модель; уже готовые тексты можно редактировать без неё.</div>
        <div><button className="primary" onClick={() => S.openSettings('llm')}>Настроить подключение…</button></div>
      </div>}
      <div className="row wrap">
        <button className="primary" disabled={busy || !p.words.length || !configured} onClick={() => runPipelineUI(null)}>{S.task?.kind === 'pipeline' ? <><span className="spin" /> Идёт обработка…</> : 'Запустить отмеченные'}</button>
        <button disabled={!p.pipeline.length} onClick={() => {
          const md = eff.map((s, i) => { const r = p.pipeline.find((x) => x.stepId === s.id); return r ? `# ${i + 1}. ${s.name}\n\n${r.text}\n` : ''; }).filter(Boolean).join('\n\n');
          saveBlob(new Blob([`# ${p.name}\n\n` + md], { type: 'text/markdown;charset=utf-8' }), `${p.name}.texts.md`);
        }}>Скачать все (.md)</button>
      </div>
      <TaskInline kinds={['pipeline', 'llm']} />
      {eff.map((st, i) => <StepRow key={st.id} st={st} i={i} steps={eff} onUpdate={(id, patch) => {
        const n = steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
        setSteps(n); saveSteps(n);
      }} onEdit={setEditing} />)}
      <button className="small ghost" onClick={() => {
        const n = [...steps, { ...STEP_PRESETS.find((x) => x.custom)!, id: 'custom' + Date.now().toString(36), name: 'Свой запрос', enabled: true }];
        setSteps(n); saveSteps(n);
      }}>＋ Свой этап</button>
      {editing && S.project && <TextEditor stepId={editing} onClose={() => setEditing(null)}
        onRegenerate={async () => { await runPipelineUI([editing]); }} />}
    </div>
  );
}
