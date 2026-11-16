import { useEffect, useState } from 'react';
import { S, prefs, useStore } from '../store';
import { projects } from '../lib/db';
import type { Project } from '../lib/types';
import { pickMedia, MEDIA_ACCEPT } from './hub';
import { startFastTrack } from '../fasttrack';
import { loadModels, WHISPER_MODELS } from '../transcribe/run';
import { BatchPanel } from './BatchPanel';
import { B, useBatch } from '../batch';

export const modelsReady = () => localStorage.getItem('carver:modelsReady:' + prefs.model) === '1';
let modelsLoading = false;
export async function downloadModels() {
  if (B.running || B.adding || B.exporting || modelsLoading) return;
  modelsLoading = true; S.setTask({ kind: 'models', frac: 0, text: 'Загрузка моделей распознавания…' });
  try {
    const info = await loadModels({ model: prefs.model, device: prefs.device }, (f, text) => { if (S.task?.kind === 'models' || !S.task) S.setTask({ kind: 'models', frac: f, text }); });
    localStorage.setItem('carver:modelsReady:' + prefs.model, '1'); localStorage.setItem('carver:device', String(info.whisper.device));
    if (S.task?.kind === 'models') S.setTask(null); S.toast('Модели загружены и сохранены в браузере.', 'ok');
  } catch (e: any) { if (S.task?.kind === 'models') S.setTask(null); S.toast('Не удалось загрузить модели: ' + (e.message || e), 'err'); }
  finally { modelsLoading = false; S.bump(); }
}
export async function importProjectFile(file: File) {
  if (B.running || B.adding || B.exporting) return;
  if (!S.scope) { S.toast('Рабочее пространство ещё загружается — попробуйте через пару секунд.', 'info'); return; }
  try {
    const p = JSON.parse(await file.text()) as Project & { app?: string };
    if (!p || !Array.isArray(p.words) || !p.media) throw new Error('это не файл проекта Резак');
    const existing = await projects.get(p.id);
    if (existing && !confirm(`Проект «${p.name}» уже есть. Заменить его версией из файла?`)) p.id = crypto.randomUUID();
    p.updatedAt = Date.now();
    // An imported project belongs to the scope it is imported into: local stays local, a workspace shares it.
    p.workspaceId = S.scope.kind === 'workspace' ? S.scope.id : undefined;
    await projects.save(p);
    if (S.scope.kind === 'workspace') await S.publishWorkspaceProject(p);
    await S.openProject(p.id);
  }
  catch (e: any) { S.toast('Не удалось открыть проект: ' + e.message, 'err'); }
}
export function Home() {
  useBatch();
  useStore(s => s.version);
  const [gpu, setGpu] = useState<boolean | null>(null);
  useEffect(() => { (async () => { const g = (navigator as any).gpu; setGpu(!!(g && await g.requestAdapter().catch(() => null))); })(); }, []);
  if (!S.scope) return <div className="home"><div className="home-inner"><div className="card col" style={{ padding: 16, gap: 8 }} data-workspace-loading>
    <div className="row">{S.workspaceLoadError ? <h3>Не удалось открыть рабочее пространство</h3> : <><span className="spin" /><h3>Загружаю рабочее пространство…</h3></>}</div>
    {S.workspaceLoadError
      ? <><div className="err">{S.workspaceLoadError}</div><div className="hint">Проверьте связь и обновите страницу. Локальные проекты открываются по обычной ссылке без <code>?workspace=</code>.</div><div><button className="small" onClick={() => location.reload()}>Повторить</button></div></>
      : <div className="hint">Проекты этого пространства появятся через пару секунд. Локальные проекты здесь не показываются.</div>}
  </div></div></div>;
  const open = async () => { const r = await pickMedia(); if (r) S.openNewFile(r.file, r.handle); };
  const openFast = async () => { const r = await pickMedia(); if (r) startFastTrack(r.file, r.handle); };
  const ready = modelsReady(), task = S.task, model = WHISPER_MODELS.find(m => m.id === prefs.model), busy = B.running || B.adding || B.exporting;
  return <div className="home"><div className="home-inner">
    <input id="carver-file-input" type="file" accept={MEDIA_ACCEPT} hidden disabled={busy} onChange={e => { const f=e.target.files?.[0]; if(f) S.openNewFile(f,null); }} />
    <input id="carver-fast-input" type="file" accept={MEDIA_ACCEPT} hidden disabled={busy} onChange={e => { const f=e.target.files?.[0]; if(f) startFastTrack(f,null); }} />
    <div className="drops"><div className={'drop' + (B.running ? ' disabled' : '')} aria-disabled={busy} onClick={() => { if (!B.running) void open(); }}><h2>📂 Открыть видео или аудио</h2><div className="muted tip">Расшифровка — и дальше монтируете сами. Без видео превью чёрное, экспорт — MP3.</div></div><div className={'drop fast' + (B.running ? ' disabled' : '')} aria-disabled={busy} onClick={() => { if (!B.running) void openFast(); }}><h2>⚡ Быстрый путь</h2><div className="muted tip">Расшифровка → мат → ИИ-монтаж.</div></div></div>
    <div className="hint tip" style={{textAlign:'center'}}>Перетащите видео или аудио: левая половина — открыть, правая — быстрый путь. Файл не загружается в сеть.</div>
    {!ready && <div className="card col"><div className="row"><h3 className="grow">Модели распознавания речи</h3>{task?.kind === 'models' ? <span className="muted">{Math.round(task.frac*100)}%</span> : <button className="primary" disabled={busy} onClick={downloadModels}>Загрузить</button>}</div><div className="hint">Whisper {model ? `(${model.label})` : prefs.model} + wav2vec2. Видеокарта (WebGPU): {gpu == null ? '…' : gpu ? <span className="ok">есть</span> : <span className="err">нет — распознавание будет медленным</span>}.</div>{task?.kind==='models' && <div className="bar"><div style={{width:`${task.frac*100}%`}} /></div>}</div>}
    <BatchPanel />
    <div className="row"><h3 className="grow">Файл проекта</h3><label className="small" style={{cursor:'pointer'}}><input type="file" accept=".json,application/json" hidden disabled={busy} onChange={e=>e.target.files?.[0]&&importProjectFile(e.target.files[0])}/><span className="muted" style={{textDecoration:'underline dotted'}}>Открыть файл проекта…</span></label></div>
    <div className="hint tip">Всё работает в браузере на этом компьютере. В сеть уходит только текст расшифровки — если включить ИИ-монтаж.</div>
  </div></div>;
}
