// OpenAI-compatible chat client (POST {base}/chat/completions) — ported from whisper-web:
// streaming, retries with backoff (honours Retry-After), automatic adaptation when a model
// rejects temperature / max_tokens / streaming, <think> blocks of reasoning models hidden.
import { sleep } from '../lib/util';

export const LLM_PROVIDERS: Record<string, { label: string; url: string; noKey?: boolean }> = {
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  groq: { label: 'Groq', url: 'https://api.groq.com/openai/v1' },
  mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1' },
  ollama: { label: 'Ollama (на этом компьютере)', url: 'http://localhost:11434/v1', noKey: true },
  lmstudio: { label: 'LM Studio (на этом компьютере)', url: 'http://localhost:1234/v1', noKey: true },
  llamacpp: { label: 'llama.cpp / vLLM (локально)', url: 'http://localhost:8080/v1', noKey: true },
  custom: { label: 'Другой — свой адрес', url: '' },
};

export interface LlmSettingsData {
  provider: string; url: string; key: string; model: string;
  temperature: string; maxTokens: string; chunkChars: string; parallel: string;
  extraBody: string; extraHeaders: string;
  /** reasoning ("thinking") of the model: as the model decides / less / off */
  thinking: Thinking;
  /** Optional model override per pipeline step id (e.g. spelling: deepseek-chat, structured: deepseek-reasoner). */
  stepModels: Record<string, string>;
  chatGptPlan?: boolean;
  chatGptModel?: string;
}
export type Thinking = 'auto' | 'low' | 'off';

/** Opt-in diagnostic event contract.  Listeners are best-effort and must not affect requests. */
export type LlmEvent = {
  requestId: string; type: string; message: string; detail?: unknown; text?: string;
  stream?: 'answer' | 'reasoning'; mode?: 'append' | 'replace';
};
export interface LlmConfig {
  url: string; key: string; model: string; temperature: number | null; maxTokens: number | null;
  chunkChars: number; parallel: number; extraBody: Record<string, unknown>; extraHeaders: Record<string, string>;
  thinking: Thinking;
  /** Optional model overrides per pipeline step; missing/empty entries use `model`. */
  stepModels: Record<string, string>;
  /** Bounded total wait for one queued LLM request, including streaming/retries. */
  requestTimeoutMs?: number;
  /** Optional, best-effort diagnostics; exceptions are swallowed. */
  onEvent?: (event: LlmEvent) => void;
  chatGptPlan?: boolean;
}

/** Live progress of one request. `wait` = sent, nothing received yet (model loading / prompt processing /
 *  queue); `think` = streaming reasoning tokens; `write` = streaming the answer; `retry` = waiting after an error. */
export interface Phase { stage: 'wait' | 'think' | 'write' | 'retry'; thinkChars: number; textChars: number; since: number; retryIn?: number; reason?: string }

/** Provider-specific request fields that reduce or switch off reasoning. */
export function thinkingParams(url: string, t: Thinking): Record<string, unknown> {
  if (t === 'auto') return {};
  const deepseek = /deepseek\.com/.test(url), ollama = /:11434\b|ollama/i.test(url), openrouter = /openrouter\.ai/.test(url), openai = /api\.openai\.com/.test(url);
  if (t === 'low') return openrouter ? { reasoning: { effort: 'low' } } : { reasoning_effort: 'low' };
  if (deepseek) return { thinking: { type: 'disabled' } };                 // api-docs.deepseek.com/guides/thinking_mode
  if (openrouter) return { reasoning: { effort: 'none' } };
  if (openai) return { reasoning_effort: 'minimal' };
  if (ollama) return { reasoning_effort: 'none' };                         // Ollama /v1 ignores `think: false`
  return { reasoning_effort: 'none' };
}

