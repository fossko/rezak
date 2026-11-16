import { Fragment, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { B, defaultBatchSettings, useBatch } from '../batch';
import { S, useStore } from '../store';
import { projects } from '../lib/db';
import { filterProjects } from '../lib/scope';
import type { Project } from '../lib/types';
import { STAGE_IDS, STAGE_LABELS, STAGE_ICONS, STATUS_LABELS, type BatchSettings, type StageId } from '../lib/batch-types';
import { fmtDur } from '../lib/util';
import { downloadAllResults, downloadProjectResults } from '../export/results';
import { pickMedia, MEDIA_TYPES, MEDIA_ACCEPT } from './hub';
import { BatchLog } from './BatchLog';
import { ProjectNotes } from './ProjectNotes';

const inputFiles = (e: ChangeEvent<HTMLInputElement>) => Array.from(e.target.files || []).map(file => ({ file, handle: null }));
const stageStatus = (p: Project, id: StageId) => id === 'video' && p.videoExport ? 'done' : p.batch?.stages[id]?.status || 'pending';
const statusLabel = (p: Project, id: StageId) => !p.batch && stageStatus(p, id) === 'pending' ? 'Нет отметки' : STATUS_LABELS[stageStatus(p, id)];

export function BatchPanel() {
  const revision = useBatch();
  const editedId = useStore(s => s.project?.id);
  const batchView = useStore(s => s.batchView);
  const [list, setList] = useState<Project[]>([]);
  const [settings, setSettings] = useState<BatchSettings>(defaultBatchSettings);
  const [configure, setConfigure] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const idle = !B.running && !B.adding && !B.exporting && !S.task;
  // Only this tab's scope: local projects never appear in a workspace and vice versa.
  const refresh = () => projects.list().then(all => {
    const list = filterProjects(all, S.scope);
    setList(list);
    void B.prune(list.map(p => p.id));
  }).catch(e => S.toast('Не удалось прочитать проекты: ' + e.message, 'err'));
  useEffect(() => { void B.init(); }, []);
  useEffect(() => { const timer = setTimeout(refresh, 120); return () => clearTimeout(timer); }, [revision]);
  useEffect(() => { const timer = window.setInterval(refresh, 5000); return () => window.clearInterval(timer); }, []);

  const add = async (files: Array<{ file: File; handle: FileSystemFileHandle | null }>) => {
    try { if (files.length) await B.add(files, settings); }
    catch (e: any) { S.toast(e.message || String(e), 'err'); }
    finally { if (input.current) input.current.value = ''; }
  };
  const pick = async () => {
    const picker = (window as any).showOpenFilePicker;
    if (!picker) { input.current?.click(); return; }
    try {
      const handles: FileSystemFileHandle[] = await picker({ multiple: true, types: MEDIA_TYPES });
      await add(await Promise.all(handles.map(async handle => ({ file: await handle.getFile(), handle }))));
    } catch (e: any) { if (e.name !== 'AbortError') S.toast(e.message || String(e), 'err'); }
  };
  // Settings are shared by the whole queue: changes also update files that are not finished yet.
  // The queue itself is disabled while it runs, so an apply always happens at a safe boundary.
  const saveSettings = (next: BatchSettings) => {
    setSettings(next);
    if (idle) void B.applySettings(next).catch(e => S.toast(e.message || String(e), 'err'));
  };
  const toggle = (key: 'transcribe' | 'fillers' | 'carve' | 'texts') => saveSettings(
    key === 'transcribe' && settings.transcribe
      ? { ...settings, transcribe: false, fillers: false, carve: false, texts: false }
      : { ...settings, [key]: !settings[key] },
  );
  const toggleStep = (id: string) => {
    const step = settings.textSteps.find(s => s.id === id);
    if (!step) return;
    const enabled = settings.textSteps.filter(s => s.enabled && s.map.trim());
    if (step.enabled && settings.texts && enabled.length <= 1) {
      S.toast('Оставьте хотя бы один этап генерации текстов или выключите группу «Тексты».', 'info');
      return;
    }
    saveSettings({ ...settings, textSteps: settings.textSteps.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s) });
  };
  const relink = async (p: Project) => {
    try { const source = await pickMedia(); if (source) await B.relink(p.id, source.file, source.handle); }
    catch (e: any) { if (e.name !== 'AbortError') S.toast(e.message || String(e), 'err'); }
  };
  // Like Premiere's relink: one folder, every project whose video is inside gets its source back.
  const relinkFolder = async () => {
    const picker = (window as any).showDirectoryPicker;
    if (!picker) { S.toast('Браузер не умеет выбирать папку. Выберите файлы по одному в строках проектов.', 'err'); return; }
    try {
      const dir = await picker({ id: 'carver-source-folder', mode: 'read' });
      const r = await B.relinkFolder(dir);
      await refresh();
      if (!r.total) { S.toast('В очереди нет проектов, которым нужен исходник.', 'info'); return; }
      const parts = [`Восстановлено: ${r.matched} из ${r.total}`];
      if (r.ambiguous.length) parts.push(`неоднозначно: ${r.ambiguous.slice(0, 3).join(', ')}${r.ambiguous.length > 3 ? '…' : ''}`);
      if (r.missing.length) parts.push(`не найдено: ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? '…' : ''}`);
      S.toast(parts.join(' · '), r.missing.length || r.ambiguous.length ? 'info' : 'ok');
    } catch (e: any) { if (e?.name !== 'AbortError') S.toast('Не удалось прочитать папку: ' + (e.message || e), 'err'); }
  };
  const remove = async (p: Project) => {
    const shared = !!S.workspaceId && p.workspaceId === S.workspaceId;
    const message = shared
      ? `Удалить «${p.name}» из рабочего пространства?\n\nПроект исчезнет у всех участников и с сервера. Исходный файл останется на месте.`
      : `Удалить проект «${p.name}»? Исходный файл останется на месте.`;
    if (!idle || !confirm(message)) return;
    try {
      await S.deleteWorkspaceProject(p.id);
      await B.forget(p.id);
      await refresh();
      S.toast(shared ? 'Проект удалён у всех участников рабочего пространства.' : 'Проект удалён.', 'ok');
    } catch (e: any) { S.toast('Не удалось удалить проект: ' + (e.message || e), 'err'); await refresh(); }
  };
  const open = async (p: Project, exportVideo = false) => {
    if (!idle) return;
    S.batchView = false;
    await S.openProject(p.id);
    if (exportVideo) S.setSideTab('export');
  };
  const download = async (p?: Project) => {
    if (!idle) return;
    B.setExporting(true);
    try { if (p) await downloadProjectResults(p); else await downloadAllResults(list); }
    finally { B.setExporting(false); }
  };
  const pending = list.filter(p => B.queue.includes(p.id) && p.batch && p.batch.status !== 'done');
  const canStart = pending.some(p => p.batch!.status !== 'error');
  const pct = B.total ? Math.round(B.completed / B.total * 100) : 0;

  return <section className="batch-panel" aria-label="Пакетная обработка">
    <input ref={input} id="carver-batch-input" type="file" multiple hidden disabled={!idle}
      accept={MEDIA_ACCEPT} onChange={e => void add(inputFiles(e))} />
    <div className="batch-head row">
      <div className="grow"><h2>Пакетная обработка</h2><div className="dim">Файлы обрабатываются по одному, без параллельных запусков.</div></div>
      <button className="primary" disabled={!idle} onClick={() => void pick()}>＋ Добавить файлы</button>
    </div>
    <div className="batch-actions row wrap">
      <button className="primary" disabled={!idle || !canStart} onClick={() => void B.start()}>▶ Запустить очередь</button>
      {B.running && <button onClick={() => B.stop()}>Стоп</button>}
      <button disabled={!idle} title="Выберите папку с исходниками: файлы подтянутся по имени, размеру и дате" onClick={() => void relinkFolder()} data-relink-folder>📁 Папка с исходниками…</button>
      <button disabled={!idle} onClick={() => setConfigure(v => !v)}>⚙ Настройки</button>
      <span className="dim">{B.running ? `Обработка ${pct}% · ${B.completed}/${B.total}` : `${pending.length} незавершённых в очереди`}</span>
    </div>
    <div className="dim">Настройки общие для очереди: изменения применяются ко всем незавершённым файлам. Экспорт — отдельно, после проверки.</div>
    {B.running && <>
      <div className="batch-wake-warning" role="status">Оставьте вкладку открытой и не переводите компьютер в сон. Браузер может приостановить работу в фоне.</div>
      <div className="bar" aria-label={`Готово ${pct}%`}><div style={{ width: `${pct}%` }} /></div>
    </>}
    {S.project?.batch?.gpuWarning && <div className="batch-gpu-warning" role="status">⚠️ {S.project.batch.gpuWarning}</div>}
    {B.error && <div className="batch-error err" role="alert">{B.error}</div>}
    {configure && <fieldset disabled={!idle} className="batch-settings card">
      <b>Этапы для всех добавляемых файлов</b>
      <label><input type="checkbox" checked disabled /> {STAGE_LABELS.prepare} (обязательно)</label>
      {(['transcribe', 'fillers', 'carve', 'texts'] as const).map(key => <label key={key}>
        <input type="checkbox" data-setting={key} checked={settings[key]} onChange={() => toggle(key)} disabled={key !== 'transcribe' && !settings.transcribe} />
        {STAGE_LABELS[key]}
      </label>)}
      {settings.texts ? <div className="batch-textsteps">{settings.textSteps.map(step => <label key={step.id}>
        <input type="checkbox" data-setting={'text:' + step.id} checked={step.enabled} onChange={() => toggleStep(step.id)} /> {step.name}
      </label>)}</div> : <div className="dim">Группа выключена: отмеченные ранее текстовые этапы не выполняются.</div>}
      <label>Строгость ИИ-монтажа <select value={settings.strength} onChange={e => saveSettings({ ...settings, strength: e.target.value as BatchSettings['strength'] })}>
        <option value="careful">Строго: только очевидное</option><option value="normal">Обычно</option><option value="aggressive">Агрессивно</option>
      </select></label>
      <label>Цель громкости <input type="number" min={-24} max={-10} step=".1" value={settings.targetLufs}
        onChange={e => saveSettings({ ...settings, targetLufs: Number(e.target.value) })} /> LUFS</label>
      <div className="hint tip">Звуки-паразиты удаляются детектором «эээ/ммм»; смысловые повторы проверяет ИИ-монтаж.</div>
    </fieldset>}
    <div className="batch-table-wrap"><table className="batch-table">
      <thead><tr><th>Файл</th><th>До → после · сокращение</th><th>Этапы</th><th>Результаты</th></tr></thead>
      <tbody>{list.map(p => {
        const out = p.batch?.outputDuration ?? p.outputDuration;
        const shrink = out != null && p.media.duration > 0 ? Math.round((1 - out / p.media.duration) * 100) : null;
        return <Fragment key={p.id}>
          <tr data-project-row={p.id} className={B.activeId === p.id ? 'active' : ''}>
          <td className="batch-name">
            <button className="small ghost batch-open" disabled={!idle} onClick={() => void open(p)}>{p.media.name}</button>
            {p.batch?.gpuWarning && <div className="batch-gpu-warning">⚠️ {p.batch.gpuWarning}</div>}
            <div className="batch-controls">
              {p.batch?.status === 'error' && <button className="small" disabled={!idle} onClick={() => void B.retry(p.id)}>Повторить</button>}
              <button className="small" disabled={!idle} onClick={() => void relink(p)}>Выбрать исходник</button>
              <button className="small danger" disabled={!idle} onClick={() => void remove(p)}>Удалить</button>
            </div>
          </td>
          <td className="mono">{fmtDur(p.media.duration)} → {out == null ? '—' : fmtDur(out)}{shrink == null ? '' : ` · ${shrink}%`}</td>
          <td className="stage-group">{STAGE_IDS.map(id => {
            const status = stageStatus(p, id), record = p.batch?.stages[id];
            const label = `${STAGE_LABELS[id]}: ${statusLabel(p, id)}${record?.error ? ' — ' + record.error : ''}${record?.note ? ' — ' + record.note : ''}`;
            return <span key={id} tabIndex={0} className={`stage stage-${status}`} title={label} aria-label={label}>
              {STAGE_ICONS[id]}<i>{status === 'done' ? '✓' : status === 'error' ? '!' : status === 'running' ? '…' : status === 'skipped' ? '–' : '·'}</i>
            </span>;
          })}</td>
          <td><button className="small" disabled={!idle} onClick={() => void download(p)}>Скачать результаты</button>{' '}
            <button className="small" disabled={!idle} onClick={() => void open(p, true)}>Экспорт</button>
          </td>
          </tr>
          <tr key={`${p.id}-log`} className="batch-log-row"><td colSpan={4}><BatchLog projectId={p.id} running={p.batch?.status === 'running'}
            active={(B.running && B.activeId === p.id) || (!batchView && editedId === p.id)} /></td></tr>
          <tr key={`${p.id}-notes`} className="batch-log-row"><td colSpan={4}><ProjectNotes projectId={p.id} notes={p.notes ?? ''} /></td></tr>
        </Fragment>;
      })}</tbody>
    </table></div>
    {!list.length && <div className="dim">Добавьте файлы, чтобы начать.</div>}
    {list.length > 0 && <div className="batch-footer row"><span className="dim">Экспорт не выполняется автоматически.</span>
      <button className="small" disabled={!idle} onClick={() => void download()}>Скачать все результаты</button>
    </div>}
  </section>;
}
