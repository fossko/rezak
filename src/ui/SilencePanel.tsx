import { S, useStore } from '../store';
import { suggestThreshold } from '../lib/pcm';
import { fmtDur, fmtSec } from '../lib/util';
import { hub } from './hub';

function Field({ label, min, max, step, value, fmt, onChange, title }: {
  label: string; min: number; max: number; step: number; value: number; fmt: (v: number) => string; onChange: (v: number) => void; title?: string;
}) {
  return (
    <div className="field" title={title}>
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <span className="v">{fmt(value)}</span>
    </div>
  );
}

export function Stats() {
  const p = useStore((s) => s.project!);
  const edl = useStore((s) => s.edl);
  useStore((s) => s.edlRev);
  if (!edl) return null;
  const D = p.media.duration, outDur = S.composite?.duration ?? edl.outDuration, silCut = edl.silenceCuts.reduce((a, [x, y]) => a + (y - x), 0);
  let removedWords = 0, removedFillers = 0;
  S.wordState.forEach((v, i) => { if (v) { if (p.words[i]?.kind === 'filler') removedFillers++; else removedWords++; } });
  return (
    <div className="stats">
      <span className="muted">Исходник</span><b>{fmtDur(D)}</b>
      <span className="muted">Результат</span><b style={{ color: 'var(--acc2)' }}>{fmtDur(outDur)}</b>
      <span className="muted">Вырезано всего</span><b>{fmtDur(D - outDur)} ({Math.round((1 - outDur / Math.max(1e-6, D)) * 100)}%)</b>
      <span className="muted">· тишина</span><b>{fmtDur(silCut)} в {edl.silenceCuts.length} местах</b>
      <span className="muted">· слова</span><b>{removedWords}</b>
      <span className="muted">· звуки-паразиты</span><b>{removedFillers}</b>
      <span className="muted">Склеек</span><b>{Math.max(0, edl.segments.length - 1)}</b>
    </div>
  );
}

export function SilencePanel() {
  const p = useStore((s) => s.project!);
  useStore((s) => s.edlRev);
  const s = p.silence, c = p.cut;
  return (
    <div className="panel">
      <Stats />
      <FillersSection />
      <div className="row"><label className="row grow" style={{ color: 'var(--fg)' }}>
        <input type="checkbox" checked={s.enabled} onChange={(e) => S.setSilence({ enabled: e.target.checked })} /> Вырезать тишину
      </label>
        <button className="small" disabled={!S.levels} onClick={() => S.levels && S.setSilence({ thresholdDb: suggestThreshold(S.levels) })} title="Подобрать порог по громкости записи">Авто-порог</button>
      </div>
      <Field label="Порог тишины" min={-70} max={-15} step={1} value={s.thresholdDb} fmt={(v) => v + ' дБ'} onChange={(v) => S.setSilence({ thresholdDb: v })}
        title="Всё, что тише порога, считается тишиной. Его же можно тянуть на волне внизу." />
      <Field label="Пауза длиннее" min={0.3} max={5} step={0.1} value={s.minDuration} fmt={(v) => fmtSec(v)} onChange={(v) => S.setSilence({ minDuration: v })}
        title="Вырезаются только паузы не короче этого значения" />
      <Field label="Запас после речи" min={0} max={0.6} step={0.01} value={s.padBefore} fmt={(v) => fmtSec(v, 2)} onChange={(v) => S.setSilence({ padBefore: v })}
        title="Сколько тишины оставить после окончания фразы (левый край склейки)" />
      <Field label="Запас перед речью" min={0} max={0.6} step={0.01} value={s.padAfter} fmt={(v) => fmtSec(v, 2)} onChange={(v) => S.setSilence({ padAfter: v })}
        title="Сколько тишины оставить перед началом следующей фразы (правый край склейки)" />
      <details>
        <summary className="muted" style={{ cursor: 'pointer' }}>Склейки</summary>
        <div className="col" style={{ marginTop: 8 }}>
          <Field label="Плавность звука" min={0} max={0.05} step={0.001} value={c.fade} fmt={(v) => Math.round(v * 1000) + ' мс'} onChange={(v) => S.setCut({ fade: v })}
            title="Короткое затухание/нарастание звука на каждой склейке (убирает щелчки)" />
          <Field label="Запас у слов" min={0} max={0.12} step={0.005} value={c.wordMargin} fmt={(v) => Math.round(v * 1000) + ' мс'} onChange={(v) => S.setCut({ wordMargin: v })}
            title="Отступ от границ вырезанных слов" />
          <Field label="Мин. кусок" min={0} max={0.5} step={0.01} value={c.minKeep} fmt={(v) => Math.round(v * 1000) + ' мс'} onChange={(v) => S.setCut({ minKeep: v })}
            title="Оставшиеся между склейками кусочки короче этого выбрасываются" />
        </div>
      </details>
      <div className="row wrap">
        <button className="small ghost danger" onClick={() => { if (confirm('Вернуть всё вырезанное вручную и ИИ? (настройки тишины останутся)')) S.resetEdits(); }}>Сбросить правки</button>
      </div>
      <div className="hint tip">
        Выделите слова в тексте и нажмите <kbd>Delete</kbd>, чтобы вырезать (ещё раз — вернуть). Щелчок по паузе <span className="gap">1,2</span> вырезает или возвращает её.
        <kbd>Пробел</kbd> — воспроизведение, <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> — отмена и повтор, двойной щелчок — играть с этого слова.
      </div>
    </div>
  );
}

