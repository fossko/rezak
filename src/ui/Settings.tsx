import { useState } from 'react';
import { gpuDiagnostics } from '../lib/gpu';
import { S, prefs, savePrefs, useStore, GAIN_MODES, type GainMode } from '../store';
import { WHISPER_MODELS, disposeSpeechRPC, lastAsr } from '../transcribe/run';
import { LlmSettings } from './LlmSettings';
import { downloadModels, modelsReady } from './Home';
import { playChime } from '../lib/chime';

type Tab = 'ui' | 'stt' | 'llm' | 'audio';

/** Collapsible «Диагностика видеокарты»: how this browser sees the GPU (page + worker), plus the app's own state. */
function GpuDiagnostics() {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const run = () => {
    setText('Собираю сведения…'); setCopied(false);
    const deviceLabel = ({ auto: 'Авто', webgpu: 'Видеокарта (WebGPU)', wasm: 'Процессор (WASM)' } as Record<string, string>)[prefs.device] || prefs.device;
    const a = lastAsr;
    void gpuDiagnostics([
      `модель Whisper: ${prefs.model} · настройка «Вычисления»: ${deviceLabel}`,
      a ? `последняя загрузка Whisper: ${a.device === 'webgpu' ? 'видеокарта (WebGPU)' : 'процессор (WASM)'} · dtype ${JSON.stringify(a.dtype)}${a.why ? ' · причина: ' + a.why : ''}`
        : 'Whisper в этой вкладке ещё не загружался',
    ]).then(setText, (e) => setText('Ошибка: ' + (e?.message || e)));
  };
  return (
    <details data-gpu-diag onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && text == null) run(); }}>
      <summary style={{ cursor: 'pointer' }}>Диагностика видеокарты</summary>
      <div className="col" style={{ gap: 6, marginTop: 8 }}>
        <textarea readOnly value={text ?? ''} rows={14} spellCheck={false} className="mono"
          style={{ width: '100%', fontSize: 11.5, resize: 'vertical', whiteSpace: 'pre' }} onFocus={(e) => e.target.select()} />
        <div className="row">
          <button className="small" onClick={run}>Обновить</button>
          <button className="small" disabled={!text} onClick={() => { void navigator.clipboard.writeText(text || '').then(() => setCopied(true)); }}>{copied ? '✓ Скопировано' : 'Копировать'}</button>
        </div>
        <div className="hint tip">Как браузер видит видеокарту: есть ли WebGPU на странице и в фоновом потоке, где идёт расшифровка. Если расшифровка неожиданно идёт на процессоре, скопируйте этот текст разработчику.</div>
      </div>
    </details>
  );
}

