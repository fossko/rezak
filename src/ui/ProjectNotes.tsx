import { useEffect, useRef, useState } from 'react';
import { S } from '../store';

/** «Заметки редактора»: free-form notes for one project, shared with the whole workspace.
 *  Looks like the batch journal row, but the body is an editable textarea; collapsed while empty. */
export function ProjectNotes({ projectId, notes }: { projectId: string; notes: string }) {
  const [value, setValue] = useState(notes);
  const [open, setOpen] = useState(notes.trim().length > 0);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timer = useRef(0);
  const saved = useRef(notes);      // last value known to be stored
  const current = useRef(notes);    // latest typed value (for the unmount flush)

  // A note typed by someone else arrives through the 5 s sync.
  useEffect(() => {
    if (notes === saved.current) return;
    saved.current = notes; current.current = notes;
    setValue(notes);
    if (notes.trim()) setOpen(true);
  }, [notes]);

  const commit = async (text: string) => {
    clearTimeout(timer.current);
    if (text === saved.current) return;
    saved.current = text;
    setState('saving');
    try { await S.saveProjectNotes(projectId, text); setState('saved'); }
    catch { setState('error'); }
  };
  const change = (text: string) => {
    current.current = text;
    setValue(text);
    setState('idle');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void commit(text), 700);
  };
  useEffect(() => {
    const id = projectId;
    return () => {
      clearTimeout(timer.current);
      if (current.current !== saved.current) void S.saveProjectNotes(id, current.current);
    };
  }, [projectId]);

  const bodyId = `project-notes-${projectId}`;
  const shared = S.scope?.kind === 'workspace';
  const empty = value.trim().length === 0;
  const status = state === 'saving' ? 'сохраняю…' : state === 'saved' ? 'сохранено' : state === 'error' ? 'не сохранено — проверьте связь' : '';
  return <div className={'batch-notes' + (open ? '' : ' collapsed')} data-project-notes={projectId}>
    <div className="batch-notes-head">
      <button className="small ghost batch-log-toggle" aria-expanded={open} aria-controls={bodyId}
        data-notes-toggle={projectId} onClick={() => setOpen(!open)}>{open ? '▾ Свернуть заметки' : '▸ Показать заметки'}</button>
      {open ? <strong>Заметки редактора</strong> : <span className="dim">Заметки редактора · {empty ? 'пусто' : 'есть заметка'}</span>}
      {open && <span className="batch-notes-status dim" role="status" aria-live="polite">{status}</span>}
      {open && <span className="batch-notes-hint dim">{shared ? 'видно всем участникам пространства' : 'хранится только на этом компьютере'}</span>}
    </div>
    {open && <textarea id={bodyId} className="batch-notes-body" value={value} rows={4} spellCheck
      data-notes-input={projectId}
      placeholder="Что важно знать тому, кто будет редактировать этот проект: решения, ссылки, что перепроверить…"
      onChange={(e) => change(e.target.value)} onBlur={() => void commit(current.current)} />}
  </div>;
}
