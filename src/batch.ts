// Sequential, durable queue on an OPEN page. UI is a table; the existing Store owns only one job.
import { useSyncExternalStore } from 'react';
import { S, prefs } from './store';
import { idb, projects, requestPersistentStorage } from './lib/db';
import { openMedia, sameFile } from './lib/media';
import { uid, baseName } from './lib/util';
import { DEFAULT_CUT, DEFAULT_SILENCE, type Project } from './lib/types';
import type { BatchSettings, StageId } from './lib/batch-types';
import { DISABLED_NOTE, makeBatchState, recoverBatch, sequentialJobs, syncStageFlags, validateBatchSettings } from './lib/batch-state';
import { loadSteps, processText } from './llm/pipeline';
import { autoCarve } from './llm/carve';
import { llmConfig, llmConfigured, type LlmConfig } from './llm/client';
import { makePlainText, makeTimedText, outWords } from './export/subs';
import { disposeSpeechRPC } from './transcribe/run';
import { batchLog } from './lib/batch-log';
import { setRpcTrace } from './lib/rpc';
import { STAGE_LABELS } from './lib/batch-types';
import { createWorkspaceApi, workspaceTokenFromLocation } from './lib/workspace';
import { filterProjects, queueKey, LEGACY_QUEUE_KEY, type ProjectScope } from './lib/scope';
import { planRelink, type MediaFile } from './lib/relink';