export function Settings({ onClose, initial }: { onClose: () => void; initial: Tab }) {
  useStore((s) => s.version);
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="row"><h2 className="grow">Настройки</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="tabs" style={{ padding: 0 }}>
          <button className={tab === 'ui' ? 'on' : ''} onClick={() => setTab('ui')}>Интерфейс</button>
          <button className={tab === 'stt' ? 'on' : ''} onClick={() => setTab('stt')}>Распознавание речи</button>
          <button className={tab === 'llm' ? 'on' : ''} onClick={() => setTab('llm')}>ИИ (LLM)</button>
          <button className={tab === 'audio' ? 'on' : ''} onClick={() => setTab('audio')}>Звук</button>
        </div>
        {tab === 'ui' && (
        <div className="col" data-settings-ui>
        <div className="row wrap sound-row" data-hints-toggle>
          <span className="grow">Подсказки к приложению</span>
          <div className="seg">
            <button className={prefs.hints ? 'on' : ''} onClick={() => savePrefs({ hints: true })}>Вкл</button>
            <button className={!prefs.hints ? 'on' : ''} onClick={() => savePrefs({ hints: false })}>Выкл</button>
          </div>
        </div>
        <div className="hint tip" style={{ marginTop: -6 }}>Серые пояснения по всему приложению: что делает настройка, какие клавиши работают. Выключите, когда освоитесь, — интерфейс станет чище.</div>
        <div className="row wrap sound-row">
          <span className="grow">Сигнал, когда вся работа закончена</span>
          <div className="seg">
            <button className={prefs.sound !== false ? 'on' : ''} onClick={() => savePrefs({ sound: true })}>🔔 Звук</button>
            <button className={prefs.sound === false ? 'on' : ''} onClick={() => savePrefs({ sound: false })}>🔕 Без звука</button>
          </div>
          <button className="small ghost" onClick={() => playChime('done')} title="Послушать сигнал">▶</button>
        </div>
        <div className="hint tip" style={{ marginTop: -6 }}>Звучит один раз, когда закончились все задачи (например, весь быстрый путь), а не после каждого шага. Громкость — системная.</div>
        <div className="row wrap sound-row">
          <span className="grow">Скраб: короткий звук при выборе слова</span>
          <div className="seg">
            <button className={prefs.scrub !== false ? 'on' : ''} onClick={() => savePrefs({ scrub: true })}>Вкл</button>
            <button className={prefs.scrub === false ? 'on' : ''} onClick={() => savePrefs({ scrub: false })}>Выкл</button>
          </div>
          <label className="row" style={{ gap: 6 }} title="Сколько миллисекунд звука проигрывать с начала слова">
            <span className="dim">Длина</span>
            <input type="range" min={20} max={200} step={5} value={prefs.scrubMs} disabled={prefs.scrub === false}
              onChange={(e) => savePrefs({ scrubMs: +e.target.value })} style={{ width: 120 }} />
            <span className="mono" style={{ width: 46, textAlign: 'right' }}>{prefs.scrubMs} мс</span>
          </label>
        </div>
        <div className="hint tip" style={{ marginTop: -6 }}>При выборе слова проигрывается первый фрагмент его звука; при переходе к следующему слову старый звук обрывается, играет новый. На воспроизведение не влияет.</div>
        <div className="row wrap sound-row">
          <span className="grow">Выделение следует за воспроизведением</span>
          <div className="seg">
            <button className={prefs.selFollow ? 'on' : ''} onClick={() => savePrefs({ selFollow: true })}>Вкл</button>
            <button className={!prefs.selFollow ? 'on' : ''} onClick={() => savePrefs({ selFollow: false })}>Выкл</button>
          </div>
          <span className="dim">Opt+F</span>
        </div>
        <div className="hint tip" style={{ marginTop: -6 }}>Когда включено, текущее слово при воспроизведении выделяется само, и на паузе выделение становится на слово под воспроизведением. Когда выключено, выделение остаётся там, где вы щёлкнули. «Следовать» в панели текста — отдельная настройка: она только прокручивает текст за звуком.</div>
        </div>
        )}
        {tab === 'stt' && (
          <div className="col">
            <label className="col" style={{ gap: 4 }}>Модель Whisper
              <select value={prefs.model} onChange={(e) => { savePrefs({ model: e.target.value }); disposeSpeechRPC(); }}>
                {WHISPER_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <label className="col" style={{ gap: 4 }}>Вычисления
              <select value={prefs.device} onChange={(e) => { savePrefs({ device: e.target.value }); disposeSpeechRPC(); }}>
                <option value="auto">Авто (видеокарта, если есть)</option>
                <option value="webgpu">Видеокарта (WebGPU)</option>
                <option value="wasm">Процессор (WASM, медленно)</option>
              </select>
            </label>
            <div className="row">
              {modelsReady() ? <span className="ok grow">✓ Модели для выбранной настройки загружены</span> : <span className="muted grow">Модели ещё не загружены</span>}
              <button disabled={S.task?.kind === 'models'} onClick={() => downloadModels()}>{modelsReady() ? 'Проверить / загрузить снова' : 'Загрузить сейчас'}</button>
            </div>
            <div className="hint tip">Язык распознавания — русский. Точные границы слов дают wav2vec2 (русская модель) и анализ громкости.
              Модели хранятся в кэше браузера; Резак просит браузер не удалять их (постоянное хранилище).</div>
            <GpuDiagnostics />
          </div>
        )}
        {tab === 'llm' && <LlmSettings />}
        {tab === 'audio' && (
          <div className="col">
            <div className="row">
              <span className="grow">Цель по громкости</span>
              <input type="number" min={-24} max={-8} step={0.5} value={prefs.targetLufs} style={{ width: 80 }}
                onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) savePrefs({ targetLufs: Math.max(-24, Math.min(-8, v)) }); }} />
              <span className="dim">LUFS</span>
            </div>
            <div className="row">
              <span className="grow">Усиление звука</span>
              <select value={prefs.gainMode} data-gain-mode onChange={(e) => S.setGainMode(e.target.value as GainMode)}>
                {(Object.keys(GAIN_MODES) as GainMode[]).map((m) => <option key={m} value={m}>{GAIN_MODES[m].label}</option>)}
              </select>
            </div>
            {S.master && (S.master.mode ?? 'medium') !== prefs.gainMode && (
              <div className="row" data-gain-mode-project>
                <span className="dim grow">В открытом проекте — «{GAIN_MODES[S.master.mode ?? 'medium'].label}» (сделан с этим режимом).</span>
                <button className="small" onClick={() => S.setGainMode(prefs.gainMode)}>Применить «{GAIN_MODES[prefs.gainMode].label}» здесь</button>
              </div>
            )}
            <div className="hint">
              {(() => {
                const g = GAIN_MODES[prefs.gainMode], m = (v: number) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1).replace(/\.0$/, '');
                return `Компенсация — ${g.below ? `до ${m(prefs.targetLufs - g.below)} LUFS (на ${g.below} ниже цели)` : `ровно до цели (${m(prefs.targetLufs)} LUFS)`}, компрессор ${m(g.comp.thresholdDb)} дБ, ${g.comp.ratio}:1.`;
              })()}
              {' '}Действует на автоматическую обработку: в новом проекте — сразу, в открытом — на автоматическую компенсацию
              и компрессор, если их не меняли вручную. Ручные настройки на вкладке «Аудио» не трогаются.
            </div>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={prefs.phraseLeveler} onChange={(e) => void S.setPhraseLeveler(e.target.checked)} />
              <span className="grow">Выравнивание громкости по фразам</span>
            </label>
            <div className="hint tip">Поднимает тихие фразы и опускает громкие, меняя усиление только в паузах между ними.
              Выключено — громкость меняют только компрессор и компенсация после него (вкладка «Аудио»).</div>
            <div className="hint tip">YouTube, Spotify и другие нормализуют готовый файл к −14 LUFS и только ВНИЗ: если сделать
              громче, площадка просто убавит громкость, а запаса не останется. Эта цель используется на вкладке
              «Аудио»: от неё считается, какой из вариантов («сильно / просто / немного громче») предложить.</div>
            <div className="hint tip">Лимитер экспорта — −3 dBFS. Запас в 2 дБ от −1 dBTP нужен потому, что AAC-кодировщик сам добавляет до 1 дБ перегруза между сэмплами.</div>
          </div>
        )}
      </div>
    </div>
  );
}
