/** WebGPU viability probing, independent of browser globals and model loading. */

export interface GpuProbeAdapter {
  features?: { has(name: string): boolean };
  requestDevice?: (descriptor?: unknown) => Promise<GpuProbeDevice | null>;
}

export interface GpuProbeDevice {
  destroy?: () => void;
}

export interface GpuProbeApi {
  requestAdapter: () => Promise<GpuProbeAdapter | null>;
}

export interface GpuProbeOptions {
  gpu: GpuProbeApi | null | undefined;
  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  onProgress?: (message: string, attempt: number, attempts: number) => void;
}

export interface GpuProbeResult {
  ok: boolean;
  adapter: GpuProbeAdapter | null;
  /** A viable device. The caller owns it and should destroy it when done. */
  device: GpuProbeDevice | null;
  f16: boolean;
  attempts: number;
  reason?: string;
}

const asMessage = (e: unknown) => e instanceof Error ? e.message : String(e || 'неизвестная ошибка');

/**
 * Resolve an asynchronous WebGPU operation within a bound, while consuming a
 * late rejection and destroying a late device. This is deliberately not an
 * AbortController: WebGPU requestAdapter/requestDevice do not reliably honour
 * abort signals.
 */
function bounded<T>(operation: Promise<T>, timeoutMs: number, cleanup: (value: T) => void): Promise<T> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Promise.resolve(operation).then((value) => {
    if (!settled) return value;
    try { cleanup(value); } catch { /* best effort cleanup */ }
    return value;
  }, (error) => {
    // A rejection after the timeout is consumed here; before it, preserve the
    // error for the caller so diagnostics can explain a failed device request.
    if (!settled) throw error;
    return undefined as T;
  });
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => { settled = true; reject(new Error(`тайм-аут ${timeoutMs} мс`)); }, timeoutMs);
  });
  return Promise.race([late, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    settled = true;
  });
}

/** Try adapter + device a bounded number of times, without touching model loading. */
export async function probeWebGPU(options: GpuProbeOptions): Promise<GpuProbeResult> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 4000));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 700));
  const gpu = options.gpu;
  if (!gpu?.requestAdapter) {
    return { ok: false, adapter: null, device: null, f16: false, attempts: 0, reason: 'navigator.gpu недоступен' };
  }
  let reason = 'WebGPU недоступен';
  for (let n = 1; n <= attempts; n++) {
    options.onProgress?.(`Проверка видеокарты · попытка ${n}/${attempts}`, n, attempts);
    let adapter: GpuProbeAdapter | null = null;
    try {
      adapter = await bounded(gpu.requestAdapter(), timeoutMs, () => undefined);
      if (!adapter) reason = 'requestAdapter вернул null';
      else if (typeof adapter.requestDevice !== 'function') reason = 'адаптер не поддерживает requestDevice';
      else {
        const device = await bounded(adapter.requestDevice(), timeoutMs, (late) => late?.destroy?.());
        if (!device) reason = 'requestDevice вернул null';
        else {
          const f16 = !!adapter.features?.has?.('shader-f16');
          return { ok: true, adapter, device, f16, attempts: n };
        }
      }
    } catch (e) {
      reason = asMessage(e);
    }
    if (n < attempts && retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return { ok: false, adapter: null, device: null, f16: false, attempts, reason };
}