const QUEUE_KEY = 'batch-queue-v1';   // legacy single-queue key, migrated into a scope-specific one
const SETTINGS_KEY = 'carver:batch-settings';
type Source = { file: File; handle: FileSystemFileHandle | null };
export function defaultBatchSettings(): BatchSettings {
  const steps = loadSteps().map(s => ({ ...s, enabled: ['spelling', 'structured', 'chapters'].includes(s.id) }));
  let saved: Partial<BatchSettings> | null = null;
  try { const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); if (value && typeof value === 'object') saved = value; } catch { saved = null; }
  if (!saved) return { transcribe: true, fillers: true, carve: true, texts: true, strength: 'careful', textSteps: steps, model: prefs.model, targetLufs: -14.9 };
  return {
    transcribe: saved.transcribe !== false,
    fillers: saved.fillers !== false,
    carve: saved.carve !== false,
    texts: saved.texts !== false,
    strength: (['careful', 'normal', 'aggressive'] as const).includes(saved.strength as BatchSettings['strength'])
      ? saved.strength as BatchSettings['strength'] : 'careful',
    targetLufs: Number.isFinite(saved.targetLufs) ? Number(saved.targetLufs) : -14.9,
    model: prefs.model,
    // Preset definitions come from the current Texts settings; only the user's checkmarks are restored.
    textSteps: steps.map(step => {
      const old = Array.isArray(saved!.textSteps) ? saved!.textSteps.find(x => x && x.id === step.id) : undefined;
      return old ? { ...step, enabled: !!old.enabled } : step;
    }),
  };
}
const aborted = () => new DOMException('Пакетная обработка остановлена', 'AbortError');
class BatchQueue {
  ready = false;
  running = false;
  adding = false;
  exporting = false;
  setExporting(value: boolean) { this.exporting = value; this.bump(); }
  error: string | null = null;
  activeId: string | null = null;
  queue: string[] = [];
  completed = 0;
  total = 0;
  revision = 0;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private files = new Map<string, Source>();
  private runIds: string[] = [];
  private controller: AbortController | null = null;
  private wake: WakeLockSentinel | null = null;
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  snapshot = () => this.revision;
  private bump() { this.revision++; for (const f of this.listeners) f(); S.bump(); }
  /** Queue of this tab's scope (local or one workspace); the queue is never shared between them. */
  private scopeKey = '';
  private async persist() { if (this.scopeKey) await idb.put('kv', this.scopeKey, this.queue.slice()); }
  private async scopedProjects() {
    const scope = S.scope;
    return scope ? filterProjects(await projects.list(), scope) : [];
  }
  private async count() {
    const list = await this.scopedProjects();
    const ids = this.running ? this.runIds : this.queue;
    this.total = ids.length;
    this.completed = list.filter(p => ids.includes(p.id) && p.batch?.status === 'done').length;
  }
  init(): Promise<void> {
    const scope: ProjectScope | null = S.scope;
    if (!scope) return Promise.resolve();   // the workspace is still loading; nothing to restore yet
    const key = queueKey(scope);
    if (this.loading && this.scopeKey === key) return this.loading;
    if (this.scopeKey !== key) {
      // Different scope (another workspace or local): drop the in-memory queue and load this scope's own one.
      this.loading = null; this.ready = false; this.queue = []; this.files.clear(); this.completed = 0; this.total = 0;
      this.scopeKey = key;
    }
    this.loading = (async () => {
      try {
        let saved = await idb.get<unknown>('kv', key);
        if (saved == null) {
          // One-time migration of the old single queue: keep only the ids that belong to this scope.
          const legacy = await idb.get<unknown>('kv', QUEUE_KEY);
          saved = Array.isArray(legacy) ? legacy : [];
        }
        const list = await this.scopedProjects();
        const ids = Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : [];
        this.queue = [...new Set(ids)].filter(id => list.some(p => p.id === id));
        for (const p of list) if (p.batch) {
          // Recovery plus a repair of stage flags left inconsistent by older builds: an off switch in
          // the saved settings must never leave a stage pending.
          let changed = recoverBatch(p.batch);
          if (syncStageFlags(p.batch)) changed = true;
          if (changed) {
            batchLog.event(p.id, 'Восстановление', 'Состояние очереди восстановлено и согласовано с общими настройками. Автоматический запуск не выполняется.', p.batch.stages);
            await projects.save(p); await batchLog.flush(p.id);
          }
          if (p.batch.status !== 'done' && !this.queue.includes(p.id)) this.queue.push(p.id);
        }
        this.queue = this.queue.filter(id => list.some(p => p.id === id && p.batch));
        await this.persist(); await this.count();
      } catch (e: any) { this.error = 'Не удалось восстановить очередь: ' + e.message; }
      this.ready = true; this.bump();
    })();
    return this.loading;
  }
  async add(files: Source[], settings: BatchSettings) {
    if (!S.scope) throw new Error('Рабочее пространство ещё загружается.');
    await this.init();
    if (this.running || this.adding || this.exporting || S.task) throw new Error('Дождитесь окончания текущей операции.');
    validateBatchSettings(settings);
    const frozen = structuredClone(settings);
    this.adding = true; this.error = null; this.bump();
    await requestPersistentStorage();
    try {
      for (const item of files) {
        // Metadata only: keep File references, never decode all queued videos into memory.
        let media;
        try { media = await openMedia(item.file); }
        catch (e: any) {
          const message = `«${item.file.name}» не добавлен: ${e.message || e}`;
          this.error = this.error ? this.error + '\n' + message : message;
          S.toast(message, 'err'); this.bump(); continue;
        }
        const meta = { ...media.meta }; media.input.dispose();
        const p: Project = {
          id: uid(), workspaceId: S.workspaceId || undefined, name: baseName(item.file.name), createdAt: Date.now(), updatedAt: Date.now(), media: meta,
          words: [], wordState: [], silence: { ...DEFAULT_SILENCE }, cut: { ...DEFAULT_CUT },
          keptSilences: [], rangeCuts: [], suggestions: [], pipeline: [], version: 1,
          batch: makeBatchState(frozen),
        };
        // Audio-only sources never produce an MP4, so the "Экспорт видео" stage is not a pending task.
        if (!meta.hasVideo) p.batch!.stages.video = { status: 'skipped', note: 'Аудиопроект: экспортируется только MP3' };
        batchLog.event(p.id, 'Очередь', 'Файл добавлен. К файлу применены общие настройки обработки.', { media: meta, settings: frozen, rememberedHandle: !!item.handle });
        await projects.save(p); if (S.workspaceId) await S.publishWorkspaceProject(p); await batchLog.flush(p.id);
        if (item.handle) await idb.put('handles', p.id, item.handle);
        this.files.set(p.id, item);
        this.queue.push(p.id);
        await this.persist(); await this.count(); this.bump();
      }
    } catch (e: any) { this.error = 'Не удалось добавить файл: ' + e.message; S.toast(this.error, 'err'); }
    finally { this.adding = false; this.bump(); }
  }
  /** Files found under a picked folder, keyed by their path inside it (recursive, depth-limited). */
  private async scanFolder(root: FileSystemDirectoryHandle): Promise<Array<{ file: MediaFile; handle: FileSystemFileHandle }>> {
    const out: Array<{ file: MediaFile; handle: FileSystemFileHandle }> = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number) => {
      if (out.length >= 5000 || depth > 4) return;
      for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
        if (entry.kind === 'file') {
          const fh = entry as FileSystemFileHandle;
          const f = await fh.getFile().catch(() => null);
          if (f) out.push({ file: { name: f.name, size: f.size, lastModified: f.lastModified, path: prefix + f.name }, handle: fh });
        } else if (depth < 4) await walk(entry as FileSystemDirectoryHandle, prefix + entry.name + '/', depth + 1);
        if (out.length >= 5000) return;
      }
    };
    await walk(root, '', 0);
    return out;
  }
  /** «Папка с исходниками»: restore access for every project whose video sits in the picked folder. */
  async relinkFolder(root: FileSystemDirectoryHandle): Promise<{ matched: number; missing: string[]; ambiguous: string[]; total: number }> {
    if (this.running || this.adding || this.exporting) throw new Error('Сначала остановите очередь.');
    const list = await this.scopedProjects();
    if (!list.length) return { matched: 0, missing: [], ambiguous: [], total: 0 };
    const found = await this.scanFolder(root);
    const byPath = new Map(found.map(x => [x.file.path, x.handle]));
    const plan = planRelink(list.map(p => ({ id: p.id, name: p.media.name, size: p.media.size, lastModified: p.media.lastModified })), found.map(x => x.file));
    const nameOf = (id: string) => list.find(p => p.id === id)?.media.name || id;
    let matched = 0;
    for (const m of plan.matched) {
      const handle = byPath.get(m.path); if (!handle) continue;
      const file = await handle.getFile().catch(() => null);
      if (!file) continue;
      const project = list.find(p => p.id === m.id)!;
      if (!sameFile(file, project.media)) continue;   // never attach a different video
      this.files.set(m.id, { file, handle });
      await idb.put('handles', m.id, handle).catch(() => {});
      batchLog.event(m.id, 'Исходный файл', m.how === 'name' ? 'Доступ восстановлен из выбранной папки (совпадение имени)' : 'Доступ восстановлен из выбранной папки (совпадение размера и даты)', { name: file.name, size: file.size, lastModified: file.lastModified, path: m.path, rememberedHandle: true });
      matched++;
    }
    this.error = null; this.bump();
    return { matched, missing: plan.missing.map(nameOf), ambiguous: plan.ambiguous.map(nameOf), total: list.length };
  }
  async relink(projectId: string, file: File, handle: FileSystemFileHandle | null) {
    if (this.running || this.adding || this.exporting) throw new Error('Сначала остановите очередь.');
    const p = await projects.get(projectId);
    if (!p || !sameFile(file, p.media)) throw new Error('Этот файл не совпадает с исходником проекта.');
    batchLog.event(projectId, 'Исходный файл', 'Доступ к исходному видео восстановлен', { name: file.name, size: file.size, lastModified: file.lastModified, rememberedHandle: !!handle });
    this.files.set(projectId, { file, handle });
    if (handle) await idb.put('handles', projectId, handle);
    this.error = null; this.bump();
  }
  async forget(projectId: string) {
    if (this.running || this.adding || this.exporting) return;
    this.queue = this.queue.filter(x => x !== projectId); this.files.delete(projectId);
    await this.persist(); await this.count(); this.bump();
  }
  /** Drop queue entries whose project no longer exists locally (deleted by us or by another participant). */
  async prune(existingIds: readonly string[]) {
    if (this.running || this.adding || this.exporting) return;
    const alive = new Set(existingIds);
    const next = this.queue.filter(id => alive.has(id));
    if (next.length === this.queue.length) return;
    this.queue = next;
    await this.persist(); await this.count(); this.bump();
  }
  /** Apply the panel's shared settings to every queued file that has not finished yet.
   *  Completed stages keep their results; switched-off stages become skipped, switched-on stages pending. */
  async applySettings(settings: BatchSettings) {
    await this.init();
    if (this.running || this.adding || this.exporting) return;
    validateBatchSettings(settings);
    const frozen = structuredClone(settings);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(frozen)); } catch { /* settings still apply to this run */ }
    const list = await this.scopedProjects();
    let touched = 0;
    for (const id of this.queue) {
      const p = list.find(x => x.id === id);
      if (!p?.batch || p.batch.status === 'done') continue;
      const before = JSON.stringify([p.batch.settings, p.batch.stages, p.batch.textStages, p.batch.status]);
      p.batch.settings = structuredClone(frozen);
      syncStageFlags(p.batch);
      const unfinished = (['prepare', 'transcribe', 'fillers', 'carve', 'texts'] as StageId[])
        .some(stage => !['done', 'skipped'].includes(p.batch!.stages[stage].status));
      if (!unfinished) p.batch.status = 'done';
      if (JSON.stringify([p.batch.settings, p.batch.stages, p.batch.textStages, p.batch.status]) === before) continue;
      p.updatedAt = Date.now();
      batchLog.event(p.id, 'Настройки', 'Общие настройки применены к ещё не завершённому файлу', { settings: frozen, stages: p.batch.stages });
      await projects.save(p);
      touched++;
    }
    if (touched) { await this.count(); this.bump(); }
  }
  async retry(projectId: string) {
    if (this.running || this.adding || this.exporting) return;
    const p = await projects.get(projectId); if (!p?.batch) return;
    batchLog.event(projectId, 'Очередь', 'Запрошен повтор: завершённые этапы будут пропущены', p.batch.stages);
    p.batch.status = 'queued';
    for (const [id, s] of Object.entries(p.batch.stages)) if (id !== 'video' && ['error', 'interrupted', 'running'].includes(s.status)) {
      s.status = 'pending'; delete s.error;
    }
    await projects.save(p);
    if (!this.queue.includes(projectId)) this.queue.push(projectId);
    await this.persist(); this.bump();
  }
  stop() {
    if (!this.controller || this.controller.signal.aborted) return;
    if (this.activeId) batchLog.event(this.activeId, 'Остановка', 'Пользователь остановил очередь. Ожидаем завершения отмены текущей операции.');
    this.controller.abort();
    const kind = S.task?.kind;
    S.task?.cancel?.();
    // Notify the existing stop/chime hook; recursive batchCancel is now an idempotent no-op.
    S.cancelTask();
    if (kind === 'transcribe' || kind === 'fillers') disposeSpeechRPC();
    this.bump();
  }
  private check() { if (this.controller?.signal.aborted) throw aborted(); }
  private async holdWake() {
    if (!this.running || document.visibilityState !== 'visible' || this.wake) return;
    try {
      const lock = await navigator.wakeLock?.request('screen') ?? null;
      if (!this.running) { await lock?.release(); return; }
      this.wake = lock;
      if (this.activeId) batchLog.event(this.activeId, 'Вкладка', lock ? 'Блокировка автоматического сна получена' : 'Wake Lock недоступен');
      lock?.addEventListener('release', () => {
        if (this.wake === lock) this.wake = null;
        if (this.activeId) batchLog.event(this.activeId, 'Вкладка', 'Блокировка сна снята браузером');
      });
    }
    catch (e: any) { if (this.activeId) batchLog.event(this.activeId, 'Вкладка', 'Не удалось удержать компьютер от сна', String(e)); }
  }
  private async source(p: Project): Promise<File> {
    const current = this.files.get(p.id); if (current) return current.file;
    const handle = await idb.get<FileSystemFileHandle>('handles', p.id);
    if (handle && await (handle as any).queryPermission?.({ mode: 'read' }) === 'granted') {
      const file = await handle.getFile();
      if (sameFile(file, p.media)) return file;
    }
    throw new Error('Нужен доступ к исходнику. Выберите папку с исходниками или файл в строке проекта и повторите.');
  }
  private async save() {
    const id = S.project?.id;
    await S.saveNow(true);
    if (id) { batchLog.event(id, 'Хранилище', 'Состояние проекта сохранено в IndexedDB'); await batchLog.flush(id); }
    this.bump();
  }
  private async stage(p: Project, id: StageId, run: () => Promise<void>, enabled = true) {
    const record = p.batch!.stages[id];
    if (!enabled) {
      // The shared settings are authoritative even for a project created before they were changed.
      if (record.status !== 'done') {
        record.status = 'skipped'; record.error = undefined; record.note = DISABLED_NOTE;
        batchLog.event(p.id, STAGE_LABELS[id], 'Этап отключён в общих настройках');
        await this.save();
      }
      return;
    }
    if (record.status === 'done' || record.status === 'skipped') {
      batchLog.event(p.id, STAGE_LABELS[id], record.status === 'done' ? 'Пропуск: этап уже выполнен' : 'Пропуск: этап не выбран'); return;
    }
    this.check();
    record.status = 'running'; record.started = Date.now(); delete record.error;
    batchLog.event(p.id, STAGE_LABELS[id], 'НАЧАЛО ЭТАПА', { settings: p.batch!.settings, sourceDuration: p.media.duration });
    await this.save();
    try {
      await run(); this.check();
      record.status = 'done'; record.finished = Date.now();
      const result = id === 'prepare' ? { pcmSamples: S.pcm?.length, audio: S.audio, master: p.master, silence: p.silence }
        : id === 'transcribe' ? { model: p.transcriptModel, gpuWarning: p.batch!.gpuWarning, words: p.words }
        : id === 'fillers' ? { settings: p.fillers, words: p.words.filter(w => w.kind === 'filler') }
        : id === 'carve' ? { suggestions: p.suggestions, keptSegments: S.edl?.segments }
        : id === 'texts' ? p.pipeline : undefined;
      batchLog.event(p.id, STAGE_LABELS[id], `ЭТАП ЗАВЕРШЁН за ${((record.finished - record.started!) / 1000).toFixed(1)} с`, { outputDuration: S.composite?.duration, note: record.note, result });
      await this.save();
    } catch (e: any) {
      record.status = this.controller?.signal.aborted || e?.name === 'AbortError' ? 'interrupted' : 'error';
      record.error = e.message || String(e); record.finished = Date.now();
      batchLog.event(p.id, STAGE_LABELS[id], record.status === 'interrupted' ? 'ЭТАП ПРЕРВАН' : 'ОШИБКА ЭТАПА', { message: record.error, stack: e.stack });
      await this.save(); throw e;
    }
  }
  private async texts(p: Project, cfg: LlmConfig) {
    if (!p.batch!.settings.texts) return; // belt and braces: the group switch is authoritative
    const steps = p.batch!.settings.textSteps;
    const selected = steps.filter(s => s.enabled && s.map.trim());
    const states = p.batch!.textStages ||= {};
    const words = outWords(p.words, S.wordState, S.edl!, undefined, S.composite?.srcToOut);
    const results = new Map(p.pipeline.map(r => [r.stepId, r.text]));
    for (let n = 0; n < selected.length; n++) {
      this.check();
      const step = selected[n];
      if (states[step.id]?.status === 'done' && results.has(step.id)) continue;
      let src = '';
      if (step.source === 'plain') src = makePlainText(words);
      else if (step.source === 'timed') src = makeTimedText(words);
      else if (step.source === 'prev') {
        for (let j = steps.indexOf(step) - 1; j >= 0; j--) if (results.has(steps[j].id)) { src = results.get(steps[j].id)!; break; }
      } else src = results.get(step.source.slice(5)) || '';
      states[step.id] = { status: 'running', started: Date.now() }; await this.save();
      try {
        if (!src.trim()) throw new Error(`Нет исходного текста для этапа «${step.name}».`);
        const show = (detail = '') => S.setTask({ kind: 'pipeline', frac: n / selected.length, text: `Тексты: ${step.name}${detail ? ' · ' + detail : ''}`, cancel: () => this.stop() });
        show();
        const text = await processText(cfg, src, step, { signal: this.controller!.signal, onStatus: show,
          onPhase: phase => show(phase?.stage === 'think' ? 'модель размышляет' : phase?.stage === 'write' ? 'получение ответа' : 'ожидание модели') });
        this.check();
        if (!text.trim()) throw new Error('Модель вернула пустой текст.');
        p.pipeline = [...p.pipeline.filter(r => r.stepId !== step.id), { stepId: step.id, text, at: Date.now(), model: cfg.model }];
        results.set(step.id, text);
        states[step.id] = { status: 'done', finished: Date.now() };
        await this.save();
      } catch (e: any) {
        states[step.id] = { status: this.controller?.signal.aborted ? 'interrupted' : 'error', error: e.message || String(e) };
        await this.save(); throw e;
      }
    }
  }
  private async process(id: string, cfg: LlmConfig | null) {
    const stored = await projects.get(id);
    if (!stored?.batch || stored.batch.status === 'done' || stored.batch.status === 'error') return;
    this.activeId = id; this.bump();
    await batchLog.load(id);
    const runId = uid();
    let speechStream = runId;
    batchLog.event(id, 'Очередь', 'Открываем проект для последовательной обработки', { runId, media: stored.media, stages: stored.batch.stages });
    setRpcTrace(event => {
      if (event.type === 'call' && event.message.startsWith('transcribe ')) speechStream = `${runId}:${uid()}`;
      const detail = event.detail as any;
      if (event.type === 'event' && detail?.event === 'text') batchLog.stream(id, 'Whisper: поток распознавания', speechStream, String(detail.text || ''));
      else batchLog.event(id, 'Worker: ' + event.type, event.message, event.detail);
    });
    if (cfg) {
      batchLog.protect(cfg.key);
      for (const secret of Object.values(cfg.extraHeaders)) batchLog.protect(secret);
      cfg = { ...cfg, onEvent: event => {
        const scope = `LLM ${event.requestId} · ${event.stream === 'reasoning' ? 'размышления провайдера' : event.stream === 'answer' ? 'ответ' : event.type}`;
        if (event.text !== undefined && event.stream) batchLog.stream(id, scope, `${runId}:${event.requestId}:${event.stream}`, event.text, event.mode || 'append');
        else batchLog.event(id, scope, event.message, event.detail);
      } };
    }
    await S.openProject(id, { batch: true });
    const p = S.project!;
    if (!p || p.id !== id) throw new Error('Не удалось открыть проект очереди.');
    p.batch!.status = 'running'; await this.save();
    try {
      const settings = p.batch!.settings;
      // A failed later stage can resume from cached PCM without requesting the large video again.
      if (!S.pcm && p.batch!.stages.prepare.status === 'done') p.batch!.stages.prepare.status = 'pending';
      await this.stage(p, 'prepare', async () => {
        const file = await this.source(p); this.check();
        await S.prepareBatchFile(file, settings.targetLufs);
      });
      await this.stage(p, 'transcribe', async () => {
        await S.transcribe({ batch: true, model: settings.model, device: 'auto' });
        if (!p.transcription) p.transcription = { words: structuredClone(p.words), model: settings.model, at: Date.now() };
      }, settings.transcribe);
      await this.stage(p, 'fillers', async () => { p.fillers = { ...p.fillers, sensitivity: 'normal', autoCut: true }; await S.findFillers({ batch: true, device: 'auto' }); }, settings.fillers);
      await this.stage(p, 'carve', async () => {
        if (!cfg) throw new Error('Настройте подключение к LLM, затем повторите этап.');
        if (!p.words.length) { p.batch!.stages.carve.note = 'Речь не обнаружена — монтаж не требуется.'; return; }
        const found = await autoCarve(p.words, S.wordState, { strength: settings.strength, signal: this.controller!.signal, config: cfg,
          onProgress: (done, total) => S.setTask({ kind: 'llm', frac: total ? done / total : 0, text: 'ИИ-монтаж: строго сохраняем смысл', cancel: () => this.stop() }),
        });
        this.check(); S.addSuggestions(found, true);
      }, settings.carve);
      await this.stage(p, 'texts', async () => {
        if (!cfg) throw new Error('Настройте подключение к LLM, затем повторите этап.');
        await this.texts(p, cfg);
      }, settings.texts);
      p.batch!.status = 'done';
      batchLog.event(id, 'Очередь', 'ФАЙЛ ГОТОВ. Автоматический экспорт видео не выполнялся.', { outputDuration: S.composite?.duration, stages: p.batch!.stages });
      await this.save();
      this.files.delete(id);
    } catch (e: any) {
      p.batch!.status = this.controller?.signal.aborted || e?.name === 'AbortError' ? 'interrupted' : 'error';
      this.error = `«${p.name}»: ${e.message || e}`;
      if (p.batch!.status === 'error') S.toast(this.error, 'err');
      await this.save();
      if (e?.name === 'QuotaExceededError') { this.controller?.abort(); throw e; }
    } finally {
      S.setTask(null); setRpcTrace(null);
      batchLog.event(id, 'Очередь', 'Обработка этого файла остановилась; итоговый статус: ' + p.batch!.status);
      await batchLog.flush(id); await this.count(); this.bump();
    }
  }
  async start() {
    await this.init();
    if (this.running || this.adding || this.exporting) return;
    if (S.task) { this.error = 'Сначала завершите текущую операцию.'; this.bump(); return; }
    this.running = true; S.batchRunning = true; S.batchView = true;
    this.controller = new AbortController(); this.error = null;
    S.batchCancel = () => this.stop();
    const visibility = () => { void this.holdWake(); };
    document.addEventListener('visibilitychange', visibility);
    this.bump(); void this.holdWake();
    // Sequential requests too; credentials stay in memory, never in project/queue JSON.
    try {
      const cfg: LlmConfig | null = llmConfigured() ? { ...llmConfig(), parallel: 1, requestTimeoutMs: 15 * 60 * 1000 } : null;
      await S.saveNow(true);
      const records = await this.scopedProjects();
      // Repair any project whose saved settings disagree with its stage flags before it is started.
      for (const p of records) {
        if (!p.batch || !this.queue.includes(p.id) || p.batch.status === 'done') continue;
        if (!syncStageFlags(p.batch)) continue;
        p.updatedAt = Date.now();
        await projects.save(p);
      }
      this.runIds = this.queue.filter(id => records.some(p => p.id === id && p.batch && !['done', 'error'].includes(p.batch.status)));
      await this.count(); this.bump();
      if (workspaceTokenFromLocation()) {
        await createWorkspaceApi((import.meta as any).env?.VITE_WORKSPACE_API || '/api/workspace').claimBatch(`queue-${Date.now()}`, this.runIds);
      }
      await sequentialJobs(this.runIds, id => this.process(id, cfg), () => !!this.controller?.signal.aborted);
    } catch (e: any) { this.error = e.message || String(e); S.toast('Очередь остановлена: ' + this.error, 'err'); }
    finally {
      const stopped = this.controller.signal.aborted;
      setRpcTrace(null);
      if (this.activeId) { batchLog.event(this.activeId, 'Очередь', stopped ? 'Очередь остановлена пользователем' : 'Запуск очереди окончен'); await batchLog.flush(this.activeId); }
      await S.saveNow(true).catch(() => {});
      S.closeProject(true);
      this.running = false; S.batchRunning = false; S.batchCancel = null; this.activeId = null;
      document.removeEventListener('visibilitychange', visibility);
      try { await this.wake?.release(); } catch { /* already released */ } this.wake = null;
      await this.count(); this.bump();
      S.toast(stopped ? 'Очередь остановлена. Завершённые этапы сохранены.' : 'Пакетная обработка завершена. Проверьте статусы проектов.', this.error ? 'info' : 'ok');
    }
  }
}
export const B = new BatchQueue();
export const useBatch = () => useSyncExternalStore(B.subscribe, B.snapshot, B.snapshot);
(window as any).__carverBatch = B;
