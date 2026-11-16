import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { S, useStore } from '../store';
import { projectSteps, loadSteps } from '../llm/pipeline';
import { saveBlob } from '../lib/util';

/** Full-screen editor for one generated text step: a big text area, the prompt that produced it, and Cmd+S.
 *  Cmd+S saves the text and the prompt into the project (never the page) and, in a workspace, pushes it to the server. */
export function TextEditor({ stepId, onClose, onRegenerate }: {
  stepId: string;
  onClose: () => void;
  onRegenerate: () => Promise<void>;
}) {
  useStore((s) => s.version);
  const p = S.project!;
  const step = useMemo(() => projectSteps(loadSteps(), p.prompts).find((s) => s.id === stepId), [p.prompts, stepId]);
  const stored = p.pipeline.find((r) => r.stepId === stepId)?.text ?? '';
  const [text, setText] = useState(stored);
  const [prompt, setPrompt] = useState(step?.map ?? '');
  const [reduce, setReduce] = useState(step?.reduce ?? '');
  const [showPrompt, setShowPrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const promptTimer = useRef(0);

  const promptDirty = prompt !== (step?.map ?? '') || reduce !== (step?.reduce ?? '');
  const textDirty = text !== stored;
  const dirty = promptDirty || textDirty;

  // Prompt edits belong to the project: persist them shortly after typing, without waiting for Cmd+S.
  const queuePromptSave = (map: string, red: string) => {
    clearTimeout(promptTimer.current);
    promptTimer.current = window.setTimeout(() => S.setPipelinePrompt(stepId, { map, reduce: red }), 400);
  };
  const flushPrompt = useCallback(() => {
    clearTimeout(promptTimer.current);
    S.setPipelinePrompt(stepId, { map: prompt, reduce });
  }, [prompt, reduce, stepId]);

  const save = useCallback(async (closeAfter = false) => {
    if (saving) return;
    setSaving(true);
    try {
      clearTimeout(promptTimer.current);
      S.setPipelinePrompt(stepId, { map: prompt, reduce });
      S.setPipelineText(stepId, text);
      await S.saveNow(true, !S.workspaceId);   // in a workspace the explicit push below owns the server write
      let note = 'Сохранено в проект';
      if (S.workspaceId) note = (await S.forceWorkspaceSave()) ? 'Сохранено в проект и отправлено в рабочее пространство' : 'Сохранено в проект (не отправлено на сервер)';
      setSavedNote(note);
      S.toast(note, 'ok');
      if (closeAfter) onClose();
    } catch (e: any) {
      S.toast('Не удалось сохранить: ' + (e?.message || e), 'err');
    } finally { setSaving(false); }
  }, [prompt, reduce, text, stepId, saving, onClose]);

  const regenerate = async () => {
    if (regenerating || S.task) return;
    flushPrompt();
    setRegenerating(true);
    try {
      await onRegenerate();
      const fresh = S.project?.pipeline.find((r) => r.stepId === stepId)?.text;
      if (fresh != null) setText(fresh);
      setSavedNote('Текст перегенерирован');
    } finally { setRegenerating(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.code === 'KeyS' || e.key.toLowerCase() === 's')) { e.preventDefault(); e.stopPropagation(); void save(); return; }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!dirty || confirm('Закрыть редактор? Несохранённые изменения текста пропадут.')) onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);   // capture: the editor's own hotkeys must not see Cmd+S
    return () => window.removeEventListener('keydown', onKey, true);
  }, [save, dirty, onClose]);

  useEffect(() => () => clearTimeout(promptTimer.current), []);
  useEffect(() => { area.current?.focus(); }, []);

  useEffect(() => { setSavedNote(null); }, [text, prompt, reduce]);

  const stepName = step?.name || stepId;
  return (
    <div className="teditor-bg" data-text-editor={stepId}>
      <div className="teditor">
        <div className="teditor-head">
          <b className="grow">{stepName}</b>
          <span className="dim">{[...text].length.toLocaleString('ru-RU')} символов</span>
          {dirty ? <span className="teditor-dirty">есть изменения</span> : savedNote ? <span className="ok">{savedNote}</span> : <span className="dim">сохранено</span>}
          <button className="ghost icon" title="Закрыть (Esc)" aria-label="Закрыть" onClick={() => { if (!dirty || confirm('Закрыть редактор? Несохранённые изменения текста пропадут.')) onClose(); }}>✕</button>
        </div>

        <details className="teditor-prompt" open={showPrompt} onToggle={(e) => setShowPrompt((e.target as HTMLDetailsElement).open)}>
          <summary>Запрос к модели{promptDirty ? ' · изменён' : ''}</summary>
          <div className="col" style={{ gap: 6, marginTop: 8 }}>
            <textarea className="mono" rows={6} value={prompt} spellCheck={false}
              onChange={(e) => { setPrompt(e.target.value); queuePromptSave(e.target.value, reduce); }} />
            {step?.mode === 'merge' && (
              <label className="col" style={{ gap: 3 }}><span className="dim">Объединение частей (пусто — стандартное)</span>
                <textarea className="mono" rows={3} value={reduce} spellCheck={false}
                  onChange={(e) => { setReduce(e.target.value); queuePromptSave(prompt, e.target.value); }} />
              </label>
            )}
            <div className="row">
              <button className="small" disabled={regenerating || !!S.task} onClick={() => void regenerate()}>
                {regenerating ? <><span className="spin" /> Генерация…</> : 'Перегенерировать'}
              </button>
              <button className="small ghost" disabled={!p.prompts?.[stepId]} title="Вернуть стандартный запрос" onClick={() => {
                S.clearPipelinePrompt(stepId);
                const base = loadSteps().find((s) => s.id === stepId);
                setPrompt(base?.map ?? ''); setReduce(base?.reduce ?? '');
              }}>Сбросить запрос</button>
              <span className="dim">{promptDirty ? 'запрос сохранится в проект' : 'запрос сохранён в проект'}</span>
            </div>
          </div>
        </details>

        <textarea ref={area} className="teditor-text" data-text-editor-input value={text} spellCheck
          onChange={(e) => setText(e.target.value)} placeholder="Текст ещё не сгенерирован." />

        <div className="teditor-foot">
          <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Сохраняю…' : 'Сохранить'}</button>
          <span className="dim tip">⌘S / Ctrl+S — сохранить текст и запрос в проект{'\u00a0'}(в рабочем пространстве — ещё и на сервер)</span>
          <span className="grow" />
          <button className="small ghost" onClick={() => navigator.clipboard.writeText(text).then(() => S.toast('Скопировано', 'ok'))}>Копировать</button>
          <button className="small ghost" onClick={() => saveBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${p.name}.${stepId}.md`)}>Скачать .md</button>
        </div>
      </div>
    </div>
  );
}