const KEY = 'carver:llm';
export function loadLlmSettings(): LlmSettingsData {
  const d: LlmSettingsData = { provider: 'openai', url: LLM_PROVIDERS.openai.url, key: '', model: '', temperature: '0.2', maxTokens: '', chunkChars: '20000', parallel: '2', extraBody: '', extraHeaders: '', thinking: 'auto', stepModels: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out: LlmSettingsData = { ...d, ...saved };
    if (!out.stepModels || typeof out.stepModels !== 'object' || Array.isArray(out.stepModels)) out.stepModels = {};
    else for (const [id, model] of Object.entries(out.stepModels)) if (typeof model !== 'string') delete out.stepModels[id];
    // One-time migration for existing DeepSeek settings: 12k fragments caused an extra chunk (and a seam)
    // on 13–17k structured texts. New installations already default to 20k; an explicit later edit sticks.
    if ((out.provider === 'deepseek' || /deepseek\.com/.test(out.url)) && out.chunkChars === '12000' && !localStorage.getItem('carver:llm:chunk20000')) {
      out.chunkChars = '20000';
      localStorage.setItem(KEY, JSON.stringify(out));
      localStorage.setItem('carver:llm:chunk20000', '1');
    }
    return out;
  } catch { return d; }
}
export function saveLlmSettings(s: LlmSettingsData) { localStorage.setItem(KEY, JSON.stringify(s)); }

export function llmConfig(s = loadLlmSettings()): LlmConfig {
  if (s.chatGptPlan) {
    if (!s.chatGptModel) throw new Error('Выберите модель подписки ChatGPT в настройках ИИ.');
    return {
      url: location.origin, key: '', model: s.chatGptModel, chatGptPlan: true,
      temperature: null, maxTokens: null, stepModels: {}, extraBody: {}, extraHeaders: {}, thinking: 'auto',
      chunkChars: Math.max(1000, +s.chunkChars || 20000), parallel: Math.max(1, Math.min(8, +s.parallel || 1)),
    };
  }
  const parseObj = (str: string, what: string) => {
    if (!str.trim()) return {};
    try { const v = JSON.parse(str); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* */ }
    throw new Error(`Поле «${what}» должно содержать JSON-объект, например {"ключ": "значение"}.`);
  };
  const url = s.url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error('Укажите адрес API в настройках ИИ, например https://api.openai.com/v1');
  if (!s.model.trim()) throw new Error('Укажите модель в настройках ИИ.');
  return {
    url, key: s.key.trim(), model: s.model.trim(),
    temperature: s.temperature === '' ? null : +s.temperature,
    maxTokens: +s.maxTokens || null,
    chunkChars: Math.max(1000, +s.chunkChars || 20000),
    parallel: Math.max(1, Math.min(8, +s.parallel || 1)),
    extraBody: parseObj(s.extraBody, 'Доп. параметры запроса'),
    extraHeaders: parseObj(s.extraHeaders, 'Доп. HTTP-заголовки'),
    thinking: s.thinking || 'auto',
    stepModels: Object.fromEntries(Object.entries(s.stepModels || {})
      .map(([id, model]) => [id, typeof model === 'string' ? model.trim() : ''])
      .filter(([, model]) => !!model)),
  };
}
export const llmConfigured = () => { try { llmConfig(); return true; } catch { return false; } };

export async function listChatGptModels(): Promise<{ id: string; name: string }[]> {
  const response = await fetch('/api/chatgpt-plan/models');
  if (response.status === 401) throw new Error('Войдите в ChatGPT заново в настройках ИИ.');
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Не удалось загрузить модели подписки ChatGPT.');
  }
  return (await response.json()).models;
}

