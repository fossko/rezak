import { useEffect } from 'react';
import { S, prefs, useStore, aimLufs, gainMode, GAIN_MODES } from '../store';
import { DEFAULT_DUCK, type DuckSettings } from '../lib/dsp';

// YouTube (and Spotify/Tidal/Amazon) normalise playback to about -14 LUFS integrated and expect the
// master to stay under -1 dBTP. YouTube only turns loud material DOWN, so a louder master buys nothing.
// The target itself is a global setting (prefs.targetLufs, ⚙), so meter, leveler and export agree.
const SCALE_MIN = -30, SCALE_MAX = -6;

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const pct = (v: number) => Math.max(0, Math.min(100, ((v - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100));

type Choice = 'p15' | 'p11' | 'p8' | 'comp' | 'none';

/** The four answers to "how loud should it be"; the number is the cap on phrase gain. */
const OPTIONS: { id: Choice; db: number; title: string; sub: string }[] = [
  { id: 'p15', db: 15, title: 'Сильно громче', sub: 'фразы до +15 дБ + компрессор' },
  { id: 'p11', db: 11, title: 'Просто громче', sub: 'фразы до +11 дБ + компрессор' },
  { id: 'p8', db: 8, title: 'Немного громче', sub: 'фразы до +8 дБ + компрессор' },
  { id: 'none', db: 0, title: 'Не обрабатывать', sub: 'оставить исходный звук' },
];
/** Phrase leveling off (⚙ «Звук»): the caps mean nothing, only "process or not". */
const OPTIONS_COMP: typeof OPTIONS = [
  { id: 'comp', db: 15, title: 'Обработать', sub: 'компрессор + компенсация до цели, без выравнивания по фразам' },
  { id: 'none', db: 0, title: 'Не обрабатывать', sub: 'оставить исходный звук' },
];

/** Which variant fits the measured delta — the target itself lives in the app settings. */
function recommend(needDb: number): Choice {
  if (!Number.isFinite(needDb) || needDb < 1) return 'none';
  // Smallest preset that can cover the delta: a cap below it saturates every phrase and lands short.
  if (needDb <= 8) return 'p8';
  if (needDb <= 11) return 'p11';
  return 'p15';
}

/** Why the audio settings are not available yet — says exactly what the app is doing right now. */
function pendingReason(taskKind: string | undefined): string {
  switch (taskKind) {
    case 'models': return 'Идёт скачивание моделей';
    case 'transcribe': return 'Идёт расшифровка';
    case 'extract': return 'Идёт извлечение звука';
    case 'open': return 'Читаю файл';
    case 'fillers': return 'Ищу звуки-паразиты';
    default: return 'Звук ещё не извлечён';
  }
}

type CompKey = 'thresholdDb' | 'ratio' | 'attackMs' | 'releaseMs';
function Knob({ label, unit, min, max, step, value, k }: { label: string; unit: string; min: number; max: number; step: number; value: number; k: CompKey }) {
  return (
    <label className="row" style={{ gap: 8 }} data-knob={k}>
      <span style={{ width: 112 }}>{label}</span>
      <input className="grow" type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => S.setCompressor({ [k]: +e.target.value })} />
      <span className="mono" style={{ width: 64, textAlign: 'right' }}>{k === 'ratio' ? value.toFixed(1) : f1(value)}{unit === ':1' ? ':1' : ' ' + unit}</span>
    </label>
  );
}

function DuckKnob({ label, unit, min, max, step, value, k }: { label: string; unit: string; min: number; max: number; step: number; value: number; k: keyof DuckSettings }) {
  return (
    <label className="row" style={{ gap: 8 }} data-duck={k}>
      <span style={{ width: 112 }}>{label}</span>
      <input className="grow" type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => S.setDuck({ [k]: +e.target.value })} />
      <span className="mono" style={{ width: 64, textAlign: 'right' }}>{k === 'depthDb' ? (value < 0 ? '−' + f1(-value) : '0') : Math.round(value)} {unit}</span>
    </label>
  );
}

