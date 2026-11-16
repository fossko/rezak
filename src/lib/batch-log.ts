// Diagnostic history is separate from frequently saved Project JSON. No credentials or binary PCM.
import { idb } from './db';
type Entry = { kind: 'event' | 'stream'; at: number; scope: string; message: string; key?: string };
type Stored = { entries: Entry[] };
type LogState = {
  entries: Entry[]; loaded: boolean; loading: Promise<void> | null; dirty: boolean; rev: number;
  flushing: Promise<void> | null; timer?: number; listeners: Set<() => void>; lastEvent?: number; removed?: boolean;
  trimmedAt?: number;
};
const states = new Map<string, LogState>();
const secrets = new Set<string>();
const warnings = new Map<string, string>();
const sensitive = /authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|credential|^headers?$|^token$/i;
let secretRegex: RegExp | null = null;
const redact = (text: string) => secretRegex ? text.replace(secretRegex, '[REDACTED]') : text;
/** The live report is a liveness aid, not an archive: only the newest lines are kept. */
const MAX_LOG_LINES = 300;
/** Safety net for pathological single-line streams (keeps the newest characters). */
const MAX_LOG_CHARS = 120_000;
const NL = String.fromCharCode(10);
function scrub(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (sensitive.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redact(value);
  if (value instanceof ArrayBuffer) return `[ArrayBuffer: ${value.byteLength} bytes]`;
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name}: ${value.byteLength} bytes]`;
  if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: redact(value.stack || '') };
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const result = Array.isArray(value) ? value.map(v => scrub(v, '', seen))
      : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k, seen)]));
    seen.delete(value);
    return result;
  }
  return typeof value === 'bigint' ? String(value) : value;
}
function state(id: string): LogState {
  let s = states.get(id);
  if (!s) { s = { entries: [], loaded: false, loading: null, dirty: false, rev: 0, flushing: null, listeners: new Set() }; states.set(id, s); }
  return s;
}
function notify(s: LogState) { s.rev++; for (const listener of s.listeners) listener(); }
function ensure(id: string) { const s = state(id); if (!s.loaded && !s.loading) void batchLog.load(id); return s; }
function schedule(id: string, s: LogState) {
  if (s.removed || s.timer != null) return;
  s.timer = window.setTimeout(() => { s.timer = undefined; if (!s.removed) void batchLog.flush(id); }, 2000);
}
/** Last `take` lines of `text` without splitting the whole (possibly huge) string. */
function lastLines(text: string, take: number): { text: string; cut: boolean } {
  if (take <= 0) return { text: '', cut: text.length > 0 };
  let pos = text.length;
  for (let n = 0; n < take; n++) {
    const at = text.lastIndexOf(NL, pos - 1);
    if (at < 0) return { text, cut: false };
    pos = at;
  }
  return { text: text.slice(pos + 1), cut: true };
}
function countNewlines(text: string) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
/** Keep only the newest `maxLines` lines of the whole journal, walking back from the end. */
function trimEntries(entries: Entry[], maxLines = MAX_LOG_LINES, maxChars = MAX_LOG_CHARS): Entry[] {
  const kept: Entry[] = [];
  let lines = 0, chars = 0;
  for (let i = entries.length - 1; i >= 0 && lines < maxLines && chars < maxChars; i--) {
    const e = entries[i];
    const header = `[${new Date(e.at).toLocaleString()}] ${e.scope}${NL}`;
    const roomLines = maxLines - lines, roomChars = maxChars - chars;
    if (roomLines <= 1) {
      // Only the one-line header fits; keeping message text would exceed the line budget.
      kept.unshift({ ...e, message: '' });
      break;
    }
    const message = lastLines(e.message, roomLines - 1);
    // Store the message WITHOUT the header: format()/text() prepend it again. Keeping it here made
    // repeated trim passes duplicate the header and exceed the line limit.
    let text = message.text;
    if (header.length + text.length > roomChars) text = text.slice(-Math.max(0, roomChars - header.length));
    kept.unshift(text === e.message ? e : { ...e, message: text });
    lines += message.cut ? roomLines : 2 + countNewlines(e.message); // header line + message lines
    chars += header.length + text.length + 2;
  }
  return kept;
}
function changed(id: string, s: LogState) {
  s.dirty = true; s.lastEvent = Date.now();
  // Streaming deltas arrive many times per second; trimming on every one would rescan large answers.
  if (!s.trimmedAt || s.lastEvent - s.trimmedAt >= 500) { s.trimmedAt = s.lastEvent; s.entries = trimEntries(s.entries); }
  notify(s); schedule(id, s);
}
const format = (e: Entry) => `[${new Date(e.at).toLocaleString()}] ${e.scope}\n${e.message}`;

export const batchLog = {
  event(id: string, scope: string, message: string, detail?: unknown) {
    const s = ensure(id);
    let suffix = '';
    if (detail !== undefined) {
      try { suffix = '\n' + JSON.stringify(scrub(detail), null, 2); }
      catch { suffix = '\n[Не удалось сериализовать подробности события]'; }
    }
    s.entries.push({ kind: 'event', at: Date.now(), scope: redact(scope), message: redact(message) + suffix });
    changed(id, s);
  },
  stream(id: string, scope: string, key: string, text: string, mode: 'append' | 'replace' = 'append') {
    const s = ensure(id);
    let previous: Entry | undefined;
    for (let i = s.entries.length - 1; i >= 0; i--) if (s.entries[i].kind === 'stream' && s.entries[i].key === key) { previous = s.entries[i]; break; }
    // Keep the complete assembled stream in memory so split secret tokens can be redacted together.
    // Only redacted strings are exposed or persisted.
    if (previous) { previous.message = mode === 'replace' ? text : previous.message + text; previous.at = Date.now(); }
    else s.entries.push({ kind: 'stream', at: Date.now(), scope: redact(scope), key, message: text });
    changed(id, s);
  },
  async load(id: string): Promise<void> {
    const s = state(id);
    if (s.loaded) return;
    if (s.loading) return s.loading;
    s.loading = (async () => {
      try {
        const saved = await idb.get<Stored>('kv', `batch-log:${id}`);
        if (s.removed) return;
        if (Array.isArray(saved?.entries)) s.entries = trimEntries([...saved.entries, ...s.entries]);
        s.lastEvent = s.entries.reduce((latest, e) => Math.max(latest, e.at || 0), s.lastEvent || 0) || undefined;
      } catch (e: any) { warnings.set(id, 'Не удалось прочитать журнал: ' + e.message); }
      finally { s.loaded = true; s.loading = null; if (!s.removed) notify(s); }
    })();
    return s.loading;
  },
  async flush(id: string): Promise<void> {
    const s = state(id);
    if (s.flushing) return s.flushing;
    s.flushing = (async () => {
      await this.load(id);
      // Bound each flush: an endlessly streaming response must not monopolize IndexedDB/main thread.
      for (let pass = 0; pass < 2 && s.dirty && !s.removed; pass++) {
        const revision = s.rev;
        const snapshot: Stored = { entries: trimEntries(s.entries).map(e => ({ ...e, scope: redact(e.scope), message: redact(e.message), key: e.key ? redact(e.key) : undefined })) };
        try {
          await idb.put('kv', `batch-log:${id}`, snapshot);
          s.dirty = s.rev !== revision;
          if (warnings.delete(id)) notify(s);
        } catch (e: any) {
          s.dirty = true; warnings.set(id, 'Не удалось сохранить журнал: ' + e.message + '. Текущий журнал можно скачать до закрытия вкладки.'); notify(s); break;
        }
      }
    })().finally(() => { s.flushing = null; if (s.dirty && !s.removed) schedule(id, s); });
    return s.flushing;
  },
  async remove(id: string) {
    const s = states.get(id);
    if (s) { s.removed = true; if (s.timer != null) clearTimeout(s.timer); await s.loading; await s.flushing; }
    await idb.del('kv', `batch-log:${id}`); states.delete(id); warnings.delete(id);
  },
  subscribe(id: string, callback: () => void) {
    const s = state(id); s.listeners.add(callback); void this.load(id);
    return () => { s.listeners.delete(callback); };
  },
  snapshot(id: string) { return ensure(id).rev; },
  text(id: string) { return trimEntries(ensure(id).entries).map(e => redact(format(e))).join('\n\n'); },
  tail(id: string, maxLines = MAX_LOG_LINES) {
    return trimEntries(ensure(id).entries, maxLines).map(e => redact(format(e))).join('\n\n');
  },
  lastEvent(id: string) { return ensure(id).lastEvent; },
  warning(id: string) { return warnings.get(id); },
  protect(secret: string) {
    if (!secret || secrets.has(secret)) return;
    secrets.add(secret);
    secretRegex = new RegExp([...secrets].sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  },
};
export type BatchLogApi = typeof batchLog;
if (typeof window !== 'undefined') {
  (window as Window & { __carverBatchLog?: BatchLogApi }).__carverBatchLog = batchLog;
  for (const event of ['pagehide', 'visibilitychange']) window.addEventListener(event, () => {
    for (const [id, s] of states) if (s.dirty) void batchLog.flush(id);
  });
}