const isAbort = (e: any) => e && (e.name === 'AbortError' || e.name === 'TimeoutError');
const requestId = () => { try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; } };
const safeUrl = (url: string) => { try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); } catch { return '[invalid url]'; } };
function headers(cfg: LlmConfig) {
  const h: Record<string, string> = { ...cfg.extraHeaders, 'Content-Type': 'application/json' };
  if (cfg.key) h.Authorization = 'Bearer ' + cfg.key;
  return h;
}
function networkHint(cfg: LlmConfig) {
  const local = /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(cfg.url);
  let s = `Не удалось связаться с ${safeUrl(cfg.url)}. Проверьте адрес, что сервер запущен и есть подключение к сети. Возможно, сервер не принимает запросы из браузера (CORS).`;
  if (local) s += ' Для Ollama запустите его с переменной окружения OLLAMA_ORIGINS="*"; для LM Studio включите «Enable CORS».';
  if (local && location.protocol === 'https:') s += ' Страница открыта по https, а локальный сервер — по http: Chrome может спросить разрешение на доступ к локальной сети.';
  return s;
}
async function lfetch(cfg: LlmConfig, path: string, init: RequestInit) {
  try { return await fetch(cfg.url + path, init); }
  catch (e: any) { if (isAbort(e)) throw e; const err: any = new Error(networkHint(cfg)); err.network = true; throw err; }
}
async function httpError(resp: Response) {
  let detail = '';
  try {
    const t = await resp.text();
    try { const j = JSON.parse(t); detail = (j.error && (j.error.message || j.error)) || j.message || j.detail || t; if (typeof detail !== 'string') detail = JSON.stringify(detail); }
    catch { detail = t; }
  } catch { /* */ }
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 400);
  const hints: Record<number, string> = {
    400: 'Сервер отклонил запрос.', 401: 'API-ключ не принят — проверьте ключ.', 402: 'Недостаточно средств на счёте сервиса.',
    403: 'Доступ запрещён — проверьте ключ и права доступа.', 404: 'Не найдено — проверьте адрес API (обычно оканчивается на /v1) и название модели.',
    413: 'Слишком большой запрос — уменьшите размер фрагмента.', 429: 'Превышен лимит запросов или исчерпана квота.',
  };
  const e: any = new Error(`HTTP ${resp.status}. ${hints[resp.status] || 'Ошибка сервера.'}${detail ? '\nОтвет сервера: ' + detail : ''}`);
  e.status = resp.status; e.detail = detail;
  return e;
}
export function stripThink(s: string, streaming = false) {
  s = s.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  const open = s.indexOf('<think>');
  if (open >= 0) s = s.slice(0, open);
  return streaming ? s : s.trim();
}

export interface Msg { role: 'system' | 'user' | 'assistant'; content: string }
const compatMap: Record<string, { noTemp?: boolean; maxCompletion?: boolean; noStream?: boolean; noJson?: boolean; noThinkParams?: boolean }> = {};