function Pending({ taskKind, taskText, frac }: { taskKind?: string; taskText?: string; frac?: number }) {
  return (
    <div className="panel">
      <div style={{ fontSize: 14 }}>Настройка звука появится после извлечения звука</div>
      <div className="muted">{pendingReason(taskKind)}</div>
      {taskText !== undefined && (
        <div className="row">
          <span className="spin" />
          <span className="dim grow">{taskText}</span>
          <span className="mono dim">{Math.round((frac ?? 0) * 100)}%</span>
        </div>
      )}
      <div className="hint tip">Как только звук будет извлечён, я сам измерю громкость (LUFS) и обработаю его — нажимать ничего не нужно. Расшифровка для этого не нужна.</div>
    </div>
  );
}

const RESTORE_STEPS = [0, 20, 40, 60, 80, 100];
const mb = (b: number) => Math.round(b / 1e6);

/** «Реставрация»: Sidon speech restoration, dry/wet. First in the chain — before the silence ducking and the
 *  compressor, so the restorer never works on squashed sound. Never blocks: the model loads (and tiles render)
 *  only while no other task runs; the full recording is restored only by the export. */
function RestoreSection() {
  const p = S.project!, R = S.restorer, v = p.restore ?? 0, t = S.task;
  let status: { text: string; cls: string; spin?: boolean };
  if (!v) status = { text: 'Выключено. При включении скачается модель (≈ 600 МБ, один раз).', cls: 'dim' };
  else if (R.status === 'error') status = { text: 'Ошибка: ' + R.error, cls: 'err' };
  else if (R.status === 'waiting') status = { text: t
    ? `Модель скачается и запустится, когда закончится текущая операция (${t.text.replace(/\s*\d+%.*$/, '')}). Можно продолжать монтаж.`
    : 'Модель запустится, как только будет готов звук.', cls: 'dim' };
  else if (R.status === 'download') status = { text: `Скачиваю модель… ${R.dl.total ? Math.round(R.dl.done / R.dl.total * 100) : 0}% (${mb(R.dl.done)} из ${mb(R.dl.total || 597e6)} МБ)`, cls: 'dim', spin: true };
  else if (R.status === 'init') status = { text: 'Запускаю модель на видеокарте…', cls: 'dim', spin: true };
  else if (t && t.kind !== 'export') status = { text: `Пауза, пока идёт операция: ${t.text.replace(/\s*\d+%.*$/, '')}. Слышно то, что уже готово.`, cls: 'dim' };
  else status = { text: `Готово около курсора: ${R.cached} × ${10} с${R.ep === 'wasm' ? ' · без видеокарты, медленно' : ''}. Вся запись — при экспорте.`, cls: 'ok' };
  return (
    <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }} data-testid="restore">
      <div className="row">
        <b className="grow">Реставрация</b>
        <span className="mono" style={{ width: 48, textAlign: 'right' }}>{v}%</span>
      </div>
      <input type="range" min={0} max={100} step={20} value={v} list="restore-steps" data-restore-slider
        onChange={(e) => S.setRestore(+e.target.value)} />
      <datalist id="restore-steps">{RESTORE_STEPS.map((x) => <option key={x} value={x} />)}</datalist>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: 11.5, color: 'var(--fg3)' }}>
        {RESTORE_STEPS.map((x) => <span key={x} style={{ cursor: 'pointer' }} onClick={() => S.setRestore(x)}>{x}</span>)}
      </div>
      <div className={'row ' + status.cls} style={{ fontSize: 12.5, gap: 6 }} data-restore-status={R.status}>
        {status.spin && <span className="spin" />}<span className="grow">{status.text}</span>
        {R.status === 'error' && <button className="small" onClick={() => R.retry()}>Повторить</button>}
      </div>
      <div className="hint tip">
        Нейросеть Sidon восстанавливает речь «как в студии»: убирает гул и эхо комнаты, добавляет низ, смягчает
        свистящие. 0 — исходный звук, 100 — только восстановленный. Стоит первой в цепочке, до приглушения тишины и
        компрессора. Считается в фоне впереди курсора; короткие не-речевые звуки (щелчки, музыка) может приглушать.
      </div>
    </div>
  );
}

