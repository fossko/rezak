import { S, useStore } from '../store';
import { STRENGTH_LABEL } from './AiPanel';
import { fmtDur } from '../lib/util';

type StepState = 'wait' | 'run' | 'done' | 'skip' | 'err';

/** Progress / result of an unattended fast-track run, shown above the side tabs. */
export function FastTrackCard() {
  const p = useStore((s) => s.project);
  const task = useStore((s) => s.task);
  const ft = p?.fastTrack;
  if (!p || !ft || ft.dismissed) return null;
  const order = ['transcribe', 'mat', 'ai', 'done'] as const;
  const at = order.indexOf(ft.step);
  const st = (k: typeof order[number]): StepState => {
    const i = order.indexOf(k);
    if (ft.status === 'error' && i === at) return 'err';
    if (k === 'ai' && ft.aiSkipped && at >= i) return 'skip';
    return i < at || ft.status === 'done' ? 'done' : i === at ? (ft.status === 'running' ? 'run' : 'wait') : 'wait';
  };
  const live = task && ft.status === 'running' ? task.text : '';
  const icon = (s: StepState) => s === 'run' ? <span className="spin" /> : s === 'done' ? <span className="ok">✓</span> : s === 'skip' ? <span className="dim">–</span> : s === 'err' ? <span className="err">✕</span> : <span className="dim">○</span>;
  const row = (k: typeof order[number], label: string, result: string) => {
    const s = st(k);
    return (
      <div className={'ft-step ' + s}>
        {icon(s)}
        <div className="grow">
          <div>{label}</div>
          {s === 'run' && live && <div className="hint">{live}</div>}
          {(s === 'done' || s === 'skip' || s === 'err') && result && <div className="hint">{result}</div>}
        </div>
      </div>
    );
  };
  const fillers = p.words.filter((w) => w.kind === 'filler').length;
  const elapsed = ((ft.finished || Date.now()) - ft.started) / 1000;
  return (
    <div className={'ftcard ' + ft.status}>
      <div className="row">
        <b className="grow">⚡ Быстрый путь {ft.status === 'running' ? '' : ft.status === 'done' ? '— готово' : '— остановлен'}</b>
        {ft.status !== 'running' && <span className="dim" style={{ fontSize: 12 }}>{fmtDur(elapsed)}</span>}
        {ft.status !== 'running' && <button className="small ghost" title="Скрыть" onClick={() => { ft.dismissed = true; S.scheduleSave(); S.bump(); }}>✕</button>}
      </div>
      {row('transcribe', 'Расшифровка и звуки-паразиты', `${p.words.filter((w) => !w.kind).length} слов, звуков-паразитов вырезано: ${fillers}`)}
      {row('mat', 'Заглушение мата', ft.matFound ? `заглушено: ${ft.matFound}` : 'мат не найден')}
      {row('ai', `ИИ-монтаж · ${STRENGTH_LABEL[ft.strength]}`, ft.aiSkipped ? ft.aiSkipped : `вырезано фрагментов: ${ft.aiFound ?? 0}`)}
      {ft.status === 'error' && ft.error && <div className="err" style={{ fontSize: 12.5 }}>{ft.error}</div>}
      {ft.status === 'running' && <div className="hint tip">Вкладку можно не трогать: экран не уснёт, а по окончании придёт уведомление.</div>}
      {ft.status === 'done' && (
        <div className="row wrap">
          <span className="hint grow">Проверьте правки:</span>
          {!!ft.aiFound && <button className="small" onClick={() => S.setSideTab('ai')}>ИИ-монтаж ({ft.aiFound})</button>}
          {!!ft.matFound && <button className="small" onClick={() => S.setSideTab('mat')}>Мат ({ft.matFound})</button>}
          <button className="small" onClick={() => S.setSideTab('silence')}>Монтаж</button>
        </div>
      )}
    </div>
  );
}
