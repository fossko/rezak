// Promise-based RPC over a Worker. Optional diagnostics capture the owner at call time.
export type RpcTrace = (event: { type: string; message: string; detail?: unknown }) => void;
let trace: RpcTrace | null = null;
export function setRpcTrace(listener: RpcTrace | null) { trace = listener; }
const report = (listener: RpcTrace | null, type: string, message: string, detail?: unknown) => {
  try { listener?.({ type, message, detail }); } catch { /* diagnostics must never break worker work */ }
};
export class RPC {
  worker: Worker;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; trace: RpcTrace | null; type: string; at: number }>();
  private n = 0;
  private eventTrace: RpcTrace | null = null;
  onEvent: ((m: any) => void) | null;
  constructor(worker: Worker, onEvent: ((m: any) => void) | null = null) {
    this.worker = worker; this.onEvent = onEvent;
    worker.onmessage = ({ data: m }) => {
      if (m && m.id != null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!; this.pending.delete(m.id);
        report(p.trace, m.ok ? 'result' : 'error', `${p.type} #${m.id}: ${m.ok ? 'готово' : 'ошибка'} (${Math.round(performance.now() - p.at)} мс)`, m.ok ? m.result : m.error);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      } else {
        report(this.eventTrace, 'event', m?.event || 'Событие worker', m);
        this.onEvent?.(m);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      const err = new Error('Сбой фонового обработчика: ' + (e.message || 'не удалось загрузить библиотеки (при первом запуске нужен интернет)'));
      for (const p of this.pending.values()) { report(p.trace, 'error', err.message); p.reject(err); }
      this.pending.clear();
    };
  }
  call<T = any>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.n;
    if (this.dead) return Promise.reject(new DOMException('cancelled', 'AbortError'));
    const owner = trace;
    this.eventTrace = owner;
    report(owner, 'call', `${type} #${id}: отправлено в worker`, payload);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, trace: owner, type, at: performance.now() });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }
  private dead = false;
  terminate() {
    this.dead = true;
    this.worker.terminate();
    for (const p of this.pending.values()) { report(p.trace, 'cancel', `${p.type}: worker остановлен`); p.reject(new DOMException('cancelled', 'AbortError')); }
    this.pending.clear(); this.eventTrace = null;
  }
}

export const newSpeechWorker = () => new Worker(new URL('../transcribe/speech.worker.ts', import.meta.url), { type: 'module' });
