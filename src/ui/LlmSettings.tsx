import { useId, useState } from 'react';
import { LLM_PROVIDERS, loadLlmSettings, saveLlmSettings, type LlmSettingsData } from '../llm/client';
import { ModelPicker } from './ModelPicker';
import { testConnection } from '../llm/carve';
import { loadSteps } from '../llm/pipeline';
import { ChatGptPlan } from './ChatGptPlan';

export function LlmSettings() {
  const [s, setS] = useState<LlmSettingsData>(loadLlmSettings());
  const [steps] = useState(() => loadSteps());
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [showSubscription, setShowSubscription] = useState(false);
  const subscriptionId = useId();
  const upd = (p: Partial<LlmSettingsData>) => { const n = { ...s, ...p }; setS(n); saveLlmSettings(n); };
  const stepModels = s.stepModels || {};
  const setStepModel = (id: string, model: string) => upd({ stepModels: { ...stepModels, [id]: model } });
  const test = async () => {
    setMsg({ t: 'Проверка… (у «думающих» моделей может занять полминуты)', ok: true });
    try {
      const r = await testConnection();
      setMsg({ t: 'Подключение работает: ' + r, ok: true });
    } catch (e: any) { setMsg({ t: e.message || String(e), ok: false }); }
  };
  const prov = LLM_PROVIDERS[s.provider];
  return (
    <div className="col">
      <div className="row">
        <button type="button" className="ghost" aria-expanded={showSubscription} aria-controls={subscriptionId}
          onClick={() => setShowSubscription(!showSubscription)}>
          Подключить подписку
        </button>
      </div>
      <div id={subscriptionId} hidden={!showSubscription}>
        <h3>ChatGPT в Rezak</h3>
        {showSubscription && <ChatGptPlan active={!!s.chatGptPlan} model={s.chatGptModel}
          onSelect={model => upd(model ? { chatGptPlan: true, chatGptModel: model } : { chatGptPlan: false })} />}
        <h3>Codex (ChatGPT)</h3>
        <ol>
          <li>Включите вход по коду устройства в настройках безопасности ChatGPT.</li>
          <li>В терминале с установленным Codex выполните <code>codex login --device-auth</code>.</li>
          <li>Откройте <a href="https://auth.openai.com/codex/device" target="_blank" rel="noreferrer">auth.openai.com/codex/device</a>, войдите в ChatGPT и введите одноразовый код из терминала.</li>
        </ol>
        <a href="https://learn.chatgpt.com/docs/auth#login-on-headless-devices" target="_blank" rel="noreferrer">Справка по входу в Codex</a>
      </div>
      <div className="hint tip">Подходит любой сервис с OpenAI-совместимым API. Ключ хранится только в этом браузере. В сервис отправляется только текст расшифровки.</div>
      <label className="col" style={{ gap: 4 }}>Сервис
        <select value={s.provider} onChange={(e) => { const p = LLM_PROVIDERS[e.target.value]; upd({ provider: e.target.value, url: p.url || s.url, model: '' }); setMsg(null); }}>
          {Object.entries(LLM_PROVIDERS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
      </label>
      <label className="col" style={{ gap: 4 }}>Адрес API
        <input value={s.url} onChange={(e) => upd({ url: e.target.value })} placeholder="https://…/v1" spellCheck={false} />
      </label>
      <label className="col" style={{ gap: 4 }}>API-ключ
        <div className="row"><input className="grow" type={showKey ? 'text' : 'password'} value={s.key} onChange={(e) => upd({ key: e.target.value })} placeholder={prov?.noKey ? 'обычно не нужен' : 'sk-…'} autoComplete="off" spellCheck={false} />
          <button className="small ghost" onClick={() => setShowKey(!showKey)}>{showKey ? 'скрыть' : 'показать'}</button></div>
      </label>
      <div className="col" style={{ gap: 4 }}><label>Модель</label>
        <ModelPicker settings={{ ...s, chatGptPlan: false }} onChange={(model) => { upd({ model }); setMsg(null); }} />
        <span className="hint tip">Список моделей загружается у сервиса, когда вы открываете его или меняете адрес / ключ.</span>
      </div>
      <details>
        <summary className="muted" style={{ cursor: 'pointer' }}>Модели по шагам — необязательно</summary>
        <div className="col" style={{ marginTop: 8, gap: 6 }}>
          <div className="hint tip">Пусто — используется основная модель. Например: «Орфография» — deepseek-chat, «Структурированный текст» — deepseek-reasoner. Модель применяется и к объединению длинных текстов этого этапа. Для thinking-моделей поднимите «Макс. токенов ответа» (например, 32 000): иначе рассуждение может занять весь лимит и ответ обрежется.</div>
          {steps.filter((st) => st.id !== 'custom').map((st) => (
            <label key={st.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span style={{ minWidth: 190, fontSize: 13 }}>{st.name}</span>
              <input className="grow" style={{ fontSize: 13 }} data-step-model={st.id} value={stepModels[st.id] || ''} placeholder={s.model || 'как основная'} onChange={(e) => setStepModel(st.id, e.target.value)} spellCheck={false} />
            </label>
          ))}
        </div>
      </details>
      <label className="col" style={{ gap: 4 }}>Размышления модели
        <select value={s.thinking || 'auto'} onChange={(e) => upd({ thinking: e.target.value as LlmSettingsData['thinking'] })}>
          <option value="auto">как решит модель — точнее, но первый ответ может ждать 30+ с</option>
          <option value="low">поменьше — быстрее (DeepSeek, OpenAI)</option>
          <option value="off">выключить — сразу отвечает, но ИИ-монтаж заметно хуже</option>
        </select>
        <span className="hint tip">«Думающие» модели (DeepSeek, Qwen 3, Gemma 4…) сначала рассуждают, а потом отвечают. Пока они рассуждают, Резак показывает «модель размышляет · N симв.». Без размышлений небольшие модели режут целые осмысленные фразы.</span>
      </label>
      <div className="row"><button className="primary" onClick={test}>Проверить подключение</button>
        {msg && <span className={msg.ok ? 'ok' : 'err'} style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{msg.t}</span>}</div>
      <details>
        <summary className="muted" style={{ cursor: 'pointer' }}>Дополнительно</summary>
        <div className="col" style={{ marginTop: 8 }}>
          <div className="row wrap">
            <label className="col" style={{ gap: 4 }}>Температура<input style={{ width: 90 }} value={s.temperature} onChange={(e) => upd({ temperature: e.target.value })} placeholder="по умолч." /></label>
            <label className="col" style={{ gap: 4 }}>Макс. токенов ответа<input style={{ width: 120 }} value={s.maxTokens} onChange={(e) => upd({ maxTokens: e.target.value })} placeholder="не задано" /></label>
            <label className="col" style={{ gap: 4 }}>Фрагмент, символов<input style={{ width: 110 }} value={s.chunkChars} onChange={(e) => upd({ chunkChars: e.target.value })} /></label>
            <span className="hint tip" style={{ alignSelf: 'end', maxWidth: 260 }}>По умолчанию 20 000: текст 13–17 тыс. символов идёт одним запросом без склейки. Меньше — для слабых моделей.</span>
            <label className="col" style={{ gap: 4 }}>Запросов сразу<input style={{ width: 80 }} value={s.parallel} onChange={(e) => upd({ parallel: e.target.value })} /></label>
          </div>
          <label className="col" style={{ gap: 4 }}>Доп. параметры запроса (JSON)<input value={s.extraBody} onChange={(e) => upd({ extraBody: e.target.value })} placeholder='{"reasoning_effort": "low"}' spellCheck={false} /></label>
          <label className="col" style={{ gap: 4 }}>Доп. HTTP-заголовки (JSON)<input value={s.extraHeaders} onChange={(e) => upd({ extraHeaders: e.target.value })} placeholder='{"X-Title": "Резак"}' spellCheck={false} /></label>
        </div>
      </details>
    </div>
  );
}
