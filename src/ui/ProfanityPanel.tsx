import { useState } from 'react';
import { S, useStore } from '../store';
import { BASE_LIST, profCompile } from '../lib/profanity';
import { MU, WS } from '../lib/types';
import { clock } from '../lib/util';
import { hub } from './hub';

export function ProfanityPanel() {
  const p = useStore((s) => s.project!);
  useStore((s) => s.editRev);
  const task = useStore((s) => s.task);
  const o = S.profOpts();
  const [extra, setExtra] = useState(o.extra);
  const [exclude, setExclude] = useState(o.exclude);
  const badExtra = profCompile(extra).bad, badExclude = profCompile(exclude).bad;
  const hits = p.profHits || [];
  const busy = !!task && task.kind !== 'models' && task.kind !== 'fillers';
  const mutedAll = Array.from(S.wordMute).filter(Boolean).length;
  const status = (h: { from: number; to: number }) => {
    let m = false, c = false;
    for (let i = h.from; i <= h.to; i++) { if (S.wordMute[i]) m = true; if (S.wordState[i]) c = true; }
    return c ? 'cut' : m ? 'mute' : 'keep';
  };
  const go = (h: { from: number; to: number }, play: boolean) => {
    S.setSelection({ a: h.from, b: h.to }); hub.scrollToWord?.(h.from, true);
    const t = p.words[h.from].start;
    if (play) {
      // listen where it is in the result (a cut hit is heard as the join)
      if (S.showOriginal) { S.showOriginal = false; S.bump(); }
      setTimeout(() => { hub.player?.seekSrc(Math.max(0, t - 1.5)); hub.player?.play(); }, 150);
    } else hub.player?.seekSrc(t);
  };
  const clean = () => {
    S.setProfOpts({ extra, exclude });
    const n = S.cleanProfanity();
    S.toast(n ? `Мат: найдено ${n}, ${o.mode === 'mute' ? 'заглушено' : 'вырезано'}` : 'Мат в расшифровке не найден', 'ok');
  };
  return (
    <div className="panel">
      <div className="hint tip">Ищет русский мат в расшифровке: корни во всех формах и с приставками, фразы целиком. Границы слов уже точные (по звуку).</div>
      <div className="col" style={{ gap: 4 }}>
        <b style={{ fontSize: 13 }}>Базовый список (всегда включён)</b>
        <div className="col" style={{ gap: 2 }}>
          {BASE_LIST.map((b) => <div key={b.root} style={{ fontSize: 13 }}><b>{b.root}</b> <span className="dim">— {b.examples}</span></div>)}
        </div>
      </div>
      <label className="col" style={{ gap: 4 }}>Свои слова — через запятую
        <input value={extra} spellCheck={false} placeholder="сук*, мудак*, /^пид[оа]р/" onChange={(e) => setExtra(e.target.value)} onBlur={() => S.setProfOpts({ extra })} />
        <span className="hint tip">«*» — любые буквы (сук* = сука, суки, сукин…); можно регулярное выражение в слэшах: /^пид[оа]р/</span>
        {badExtra.length > 0 && <span className="err" style={{ fontSize: 12.5 }}>Не понял: {badExtra.join(', ')} — это не слово и не регулярное выражение</span>}
      </label>
      <label className="col" style={{ gap: 4 }}>Исключения — не трогать
        <input value={exclude} spellCheck={false} placeholder="хули, мать" onChange={(e) => setExclude(e.target.value)} onBlur={() => S.setProfOpts({ exclude })} />
        {badExclude.length > 0 && <span className="err" style={{ fontSize: 12.5 }}>Не понял: {badExclude.join(', ')}</span>}
      </label>
      <div className="row wrap">
        <span>Что делать:</span>
        <div className="seg">
          <button className={o.mode === 'mute' ? 'on' : ''} onClick={() => S.setProfOpts({ mode: 'mute' })} title="Выключить звук на слове; длина и картинка не меняются">Заглушить</button>
          <button className={o.mode === 'cut' ? 'on' : ''} onClick={() => S.setProfOpts({ mode: 'cut' })} title="Вырезать слово из записи, как при монтаже">Вырезать</button>
        </div>
      </div>
      <details>
        <summary className="muted" style={{ cursor: 'pointer' }}>Заглушение</summary>
        <div className="col" style={{ marginTop: 8 }}>
          <div className="field"><label>Запас вокруг слова</label>
            <input type="range" min={0} max={150} step={5} value={o.marginMs} onChange={(e) => S.setProfOpts({ marginMs: +e.target.value })} />
            <span className="v">{o.marginMs} мс</span></div>
          <div className="field"><label>Плавность</label>
            <input type="range" min={1} max={40} step={1} value={o.fadeMs} onChange={(e) => S.setProfOpts({ fadeMs: +e.target.value })} />
            <span className="v">{o.fadeMs} мс</span></div>
        </div>
      </details>
      <div className="row wrap">
        <button className="primary" disabled={busy || !p.words.length || badExtra.length > 0 || badExclude.length > 0} onClick={clean}>Почистить мат</button>
        {hits.length > 0 && <button className="small ghost danger" onClick={() => S.clearProfanity()}>Вернуть всё</button>}
      </div>
      <div className="hint tip">Любое слово можно заглушить вручную: выделите его в тексте и нажмите <kbd>M</kbd> (ещё раз — снять). Заглушённые слова выглядят <span className="w mu">так</span>.
        {mutedAll ? ` Сейчас заглушено слов: ${mutedAll}.` : ''} Заглушать ли их в видео и в MP3 — выбирается при экспорте (у аудиопроекта есть только MP3).</div>

      {hits.length > 0 && <>
        <b style={{ marginTop: 4 }}>Найдено: {hits.length}</b>
        <div className="col" style={{ gap: 6 }}>
          {hits.map((h, k) => {
            const st = status(h);
            const text = p.words.slice(h.from, h.to + 1).map((w) => w.text).join(' ');
            const before = p.words.slice(Math.max(0, h.from - 5), h.from).map((w) => w.text).join(' ');
            const after = p.words.slice(h.to + 1, h.to + 6).map((w) => w.text).join(' ');
            return (
              <div key={k} className="sugg" onClick={() => go(h, false)}>
                <div className="row">
                  <span className="dim mono" style={{ fontSize: 11.5 }}>{clock(p.words[h.from].start)}</span>
                  <span className="tag">{h.kind}</span>
                  <span className="grow" />
                  <button className="small ghost" title="Послушать результат" onClick={(e) => { e.stopPropagation(); go(h, true); }}>▶</button>
                  <div className="seg" onClick={(e) => e.stopPropagation()}>
                    <button className={st === 'mute' ? 'on' : ''} onClick={() => S.setHitTreatment(h, 'mute')}>заглушить</button>
                    <button className={st === 'cut' ? 'on' : ''} onClick={() => S.setHitTreatment(h, 'cut')}>вырезать</button>
                    <button className={st === 'keep' ? 'on' : ''} onClick={() => S.setHitTreatment(h, 'keep')}>оставить</button>
                  </div>
                </div>
                <div className="q"><span className="dim">…{before} </span><span className={st === 'mute' ? 'w mu' : st === 'cut' ? 'w rm' : ''}>{text}</span><span className="dim"> {after}…</span></div>
              </div>
            );
          })}
        </div>
      </>}
    </div>
  );
}
export { MU, WS };