function FillersSection() {
  const p = useStore((s) => s.project!);
  useStore((s) => s.edlRev);
  const task = useStore((s) => s.task);
  const o = p.fillers || { sensitivity: 'normal' as const, autoCut: true };
  let n = 0, cut = 0;
  p.words.forEach((w, i) => { if (w.kind === 'filler') { n++; if (S.wordState[i]) cut++; } });
  const busy = !!task && task.kind !== 'models';
  const next = () => {
    const t = hub.player?.currentSrc ?? 0;
    let i = p.words.findIndex((w) => w.kind === 'filler' && w.start > t + 0.05);
    if (i < 0) i = p.words.findIndex((w) => w.kind === 'filler');
    if (i < 0) return;
    const w = p.words[i];
    S.setSelection({ a: i, b: i }); hub.scrollToWord?.(i, true);
    // listen in the source so the sound itself is heard even if it is cut
    if (!S.showOriginal) { S.showOriginal = true; S.bump(); }
    setTimeout(() => { hub.player?.seekSrc(Math.max(0, w.start - 1.2)); hub.player?.play(); }, 200);
  };
  return (
    <div className="card col" style={{ padding: 10, gap: 8 }}>
      <div className="row"><b className="grow">Звуки-паразиты <span className="dim" style={{ fontWeight: 400 }}>эээ, ааа, ммм</span></b>
        {o.scanned ? <span className="muted" style={{ fontSize: 13 }}>найдено {n}, вырезано {cut}</span> : null}</div>
      <div className="row wrap">
        <button className="small" disabled={busy || !S.pcm || !p.words.length} onClick={() => S.findFillers()}
          title="Найти звуки по записи: тянущиеся гласные и мычание в паузах между словами">{o.scanned ? 'Найти заново' : 'Найти'}</button>
        <select className="small" value={o.sensitivity} title="Чувствительность поиска"
          onChange={(e) => { S.fillerOpts().sensitivity = e.target.value as any; S.scheduleSave(); S.bump(); }}>
          <option value="low">строго</option><option value="normal">обычно</option><option value="high">чувствительно</option>
        </select>
        <label className="row" style={{ gap: 4, fontSize: 13 }} title="Сразу вырезать найденные звуки">
          <input type="checkbox" checked={o.autoCut} onChange={(e) => { S.fillerOpts().autoCut = e.target.checked; S.scheduleSave(); S.bump(); }} /> вырезать сразу
        </label>
      </div>
      {n > 0 && <div className="row wrap">
        <button className="small" disabled={cut === n} onClick={() => S.setAllFillers(true)}>Вырезать все</button>
        <button className="small" disabled={!cut} onClick={() => S.setAllFillers(false)}>Вернуть все</button>
        <button className="small ghost" onClick={next} title="Послушать следующий звук в исходнике (выделяется в тексте; Delete — вырезать/вернуть)">▶ Следующий</button>
      </div>}
      <div className="hint tip">В тексте они выглядят как <span className="w x fl">эээ</span>. Отдельный звук вырезается и возвращается как слово: щелчок и <kbd>Delete</kbd>.</div>
    </div>
  );
}
