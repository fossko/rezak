import { useEffect, useRef, useState } from 'react';
import { S, useStore, savePrefs, prefs } from '../store';
import { TranscriptView } from './TranscriptView';
import { PlayerCard } from './PlayerCard';
import { Timeline } from './Timeline';
import { SilencePanel } from './SilencePanel';
import { ExportPanel } from './ExportPanel';
import { AudioPanel } from './AudioPanel';
import { AiPanel } from './AiPanel';
import { TextsPanel } from './TextsPanel';
import { ProfanityPanel } from './ProfanityPanel';
import { TitlesPanel } from './TitlesPanel';
import { hub, pickMedia, scrubWord } from './hub';
import { mediaHasVideo } from '../lib/media';
import { FastTrackCard } from './FastTrackCard';
import { fmtBytes } from '../lib/util';
import { machineLabel } from '../lib/device';

type Tab = 'silence' | 'mat' | 'titles' | 'ai' | 'texts' | 'audio' | 'export';

function LinkBanner() {
  const p = useStore((s) => s.project!);
  const video = mediaHasVideo(p.media);
  return (
    <div className="card row" style={{ margin: 10, borderColor: 'var(--acc)' }}>
      <div className="grow">Укажите исходный {video ? 'видеофайл' : 'аудиофайл'}: <b>{p.media.name}</b> <span className="dim">({fmtBytes(p.media.size)})</span>. Без него нельзя смотреть и экспортировать, но текст править можно.</div>
      <button className="primary" onClick={async () => {
        if (await S.relinkWithHandle()) return;
        const r = await pickMedia(); if (r) S.linkFile(r.file, r.handle);
      }}>Открыть файл…</button>
      <input id="carver-link-input" type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) S.linkFile(f, null); }} />
    </div>
  );
}

function TextTools() {
  useStore((s) => s.editRev);
  const sel = S.selRange();
  const p = S.project!;
  return (
    <div className="texttools">
      <button className="small ghost" disabled={!S.canUndo} onClick={() => S.undo()} title="⌘Z">↶ Отменить</button>
      <button className="small ghost" disabled={!S.canRedo} onClick={() => S.redo()} title="⇧⌘Z">↷ Повторить</button>
      <span className="dim">|</span>
      {sel ? <>
        <span>Выделено слов: {sel[1] - sel[0] + 1}</span>
        <button className="small" onClick={() => S.toggleRange(sel[0], sel[1])} title="Delete">✂ Вырезать / вернуть</button>
        <button className="small" onClick={() => S.toggleMute(sel[0], sel[1])} title="M — выключить звук на словах, не вырезая их">🔇 Заглушить (M)</button>
        <button className="small ghost" onClick={() => { hub.player?.seekSrc(Math.max(0, p.words[sel[0]].start - 2)); hub.player?.play(); }} title="Послушать склейку с 2 с до выделения">▶ Послушать склейку</button>
      </> : <span className="dim tip">Выделите слова мышью (Shift+щелчок — расширить), Delete — вырезать, M — заглушить</span>}
      <span className="grow" />
      <label className="row small" style={{ gap: 4 }} title="Текст прокручивается за воспроизведением">
        <input type="checkbox" defaultChecked={prefs.followPlayhead} onChange={(e) => savePrefs({ followPlayhead: e.target.checked })} /> следовать
      </label>
    </div>
  );
}

