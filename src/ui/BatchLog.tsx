import { useEffect, useRef, useState } from 'react';
import { batchLog } from '../lib/batch-log';

type Props = { projectId: string; running?: boolean; active?: boolean };
const TAIL_LIMIT = 300; // lines: this is a liveness report, not an archive
export function BatchLog({ projectId, running = false, active = false }: Props) {
  // null = follow the default (only the file being processed/edited is expanded);
  // a boolean = the user overrode it for this file until its activity changes again.
  const [manual, setManual] = useState<boolean | null>(null);
  const [paused, setPaused] = useState(false);
  const [warning, setWarning] = useState<string>();
  const [tail, setTail] = useState('');
  const [elapsed, setElapsed] = useState<number>();
  const [clock, setClock] = useState('');
  const box = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const expanded = manual ?? active;
  const bodyId = `batch-log-body-${projectId}`;
  useEffect(() => { setManual(null); }, [active]);
  useEffect(() => {
    let revision = -1;
    const unsubscribe = batchLog.subscribe(projectId, () => {});
    const update = () => {
      const next = batchLog.snapshot(projectId);
      if (next !== revision) {
        revision = next;
        setTail(batchLog.tail(projectId, TAIL_LIMIT));
        setWarning(batchLog.warning(projectId));
      }
      const at = batchLog.lastEvent(projectId);
      setElapsed(at == null ? undefined : Math.max(0, Math.floor((Date.now() - at) / 1000)));
      if (running) setClock(new Date().toLocaleTimeString());
    };
    update(); const timer = window.setInterval(update, 250);
    return () => { clearInterval(timer); unsubscribe(); };
  }, [projectId, running]);
  useEffect(() => {
    const el = box.current;
    if (expanded && el && !paused && follow.current) el.scrollTop = el.scrollHeight;
  }, [tail, paused, expanded]);
  const download = async () => {
    await batchLog.load(projectId);
    const blob = new Blob([batchLog.text(projectId)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `batch-log-${projectId}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(batchLog.text(projectId)); }
    catch { setWarning('Не удалось скопировать автоматически. Выделите текст вручную или скачайте журнал.'); }
  };
  return <div className={'batch-log' + (expanded ? '' : ' collapsed')} data-batch-log={projectId}>
    <div className="batch-log-head">
      <button className="small ghost batch-log-toggle" aria-expanded={expanded} aria-controls={bodyId}
        onClick={() => setManual(!expanded)}>{expanded ? '▾ Свернуть журнал' : '▸ Показать журнал'}</button>
      <strong>Подробный журнал</strong>
      <span className="dim"> · последние {TAIL_LIMIT} строк</span>
      {running && <span className="dim"> · обработка запущена · часы вкладки {clock}</span>}
      {elapsed != null && <span className="dim"> · последнее событие {elapsed} с назад</span>}
      {expanded && <span className="batch-log-actions">
        <label><input type="checkbox" checked={paused} onChange={e => { setPaused(e.target.checked); if (!e.target.checked) follow.current = true; }} /> Не прокручивать</label>
        <button className="small" onClick={() => void copy()}>Копировать</button>
        <button className="small" onClick={() => void download()}>Скачать журнал</button>
      </span>}
    </div>
    {expanded && running && (elapsed ?? 0) >= 15 && <div className="dim" role="status">Нет новых событий {elapsed} с. Ожидаем ответа текущей операции; часы вкладки не означают прогресс модели.</div>}
    {warning && <div className="batch-log-warning" role="status">⚠️ {warning}</div>}
    {expanded && <pre id={bodyId} ref={box} tabIndex={0} role="log" aria-label="Подробный отчёт обработки" aria-live="off" className="batch-log-body"
      onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {tail || 'Журнал пока пуст. Новые события появятся здесь при обработке файла.'}
    </pre>}
  </div>;
}
