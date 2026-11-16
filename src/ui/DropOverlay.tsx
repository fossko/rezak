import { useEffect, useRef, useState } from 'react';
import { S } from '../store';
import { B, useBatch } from '../batch';
import { fileFromDrop } from './hub';
import { importProjectFile } from './Home';
import { startFastTrack } from '../fasttrack';
import { llmConfigured, loadLlmSettings } from '../llm/client';
import { loadOpts, STRENGTH_LABEL } from './AiPanel';

type Mode = 'split' | 'link' | 'project';

/** Window-wide drop target. While a video is dragged over the window the screen splits in two:
 *  left = open normally, right = fast track (transcribe → mute мат → AI carving, unattended). */
export function DropOverlay() {
  useBatch();
  const [mode, setMode] = useState<Mode | null>(null);
  const [side, setSide] = useState<'left' | 'right'>('left');
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const modeOf = (e: DragEvent): Mode => {
      const it = e.dataTransfer?.items?.[0];
      if (it && /json/.test(it.type)) return 'project';
      if (S.project && S.needsFile) return 'link';
      return 'split';
    };
    const enter = (e: DragEvent) => { if (!hasFiles(e) || B.running) return; depth.current++; setMode(modeOf(e)); };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setMode(null); };
    const over = (e: DragEvent) => {
      if (!hasFiles(e) || B.running) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setSide(e.clientX < window.innerWidth / 2 ? 'left' : 'right');
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e) || B.running) return;
      e.preventDefault();
      const m = modeOf(e), right = e.clientX >= window.innerWidth / 2;
      depth.current = 0; setMode(null);
      const f = e.dataTransfer?.files?.[0];
      if (m === 'project' || (f && /\.json$/i.test(f.name))) { if (f) importProjectFile(f); return; }
      const r = await fileFromDrop(e);
      if (!r) return;
      if (m === 'link') { S.linkFile(r.file, r.handle); return; }
      if (S.task && ['transcribe', 'export', 'llm', 'pipeline'].includes(S.task.kind)
        && !confirm('Сейчас идёт обработка текущего проекта. Остановить её и открыть новый файл? (Проект сохранён, расшифровку можно будет продолжить.)')) return;
      if (right) startFastTrack(r.file, r.handle);
      else S.openNewFile(r.file, r.handle);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over); window.removeEventListener('drop', drop);
    };
  }, []);

  if (!mode || B.running) return null;
  if (mode !== 'split') return (
    <div className="dropov single"><div className="dz on">
      <div className="dz-icon">{mode === 'link' ? '🎬' : '📄'}</div>
      <h2>{mode === 'link' ? 'Указать исходный файл' : 'Открыть файл проекта'}</h2>
    </div></div>
  );
  const ai = llmConfigured(), model = loadLlmSettings().model, strength = loadOpts().fastStrength;
  return (
    <div className="dropov">
      <div className={'dz left' + (side === 'left' ? ' on' : '')}>
        <div className="dz-icon">📂</div>
        <h2>Открыть</h2>
        <div className="dz-sub">Расшифровка — и дальше монтируете сами</div>
      </div>
      <div className={'dz right' + (side === 'right' ? ' on' : '')}>
        <div className="dz-icon">⚡</div>
        <h2>Быстрый путь</h2>
        <ol className="dz-steps">
          <li>Расшифровка и звуки-паразиты</li>
          <li>Заглушение мата</li>
          <li className={ai ? '' : 'off'}>ИИ-монтаж · {STRENGTH_LABEL[strength as keyof typeof STRENGTH_LABEL]}{ai ? ` · ${model}` : ' — ИИ не настроен, шаг будет пропущен'}</li>
        </ol>
        <div className="dz-sub">Можно уйти за кофе — потом только проверить правки</div>
      </div>
    </div>
  );
}