export async function chatComplete(cfg: LlmConfig, messages: Msg[], o: { signal?: AbortSignal; onText?: (t: string) => void; onPhase?: (p: Phase) => void; json?: boolean } = {}): Promise<string> {
  const rid = requestId();
  const emit = (e: Omit<LlmEvent, 'requestId'>) => { try { cfg.onEvent?.({ requestId: rid, ...e }); } catch { /* diagnostics are non-functional */ } };
  emit({ type: 'request.start', message: 'LLM request started', detail: { model: cfg.model, endpoint: safeUrl(cfg.url), messageCount: messages.length, messages } });
  if (cfg.requestTimeoutMs) {
    const timeout = AbortSignal.timeout(cfg.requestTimeoutMs);
    o = { ...o, signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout };
  }
  if (cfg.chatGptPlan) {
    const since = performance.now();
    o.onPhase?.({ stage: 'wait', since, thinkChars: 0, textChars: 0 });
    const response = await fetch('/api/chatgpt-plan/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: o.signal,
      body: JSON.stringify({ model: cfg.model, messages, json: !!o.json }),
    });
    if (!response.ok) {
      const hints: Record<number, string> = {
        401: 'Войдите в ChatGPT заново в настройках ИИ.',
        403: 'Использование подписки ChatGPT недоступно для этого запроса.',
        429: 'Превышен лимит подписки ChatGPT.',
      };
      throw new Error(hints[response.status] || `Запрос по подписке ChatGPT завершился с ошибкой (HTTP ${response.status}).`);
    }
    const { text } = await response.json() as { text: string };
    o.onText?.(text);
    o.onPhase?.({ stage: 'write', since, thinkChars: 0, textChars: text.length });
    return text;
  }
  const compat = (compatMap[cfg.url + '|' + cfg.model] ||= {});
  const ph: Phase = { stage: 'wait', thinkChars: 0, textChars: 0, since: performance.now() };
  const phase = (x: Partial<Phase>) => { Object.assign(ph, x); o.onPhase?.({ ...ph }); };
  phase({});
  let adapts = 0;   // parameter adaptations so far (bounded: user extra params are re-added every time)
  for (let attempt = 0; ; attempt++) {
    const tp = compat.noThinkParams ? {} : thinkingParams(cfg.url, cfg.thinking);
    const body: any = { model: cfg.model, messages, stream: !compat.noStream, ...tp, ...cfg.extraBody };
    if (cfg.temperature != null && !compat.noTemp) body.temperature = cfg.temperature;
    if (cfg.maxTokens) body[compat.maxCompletion ? 'max_completion_tokens' : 'max_tokens'] = cfg.maxTokens;
    if (o.json && !compat.noJson) body.response_format = { type: 'json_object' };
    let resp: Response;
    emit({ type: 'http.attempt', message: `HTTP attempt ${attempt + 1}`, detail: { attempt: attempt + 1, stream: !compat.noStream, body } });
    try { resp = await lfetch(cfg, '/chat/completions', { method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal: o.signal }); }
    catch (e: any) {
      emit({ type: isAbort(e) ? 'request.abort' : 'http.error', message: e?.message || String(e), detail: { attempt: attempt + 1, network: !!e?.network } });
      if (e.network && attempt < 2) { const w = 1500 * (attempt + 1); emit({ type: 'retry', message: 'Retrying network error', detail: { attempt: attempt + 1, waitMs: w } }); phase({ stage: 'retry', retryIn: w / 1000, reason: 'нет связи' }); await sleep(w); phase({ stage: 'wait', since: performance.now() }); continue; }
      throw e;
    }
    emit({ type: 'http.status', message: `HTTP ${resp.status}`, detail: { attempt: attempt + 1, status: resp.status, contentType: resp.headers.get('content-type') || '' } });
    if (!resp.ok) {
      const err = await httpError(resp);
      emit({ type: 'http.error', message: err.message, detail: { status: resp.status, attempt: attempt + 1 } });
      const d = (err.detail || '').toLowerCase();
      if ((resp.status === 400 || resp.status === 422) && adapts++ < 6) {
        // Adapt to what the server rejects. Decide by what THIS request sent, not by the shared flags:
        // with parallel requests, another request may already have set the flag while this one was
        // in flight with the old body — it must still retry instead of failing.
        if ('temperature' in body && d.includes('temperature')) { compat.noTemp = true; emit({ type: 'adaptation', message: 'Disabled unsupported temperature', detail: { field: 'temperature' } }); continue; }
        if (body.max_tokens && d.includes('max_tokens')) { compat.maxCompletion = true; emit({ type: 'adaptation', message: 'Switched token limit field', detail: { field: 'max_tokens' } }); continue; }
        if (body.stream && d.includes('stream')) { compat.noStream = true; emit({ type: 'adaptation', message: 'Disabled unsupported streaming', detail: { field: 'stream' } }); continue; }
        if (body.response_format && (d.includes('response_format') || d.includes('json'))) { compat.noJson = true; emit({ type: 'adaptation', message: 'Disabled unsupported JSON response format', detail: { field: 'response_format' } }); continue; }
        if (Object.keys(tp).length && /reasoning|thinking|think/.test(d)) { compat.noThinkParams = true; emit({ type: 'adaptation', message: 'Disabled unsupported reasoning parameters' }); continue; }
      }
      if ([408, 409, 425, 429, 500, 502, 503, 504, 529].includes(resp.status) && attempt < 4) {
        const ra = +(resp.headers.get('retry-after') || 0);
        const w = ra > 0 ? Math.min(ra, 60) * 1000 : 2000 * 2 ** attempt;
        emit({ type: 'retry', message: `Retrying HTTP ${resp.status}`, detail: { status: resp.status, attempt: attempt + 1, waitMs: w } });
        phase({ stage: 'retry', retryIn: w / 1000, reason: `HTTP ${resp.status}` });
        await sleep(w);
        phase({ stage: 'wait', since: performance.now() });
        continue;
      }
      throw err;
    }
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('event-stream')) {
      const j = await resp.json();
      if (j.error) { const e = new Error('Ошибка сервиса: ' + (j.error.message || JSON.stringify(j.error))); emit({ type: 'request.error', message: e.message }); throw e; }
      const message = j.choices?.[0]?.message || {};
      const reasoning = message.reasoning_content || message.reasoning || '';
      if (reasoning) emit({ type: 'stream.delta', message: 'Provider reasoning', text: reasoning, stream: 'reasoning', mode: 'append' });
      const raw = message.content || '';
      const text = stripThink(raw);
      emit({ type: 'response.body', message: 'Final response body', text: raw, stream: 'answer', mode: 'replace' });
      emit({ type: 'response.complete', message: 'Response complete', detail: { usage: j.usage, finishReason: j.choices?.[0]?.finish_reason } });
      phase({ stage: 'write', textChars: text.length });
      o.onText?.(text);
      return text;
    }
    const reader = resp.body!.getReader(), dec = new TextDecoder();
    let buf = '', text = '', usage: unknown, finishReason: unknown;
    const consume = (line: string) => {
      line = line.trim();
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j: any; try { j = JSON.parse(data); } catch { return; }
      if (j.error) { const e = new Error('Ошибка сервиса: ' + (j.error.message || JSON.stringify(j.error))); emit({ type: 'request.error', message: e.message }); throw e; }
      usage = j.usage || usage; finishReason = j.choices?.[0]?.finish_reason ?? finishReason;
      const delta = j.choices?.[0]?.delta || {};
      // Provider-supplied reasoning only; never synthesize private reasoning.
      const r = delta.reasoning_content || delta.reasoning || '';
      if (r) { emit({ type: 'stream.delta', message: 'Reasoning delta', text: r, stream: 'reasoning', mode: 'append' }); phase({ stage: 'think', thinkChars: ph.thinkChars + r.length }); }
      if (delta.content) {
        emit({ type: 'stream.delta', message: 'Answer delta', text: delta.content, stream: 'answer', mode: 'append' });
        text += delta.content;
        const visible = stripThink(text, true);
        // …or inline as <think>…</think> at the start of the content
        if (visible.length) phase({ stage: 'write', textChars: visible.length });
        else phase({ stage: 'think', thinkChars: text.length });
        o.onText?.(visible);
      }
    };
    try { for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { consume(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    } catch (e: any) {
      emit({ type: isAbort(e) ? 'request.abort' : 'request.error', message: e?.message || String(e) });
      throw e;
    }
    buf += dec.decode();
    if (buf.trim()) consume(buf); // SSE permits a final event without a trailing newline.
    const final = stripThink(text);
    emit({ type: 'response.body', message: 'Final response body', text, stream: 'answer', mode: 'replace' });
    emit({ type: 'response.complete', message: 'Response complete', detail: { usage, finishReason } });
    return final;
  }
}

