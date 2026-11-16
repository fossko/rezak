import { useEffect, useRef, useState } from 'react';
import { S, useStore } from '../store';
import { Home } from './Home';
import { Editor } from './Editor';
import { Settings } from './Settings';
import { DropOverlay } from './DropOverlay';
import { clock } from '../lib/util';
import { webgpuAvailable } from '../lib/gpu';
import { B } from '../batch';
import { createWorkspaceApi, POLL_MS, workspaceTokenFromLocation, type WorkspaceManifest } from '../lib/workspace';
import { machineLabel } from '../lib/device';

const workspaceApi = createWorkspaceApi((import.meta as any).env?.VITE_WORKSPACE_API || '/api/workspace');
const plural = (n: number, one: string, few: string, many: string) => {
  const abs = Math.abs(n) % 100, last = abs % 10;
  return last === 1 && abs !== 11 ? one : last >= 2 && last <= 4 && (abs < 10 || abs >= 20) ? few : many;
};

function WorkspaceStatus() {
  const [workspace, setWorkspace] = useState<WorkspaceManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let entered = false;
    const token = workspaceTokenFromLocation();
    if (!token) return;
    const sync = async () => {
      try {
        if (!entered) { await workspaceApi.enter(token); entered = true; }
        // Poll the light manifest (kilobytes): project bodies are downloaded only when their revision changes.
        const next = await workspaceApi.getManifest();
        if (!stopped) { setWorkspace(next); setError(null); S.setWorkspaceLoadError(null); void S.syncWorkspace(next); }
      } catch (e: any) {
        if (!stopped) { const message = e?.message || 'нет связи с рабочим пространством'; setError(message); S.setWorkspaceLoadError(message); }
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);
  if (!workspace && !error) return null;
  return <span className="workspace-status" title={error || 'Синхронизация каждые 5 секунд'}>⌘ {workspace?.name || 'Рабочее пространство'}{error ? ' · офлайн' : ''}</span>;
}

function Gear() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.9 4.6 1.7 1.7 0 0 0 9.93 3.04V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 8.9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />
    </svg>
  );
}

/** «Вырезано: 16%» — how much shorter the carved video is than the source. */
function ShrinkStat() {
  const p = useStore((s) => s.project);
  const edl = useStore((s) => s.edl);
  useStore((s) => s.edlRev);
  if (!p || !edl || !p.media.duration) return null;
  const outDur = S.composite?.duration ?? edl.outDuration;
  const pct = Math.round((1 - outDur / p.media.duration) * 100);
  return <span className="shrink" title={`Исходник ${clock(p.media.duration)} → результат ${clock(outDur)}`}>Вырезано: <b>{pct}%</b></span>;
}


/** ⚠️ next to the progress bar while Whisper runs on the CPU; hover → why + «Изменить на WebGPU». */
function CpuWarning({ why }: { why?: string | null }) {
  const [gpu, setGpu] = useState<boolean | null>(null);
  useEffect(() => { void webgpuAvailable().then(setGpu); }, []);
  return (
    <span className="cpuwarn" tabIndex={0} data-cpu-warning aria-label="Расшифровка идёт на процессоре">⚠️
      <span className="cpuwarn-pop" role="tooltip">
        <b>Расшифровка идёт на процессоре (WASM)</b>
        <span>Это в несколько раз медленнее, чем на видеокарте.{why ? ` Причина: ${why}.` : ''}</span>
        <button className="small primary" disabled={gpu !== true || S.batchRunning || B.adding || B.exporting} onClick={() => S.switchToWebGPU()}>Изменить на WebGPU</button>
        {gpu === false && <span className="dim">WebGPU в этом браузере недоступен. Подробности — ⚙ Настройки → Распознавание речи → Диагностика видеокарты.</span>}
      </span>
    </span>
  );
}

export function TaskBar() {
  const task = useStore((s) => s.task);
  if (!task) return <div className="taskbar" />;
  return (
    <div className="taskbar">
      <span className="ellipsis tasktext" title={task.live || ''}>{task.text}</span>
      {task.kind === 'transcribe' && task.asr?.device === 'wasm' && <CpuWarning why={task.asr.why} />}
      <div className="bar"><div style={{ width: `${Math.round(task.frac * 100)}%` }} /></div>
      {task.cancel && <button className="small ghost" onClick={() => S.cancelTask()}>Стоп</button>}
    </div>
  );
}