export function AudioPanel() {
  useStore((s) => s.version);
  const a = S.audio, p = S.project;
  const bypass = prefs.audioBypass;
  const pcmReady = !!S.pcm;
  const applied = S.master;

  // Measure as soon as the sound is extracted — no need to wait for the transcript: the block model is
  // instant and, without words, phrases come from the pauses (S.speechWords).
  useEffect(() => {
    if (p && pcmReady && !S.audio && !S.audioBusy) void S.analyzeAudio();
  }, [p?.id, pcmReady]);

  if (!p) return <div className="panel"><div className="dim">Откройте запись — тогда измерю громкость.</div></div>;

  if (!pcmReady) {
    const t = S.task;
    return <Pending taskKind={t?.kind} taskText={t?.text} frac={t?.frac} />;
  }

  if (!a) {
    const t = S.task;
    if (t?.kind === 'loudness' || S.audioBusy) {
      const frac = t?.kind === 'loudness' ? t.frac : S.live.analyzeFrac;
      return (
        <div className="panel">
          <div style={{ fontSize: 14 }}>Измеряю громкость…</div>
          <div className="row">
            <span className="spin" />
            <span className="dim grow">Замер громкости (LUFS)…</span>
            <span className="mono dim">{Math.round(frac * 100)}%</span>
          </div>
        </div>
      );
    }
    return (
      <div className="panel">
        <div className="dim">Громкость ещё не измерена.</div>
        <button className="primary" disabled={!S.pcm || S.audioBusy} onClick={() => void S.analyzeAudio()}>Измерить громкость</button>
      </div>
    );
  }

  // The recommendation is based on the ORIGINAL sound, so it does not move after processing.
  const base = (S.audioBase ?? a).integrated;
  const target = prefs.targetLufs;
  const need = target - base;
  const lev = prefs.phraseLeveler;
  const opts = lev ? OPTIONS : OPTIONS_COMP;
  const rec: Choice = lev ? recommend(need) : (Number.isFinite(need) && need >= 1 ? 'comp' : 'none');
  const appliedChoice: Choice = !applied ? 'none'
    : applied.opt.leveler === false ? 'comp'
      : applied.opt.maxGainDb >= 15 ? 'p15' : applied.opt.maxGainDb >= 11 ? 'p11' : 'p8';

  // Choosing a variant applies it at once: the block model recalibrates in milliseconds, the exact
  // loudness follows from the background worker.
  const choose = (id: Choice) => {
    const o = opts.find((x) => x.id === id);
    if (!o) return;
    if (o.db <= 0) S.revertMaster();
    else void S.applyMaster({ kind: 'leveler', maxGainDb: o.db, targetLufs: aimLufs() });
  };

  // Under the meter: the exact measurement of what is on the timeline; while the worker is still
  // measuring after a change, the model's prediction marked with «≈».
  const exact = bypass ? true : (!applied || applied.lufs != null);
  const cur = bypass ? base : (applied ? (applied.lufs ?? applied.modelLufs) : a.integrated);
  const diff = cur - target;
  const loud = bypass
    ? { t: 'Обработка звука обойдена — играет и экспортируется исходный звук', c: 'dim' }
    : !Number.isFinite(cur)
      ? { t: 'Тишина: в записи нет звука выше −70 LUFS', c: 'dim' }
      : Math.abs(diff) <= 1 ? { t: 'В норме для YouTube', c: 'ok' }
        : diff > 0 ? { t: `Громче цели на ${f1(diff)} LU — YouTube убавит громкость`, c: 'err' }
          : { t: `Тише цели на ${f1(-diff)} LU`, c: 'dim' };
  const comp = applied?.comp;
  const makeupAuto = applied?.makeupAuto !== false;

  return (
    <div className="panel">
      <fieldset className="audio-controls" disabled={bypass}>
      <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
        <span className="mono" style={{ fontSize: 30, lineHeight: 1, opacity: exact ? 1 : 0.6 }} data-testid="lufs">{exact ? '' : '≈'}{f1(cur)}</span>
        <span className="dim">LUFS сейчас</span>
        {applied && <span className="ok" style={{ marginLeft: 'auto' }}>было {f1(base)}</span>}
      </div>
      <div className={loud.c} style={{ fontSize: 13 }}>
        {loud.t}
        {!exact && <span className="dim"> · уточняю{S.live.measureFrac > 0 && S.live.measureFrac < 1 ? ` ${Math.round(S.live.measureFrac * 100)}%` : '…'}</span>}
        {applied?.capped && <span className="err"> · не хватает запаса усиления</span>}
      </div>

      <div style={{ position: 'relative', height: 10, background: 'var(--bg3)', borderRadius: 5, marginTop: 2 }}>
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${pct(target - 1)}%`, width: `${pct(target + 1) - pct(target - 1)}%`, background: 'rgba(108,194,138,.30)', borderRadius: 5 }} />
        <div title={`цель ${target} LUFS`} style={{ position: 'absolute', top: -3, bottom: -3, left: `${pct(target)}%`, width: 1, background: 'var(--green)' }} />
        {Number.isFinite(cur) && <div title={`${f1(cur)} LUFS`} style={{ position: 'absolute', top: -4, bottom: -4, left: `calc(${pct(cur)}% - 2px)`, width: 4, borderRadius: 2, background: 'var(--acc)', opacity: exact ? 1 : 0.5 }} />}
      </div>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: 11.5, color: 'var(--fg3)' }}>
        <span>−30</span><span>цель {f1(target)}</span><span>−6</span>
      </div>

      <RestoreSection />

      {!lev && !applied && (
        <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <span className="dim grow">Обработка звука выключена</span>
          <button className="primary small" data-variant="comp" onClick={() => choose('comp')}>Включить обработку</button>
        </div>
      )}

      {lev && <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <div className="row">
          <b className="grow">Как выровнять</b>
          <span className="dim">{rec === 'none' ? 'громкость в норме' : `по дельте: ${f1(need)} LU`}</span>
        </div>
        {opts.map((o) => (
          <div key={o.id} className="sugg" data-variant={o.id} style={{ cursor: 'pointer', outline: appliedChoice === o.id ? '1px solid var(--acc)' : 'none' }}
            onClick={() => choose(o.id)}>
            <div className="row">
              <span className="grow">
                <b>{o.title}</b>{o.id === rec && <span className="ok"> · рекомендую</span>}
                <br /><span className="dim">{o.sub}</span>
              </span>
              {appliedChoice === o.id && <span className="ok">✓</span>}
            </div>
          </div>
        ))}
        <div className="hint tip">Вариант применяется сразу: волна и звук меняются мгновенно, точный LUFS досчитывается в фоне.</div>
      </div>}

      {applied && (() => { const d = { ...DEFAULT_DUCK, ...(applied.duck || {}) }; const on = d.depthDb < -0.01; return (
        <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }} data-testid="duck">
          <div className="row">
            <b className="grow">Приглушение тишины</b>
            <span className="dim mono">{on ? `${applied.duckRegions} участков` : 'выключено'}</span>
          </div>
          <DuckKnob label="Атака" unit="мс" min={1} max={200} step={1} value={d.attackMs} k="attackMs" />
          <DuckKnob label="Степень" unit="дБ" min={-20} max={0} step={0.5} value={d.depthDb} k="depthDb" />
          <DuckKnob label="Восстановление" unit="мс" min={1} max={200} step={1} value={d.releaseMs} k="releaseMs" />
          <div className="hint tip">
            Плавно делает тише участки под порогом тишины, которые остались в записи (вдохи, короткие паузы).
            Атака начинается в начале участка, восстановление заканчивается к его концу — речь вокруг не задевается.
            Если участок короче атаки + восстановления, рампы встречаются посередине и он приглушается меньше. Порог — с вкладки «Тишина».
          </div>
        </div>); })()}

      {applied && comp && (
        <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div className="row">
            <b className="grow">Компрессор</b>
            <span className="dim mono" title="Наибольшее сжатие и автоматическая компенсация громкости после компрессора">сжатие до −{f1(applied.exactGrDb ?? applied.maxGrDb)} дБ · компенсация +{f1(applied.makeupDb ?? 0)} дБ{makeupAuto ? ' (авто)' : ''}</span>
          </div>
          <Knob label="Порог" unit="дБ" min={-30} max={0} step={0.5} value={comp.thresholdDb} k="thresholdDb" />
          <Knob label="Степень" unit=":1" min={1} max={20} step={0.5} value={comp.ratio} k="ratio" />
          <Knob label="Атака" unit="мс" min={0.5} max={100} step={0.5} value={comp.attackMs} k="attackMs" />
          <Knob label="Восстановление" unit="мс" min={10} max={1000} step={5} value={comp.releaseMs} k="releaseMs" />
          <label className="row" style={{ gap: 8 }} data-knob="makeupDb" title="Make-up: постоянное усиление после компрессора. «Авто» подбирает его так, чтобы громкость дошла до цели">
            <span style={{ width: 112 }}>Компенсация</span>
            <input className="grow" type="range" min={0} max={30} step={0.5} value={applied.makeupDb ?? 0}
              onChange={(e) => S.setMakeup(+e.target.value)} />
            <span className="mono" style={{ width: 64, textAlign: 'right' }}>+{f1(applied.makeupDb ?? 0)} дБ</span>
          </label>
          <div className="row" style={{ gap: 8 }}>
            <span style={{ width: 112 }} />
            <label className="row grow" style={{ gap: 6 }} data-makeup-auto>
              <input type="checkbox" checked={makeupAuto} onChange={(e) => S.setMakeupNow(e.target.checked ? null : applied.makeupDb ?? 0)} />
              <span>авто — до {f1(aimLufs())} LUFS ({GAIN_MODES[gainMode()].label.toLowerCase()}{GAIN_MODES[gainMode()].below > 0 ? `: на ${f1(GAIN_MODES[gainMode()].below)} ниже цели ${f1(target)}` : ': ровно в цель'})</span>
            </label>
          </div>
          <div className="row">
            <button className="small ghost" onClick={() => { S.resetCompressor(); }}>Сбросить компрессор</button>
          </div>
          <div className="hint tip">
            {lev ? 'Усиление фраз меняется только в паузах, затем компрессор' : 'Компрессор'} и лимитер −3 dBFS (запас под AAC). Громкость
            после компрессора {makeupAuto ? `автоматически подтягивается к цели (компенсация до +${lev ? 12 : 30} дБ)` : 'задаётся ползунком «Компенсация» — громкость может не совпасть с целью'}. Волна перерисовывается сразу по модели, видимый
            участок затем уточняется точным расчётом; в экспорт идёт точный расчёт всей записи.
          </div>
        </div>
      )}

      <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <button className="small ghost" disabled={S.audioBusy} onClick={() => void S.remeasureAudio()}>Пересчитать LUFS</button>
        <button className="small ghost" onClick={() => S.openSettings('audio')}>Цель: {f1(target)} LUFS ⚙</button>
      </div>
      <div className="hint tip">
        Замер идёт по моно-PCM 16 кГц, который уже есть для распознавания: для речи в центре это точно, для
        широкого стерео музыкальных вставок может отличаться на 1–3 дБ. YouTube нормализует к цели и только
        вниз, потолок лимитера −3 dBFS: запас на перегруз AAC при кодировании.
      </div>
      </fieldset>
      <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }} data-testid="audio-bypass">
        <span className={bypass ? 'ok grow' : 'dim grow'}>
          {bypass ? 'Обход включён: обработка не применяется' : 'Обработка звука применяется'}
        </span>
        <button className={bypass ? 'primary small' : 'small'} data-audio-bypass onClick={() => S.setAudioBypass(!bypass)}>
          {bypass ? 'Включить обработку звука' : 'Обойти обработку звука'}
        </button>
      </div>
      <div className="hint tip">
        Обход отключает реставрацию, выравнивание, приглушение тишины, компрессор, лимитер и компенсацию —
        и в предпросмотре, и в экспорте. Выбор запоминается на этом устройстве и применяется к будущим проектам.
      </div>
    </div>
  );
}