export async function listModels(cfg: Pick<LlmConfig, 'url' | 'key' | 'extraHeaders'>): Promise<string[]> {
  const resp = await lfetch(cfg as LlmConfig, '/models', { headers: headers(cfg as LlmConfig) });
  if (!resp.ok) throw await httpError(resp);
  const j = await resp.json();
  return (j.data || j.models || []).map((m: any) => m.id || m.name).filter(Boolean).sort();
}

/** Split at line, then sentence boundaries. */
export function splitForLLM(text: string, maxChars: number): string[] {
  const units: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= maxChars) { units.push(line); continue; }
    const sentences = line.match(/[^.!?…]+(?:[.!?…]+["»”)\]]*\s*|$)/g) || [line];
    let cur = '';
    for (let s of sentences) {
      while (s.length > maxChars) { if (cur) { units.push(cur); cur = ''; } units.push(s.slice(0, maxChars)); s = s.slice(maxChars); }
      if (cur && (cur + s).length > maxChars) { units.push(cur); cur = ''; }
      cur += s;
    }
    if (cur) units.push(cur);
  }
  const chunks: string[] = []; let cur: string[] = [], len = 0;
  for (const u of units) {
    if (cur.length && len + u.length + 1 > maxChars) { chunks.push(cur.join('\n').trim()); cur = []; len = 0; }
    cur.push(u); len += u.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n').trim());
  return chunks.filter(Boolean);
}

/** Run `fn` over items with limited concurrency. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Parse the first JSON object in a model answer (tolerates code fences and prose around it). */
export function parseJsonLoose(s: string): any {
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try { return JSON.parse(s); } catch { /* */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* */ } }
  const a2 = s.indexOf('['), b2 = s.lastIndexOf(']');
  if (a2 >= 0 && b2 > a2) { try { return { cuts: JSON.parse(s.slice(a2, b2 + 1)) }; } catch { /* */ } }
  throw new Error('модель вернула ответ не в формате JSON');
}