export function App() {
  const project = useStore((s) => s.project);
  const toasts = useStore((s) => s.toasts);
  const settings = useStore((s) => s.settingsTab);
  const task = useStore((s) => s.task);
  const ft = project?.fastTrack;
  const batchView = useStore((s) => s.batchView);
  const batchRunning = useStore((s) => s.batchRunning);
  const savingAll = useRef(false);

  // The editor and the full-screen text editor save their own open project. Everywhere else
  // (project table, batch view, settings over them) ⌘S must save all projects instead of the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.code !== 'KeyS') return;
      if (project && !batchView) return;   // editor handles its own save
      e.preventDefault();
      if (e.repeat || savingAll.current) return;
      savingAll.current = true;
      void (async () => {
        try {
          const scope = S.scope;
          if (!scope) { S.toast('Рабочее пространство ещё загружается — попробуйте через пару секунд.', 'info'); return; }
          const result = await S.saveAllProjects();
          if (result.failed) { S.toast(`Не удалось сохранить проекты: ${result.failed} из ${result.total}`, 'err'); return; }
          const n = result.saved, word = plural(n, 'проект', 'проекта', 'проектов');
          if (scope.kind === 'workspace') {
            const name = S.workspaceName || 'рабочем пространстве';
            S.toast(n ? `Сохранено в ${name}: ${n} ${word}` : `Все проекты в ${name} актуальны`, 'ok');
          } else {
            const machine = machineLabel();
            S.toast(n ? `Сохранено на ${machine}: ${n} ${word}` : `Все проекты на ${machine} актуальны`, 'ok');
          }
        } catch (e: any) {
          S.toast('Не удалось сохранить проекты: ' + (e?.message || e), 'err');
        } finally { savingAll.current = false; }
      })();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, batchView]);

  useEffect(() => {
    const token = workspaceTokenFromLocation();
    if (!token || !project) return;
    const acquire = window.setTimeout(() => { void S.acquireWorkspaceLock(project.id); }, 500);
    const timer = window.setInterval(() => S.heartbeatWorkspace([project.id]), POLL_MS);
    return () => { window.clearTimeout(acquire); window.clearInterval(timer); S.releaseWorkspaceLock(project.id); };
  }, [project?.id]);

  // tab title: progress while working, outcome when a fast track ends (visible from other tabs)
  useEffect(() => {
    const busy = task && task.kind !== 'models' ? `⏳ ${Math.round(task.frac * 100)}% · ` : '';
    // What is open: the source file, then the workspace, then the app itself. Keep the name visible
    // while a task is running or a fast track finishes, not just the spinner/status.
    const file = project ? (project.media?.name || project.name).trim() : '';
    const label = file || S.workspaceName?.trim() || '';
    const base = label ? `${label} — Резак` : 'Резак';
    document.title = ft?.status === 'running' ? `⚡ ${busy || '⏳ '}${base}`
      : ft?.status === 'done' && !ft.dismissed ? `✓ Готово: ${base}`
      : busy ? `${busy}${base}` : base;
  });

  useEffect(() => { S.initTitleLib(); }, []);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      S.saveNow();
      if (S.task && (S.task.kind === 'export' || S.task.kind === 'transcribe')) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo" onClick={() => { if (!batchRunning) S.closeProject(); }} title={batchRunning ? 'Пакетная обработка' : 'К списку проектов'}>Резак</div>
        {project && <><span className="dim">/</span><span className="projname" title={project.media.name}>{project.name}</span></>}
        <WorkspaceStatus />
        <TaskBar />
        <ShrinkStat />
        <button className="ghost icon" disabled={batchRunning || B.adding || B.exporting} onClick={() => S.openSettings('ui')} title="Настройки" aria-label="Настройки"><Gear /></button>
      </div>
      {project && !batchView ? <Editor /> : <Home />}
      {settings && !batchRunning && !B.adding && !B.exporting && <Settings initial={settings} onClose={() => S.openSettings(null)} />}
      <DropOverlay />
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={'toast ' + t.kind}>{t.text}</div>)}</div>
    </div>
  );
}
