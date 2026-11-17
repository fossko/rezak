import { useEffect, useState } from 'react';
import { listChatGptModels } from '../llm/client';

const base = '/api/chatgpt-plan/';
type Model = { id: string; name: string };

async function call<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Подписка ChatGPT доступна в локальном Rezak по адресу 127.0.0.1.');
  }
  return response.json();
}

export function ChatGptPlan({ active, model, onSelect }: {
  active: boolean; model?: string; onSelect: (model: string | null) => void;
}) {
  const [state, setState] = useState('');
  const [account, setAccount] = useState('');
  const [link, setLink] = useState('');
  const [message, setMessage] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    let requestId = 0;
    async function update() {
      clearTimeout(timer);
      const id = ++requestId;
      try {
        const { state, account } = await call<{ state: string; account?: string }>('status');
        if (!current || id !== requestId) return;
        setState(state);
        setAccount(account || '');
        if (state === 'pending' || state === 'exchanging') timer = setTimeout(update, 1200);
        else setLink('');
      } catch {
        if (current && id === requestId) setState('offline');
      }
    }
    void update();
    window.addEventListener('focus', update);
    return () => {
      current = false;
      clearTimeout(timer);
      window.removeEventListener('focus', update);
    };
  }, [link, busy]);

  useEffect(() => {
    if (state !== 'connected') { setModels([]); return; }
    let current = true;
    void listChatGptModels().then(models => {
      if (current) setModels(models);
    }).catch(() => {
      if (current) setMessage('Список моделей подписки недоступен. Проверьте доступ в ChatGPT или войдите заново.');
    });
    return () => { current = false; };
  }, [state]);

  const start = async () => {
    setBusy(true);
    setMessage('');
    try {
      const key = 'carver:chatgpt-host';
      const hostId = localStorage.getItem(key) || `urn:uuid:${crypto.randomUUID()}`;
      localStorage.setItem(key, hostId);
      const { url } = await call<{ url: string }>('start', { hostId });
      if (new URL(url).origin !== 'https://auth.openai.com') throw new Error('Получен неверный адрес входа.');
      setLink(url);
      setState('pending');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true);
    setMessage('');
    try {
      const { state, revoked } = await call<{ state: string; revoked: boolean }>('stop', {});
      setState(state);
      setLink('');
      if (!revoked) setMessage('Локальный сеанс завершён. Отзыв доступа можно проверить в настройках ChatGPT.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const waiting = state === 'pending' || state === 'exchanging';
  const notices: Record<string, string> = {
    offline: 'Откройте локальный Rezak по адресу 127.0.0.1.',
    cancelled: 'Вход отменён.',
    expired: 'Сеанс истёк. Войдите снова.',
    unavailable: 'Аккаунт вошёл, но разрешение на использование подписки не получено.',
    error: 'Не удалось завершить вход в ChatGPT.',
  };
  return <div className="col">
    <div className="hint">Подписка используется для запущенных вами ИИ-операций, включая пакетную обработку. Сеанс действует до остановки локального сервера или выхода.</div>
    <div className="row wrap">
      {state === 'connected' || waiting
        ? <button type="button" className="ghost" disabled={busy || state === 'exchanging'} onClick={stop}>{waiting ? 'Отменить вход' : 'Отключить ChatGPT'}</button>
        : <button type="button" className="ghost" disabled={busy || state === 'offline' || !state} onClick={start}>Продолжить с ChatGPT</button>}
      {link && <a href={link} target="_blank" rel="noreferrer">Открыть страницу входа ChatGPT</a>}
    </div>
    {waiting && <div role="status">Подтвердите вход в открывшейся вкладке и вернитесь в Rezak.</div>}
    {state === 'connected' && <div className="row wrap">
      {account && <span className="hint">{account}</span>}
      <label>Модель подписки ChatGPT <select value={active && models.some(item => item.id === model) ? model : ''}
        disabled={!models.length} onChange={e => { if (e.target.value) onSelect(e.target.value); }}>
        <option value="" disabled>Выберите модель для ИИ-операций</option>
        {models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </div>}
    {active && <div className="row wrap">
      <span className="hint">Выбран режим подписки ChatGPT.</span>
      <button type="button" className="ghost" onClick={() => onSelect(null)}>Использовать настройки API</button>
    </div>}
    {(message || notices[state]) && <div role="status">{message || notices[state]}</div>}
    <ul className="hint">
      <li><strong>Посмотреть или отозвать разрешение.</strong> В ChatGPT откройте «Настройки → Безопасность и вход (Security and login) → Подключения для входа (Login connections) → Вход через ChatGPT (Sign in with ChatGPT) → Rezak». Там можно выбрать «Отключить» (Disconnect). <a href="https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites" target="_blank" rel="noreferrer">Инструкция OpenAI</a>.</li>
      <li><strong>Посмотреть расход подписки.</strong> В ChatGPT откройте «Настройки → Использование (Usage) → Лимиты приложений (App limits) → Rezak». Там видно, сколько лимита использовал Rezak, и можно задать недельный лимит. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Открыть настройки использования ChatGPT</a>.</li>
    </ul>
  </div>;
}
