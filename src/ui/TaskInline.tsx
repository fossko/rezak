import { useEffect, useRef, useState } from 'react';
import { S, useStore, type Task } from '../store';
import { clock } from '../lib/util';

/** Inline "working" box shown right under the button that started a task: spinner, live status,
 *  elapsed time, progress and a stop button. */
export function TaskInline({ kinds }: { kinds: Task['kind'][] }) {
  const task = useStore((s) => s.task);
  const active = !!task && kinds.includes(task.kind);
  const since = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) { since.current = 0; return; }
    if (!since.current) since.current = performance.now();
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!active || !task) return null;
  const el = since.current ? (performance.now() - since.current) / 1000 : 0;
  return (
    <div className="tinline" role="status" aria-live="polite">
      <div className="row" style={{ gap: 8 }}>
        <span className="spin big" />
        <span className="grow">{task.text}</span>
        <span className="dim mono" style={{ fontSize: 12 }}>{clock(el)}</span>
        {task.cancel && <button className="small" onClick={() => S.cancelTask()}>Стоп</button>}
      </div>
      <div className={'bar' + (task.frac > 0 ? '' : ' indeterminate')}><div style={{ width: task.frac > 0 ? `${Math.round(task.frac * 100)}%` : undefined }} /></div>
    </div>
  );
}