export function Editor() {
  const needsFile = useStore((s) => s.needsFile);
  const tab = useStore((s) => s.sideTab);
  const project = useStore((s) => s.project);
  const media = useStore((s) => s.media);
  // Audio-only projects have no picture, so заставки (a video feature) are not offered.
  const hasVideo = !!(media ? media.video : project && mediaHasVideo(project.media));
  const setTab = (t: Tab) => S.setSideTab(t);
  const saving = useRef(false);

  const saveProject = async () => {
    const p = S.project;
    if (!p || saving.current) return;
    saving.current = true;
    try {
      const inWorkspace = !!S.workspaceId && p.workspaceId === S.workspaceId;
      try { await S.saveNow(true, !inWorkspace); } catch { return; }   // saveNow already reported the failure
      if (inWorkspace) {
        if (!await S.forceWorkspaceSave()) return;   // its own toast explains the server error
        S.toast(`Сохранено в ${S.workspaceName || 'рабочем пространстве'}`, 'ok');
      } else {
        S.toast(`Сохранено на ${machineLabel()}`, 'ok');
      }
    } finally { saving.current = false; }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Physical key code: with a Russian layout Cmd+S produces «ы» in e.key.
      if (mod && e.code === 'KeyS') {
        e.preventDefault();
        if (!e.repeat) void saveProject();
        return;
      }
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' && !['range', 'checkbox'].includes((t as HTMLInputElement).type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const p = S.project; if (!p) return;
      if (e.code === 'Space') { e.preventDefault(); hub.player?.toggle(); return; }
      if (e.altKey && !mod && e.code === 'KeyF') {
        e.preventDefault();
        const on = !prefs.selFollow;
        savePrefs({ selFollow: on });
        S.toast(on ? 'Выделение следует за воспроизведением — включено' : 'Выделение следует за воспроизведением — выключено', 'info');
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? S.redo() : S.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); S.redo(); return; }
      const sel = S.selRange();
      if ((e.key === 'Delete' || e.key === 'Backspace' || e.key === 'x' || e.key === 'ч') && sel && !mod) { e.preventDefault(); S.toggleRange(sel[0], sel[1]); return; }
      if (e.code === 'KeyM' && sel && !mod) { e.preventDefault(); S.toggleMute(sel[0], sel[1]); return; }
      if (e.key === 'Escape') { S.setSelection(null); return; }
      const arrows = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'];
      if (arrows.includes(e.key) && S.selection && !mod) {
        e.preventDefault();   // with a selection, arrows move it instead of scrolling the page
        let b: number | null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') b = Math.max(0, Math.min(p.words.length - 1, S.selection.b + (e.key === 'ArrowRight' ? 1 : -1)));
        else b = hub.lineTarget?.(S.selection.b, e.key === 'ArrowDown' ? 1 : -1) ?? null;
        if (b == null) return;   // already on the first / last line
        hub.caretBack = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
        S.setSelection(e.shiftKey ? { a: S.selection.a, b } : { a: b, b });
        hub.scrollToWord?.(b);
        scrubWord(b);
        if (!hub.player?.playing) hub.player?.seekSrc(p.words[b].start);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="editor">
      <div className="textpane">
        {needsFile && <LinkBanner />}
        <TextTools />
        <TranscriptView />
        <Timeline />
      </div>
      <div className="side">
        <PlayerCard />
        <FastTrackCard />
        <div className="tabs">
          <button className={tab === 'silence' ? 'on' : ''} onClick={() => setTab('silence')}>Монтаж</button>
          <button className={tab === 'mat' ? 'on' : ''} onClick={() => setTab('mat')}>Мат</button>
          {hasVideo && <button className={tab === 'titles' ? 'on' : ''} onClick={() => setTab('titles')}>Заставки</button>}
          <button className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>ИИ-монтаж</button>
          <button className={tab === 'texts' ? 'on' : ''} onClick={() => setTab('texts')}>Тексты</button>
          <button className={tab === 'audio' ? 'on' : ''} onClick={() => setTab('audio')}>Аудио</button>
          <button className={tab === 'export' ? 'on' : ''} onClick={() => setTab('export')}>Экспорт</button>
        </div>
        <div className="side-scroll">
          {tab === 'silence' && <SilencePanel />}
          {tab === 'mat' && <ProfanityPanel />}
          {tab === 'titles' && hasVideo && <TitlesPanel />}
          {tab === 'ai' && <AiPanel />}
          {tab === 'texts' && <TextsPanel />}
          {tab === 'audio' && <AudioPanel />}
          {tab === 'export' && <ExportPanel />}
        </div>
      </div>
    </div>
  );
}
