import { useEffect, useMemo, useRef, useState } from 'react';
import { listModels, llmConfig, type LlmSettingsData } from '../llm/client';

// model lists per endpoint+key, shared by every picker on the page
const cache = new Map<string, string[]>();
const keyOf = (s: LlmSettingsData) => s.url.trim().replace(/\/+$/, '') + '|' + s.key.trim();
const validUrl = (u: string) => /^https?:\/\/\S+$/.test(u.trim());

/** Searchable model dropdown. Fetches GET {url}/models when opened, and (debounced) whenever the
 *  endpoint or API key changes. Any name can still be typed in when a provider has no /models. */
export function ModelPicker({ settings, onChange, compact }: { settings: LlmSettingsData; onChange: (model: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [models, setModels] = useState<string[] | null>(cache.get(keyOf(settings)) || null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);
  const k = keyOf(settings);

  const fetchList = async (force = false) => {
    if (!validUrl(settings.url)) { setErr('Укажите адрес API'); return; }
    if (!force && cache.has(k)) { setModels(cache.get(k)!); setErr(''); return; }
    const id = ++reqId.current;
    setLoading(true); setErr('');
    try {
      const list = await listModels(llmConfig({ ...settings, model: settings.model || 'x' }));
      if (id !== reqId.current) return;
      cache.set(k, list); setModels(list);
      if (!list.length) setErr('Сервис не вернул список моделей — введите название вручную');
    } catch (e: any) {
      if (id !== reqId.current) return;
      setModels(null); setErr(String(e.message || e).split('\n')[0]);
    } finally { if (id === reqId.current) setLoading(false); }
  };

  // endpoint / key pasted or edited: refresh the list in the background
  useEffect(() => {
    setModels(cache.get(k) || null);
    if (!validUrl(settings.url)) return;
    const t = setTimeout(() => fetchList(), 700);
    return () => clearTimeout(t);
  }, [k]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    fetchList();
    setQ(''); setHi(0);
    setTimeout(() => search.current?.focus(), 0);
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const l = models || [];
    return (t ? l.filter((m) => m.toLowerCase().includes(t)) : l).slice(0, 400);
  }, [models, q]);
  const custom = q.trim() && !(models || []).includes(q.trim()) ? q.trim() : '';
  const items = custom ? [...filtered, custom] : filtered;
  const pick = (m: string) => { onChange(m); setOpen(false); };

  return (
    <div className={'mpick' + (compact ? ' compact' : '')} ref={box}>
      <button type="button" className="mpick-btn" onClick={() => setOpen(!open)} title="Модель (список загружается у сервиса)">
        <span className={'grow mpick-cur' + (settings.model ? '' : ' dim')}>{settings.model || 'Выберите модель'}</span>
        {loading ? <span className="spin" /> : <span className="dim">▾</span>}
      </button>
      {open && (
        <div className="mpick-pop">
          <div className="row" style={{ gap: 6 }}>
            <input ref={search} className="grow" value={q} placeholder="Поиск или своё название…" spellCheck={false}
              onChange={(e) => { setQ(e.target.value); setHi(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(items.length - 1, h + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
                else if (e.key === 'Enter') { e.preventDefault(); if (items[hi]) pick(items[hi]); }
                else if (e.key === 'Escape') setOpen(false);
              }} />
            <button type="button" className="small ghost" title="Обновить список" onClick={() => fetchList(true)}>↻</button>
          </div>
          <div className="mpick-list">
            {loading && !models && <div className="mpick-note"><span className="spin" /> Загрузка списка моделей…</div>}
            {err && <div className="mpick-note err">{err}</div>}
            {filtered.map((m, i) => (
              <div key={m} className={'mpick-item' + (i === hi ? ' hi' : '') + (m === settings.model ? ' cur' : '')}
                onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(m); }}>{m}</div>
            ))}
            {custom && <div className={'mpick-item custom' + (hi === filtered.length ? ' hi' : '')}
              onMouseEnter={() => setHi(filtered.length)} onMouseDown={(e) => { e.preventDefault(); pick(custom); }}>Использовать «{custom}»</div>}
            {models && !filtered.length && !custom && <div className="mpick-note dim">Ничего не найдено</div>}
          </div>
          {models && <div className="mpick-note dim">{models.length} моделей у сервиса</div>}
        </div>
      )}
    </div>
  );
}
