import type { BatchProject, BatchSettings, StageId, StageRecord } from './batch-types';

export function validateBatchSettings(s: BatchSettings): void {
  if (!s.transcribe && (s.fillers || s.carve || s.texts)) throw new Error('Для выбранных этапов нужна расшифровка.');
  if (!['careful', 'normal', 'aggressive'].includes(s.strength)) throw new Error('Неизвестный режим ИИ-монтажа.');
  if (!s.model || !Number.isFinite(s.targetLufs) || s.targetLufs < -24 || s.targetLufs > -10) throw new Error('Некорректные настройки обработки.');
  if (s.texts && !s.textSteps.some(x => x.enabled && x.map.trim())) throw new Error('Выберите хотя бы один этап генерации текстов.');
}
export function makeBatchState(settings: BatchSettings): BatchProject {
  validateBatchSettings(settings);
  const selected = { prepare: true, transcribe: settings.transcribe, fillers: settings.fillers, carve: settings.carve, texts: settings.texts, video: false };
  const stages = Object.fromEntries(Object.entries(selected).map(([k, on]) => [k, { status: on ? 'pending' : 'skipped' }])) as Record<StageId, StageRecord>;
  stages.video = { status: 'pending', note: 'Только после ручного экспорта видео' };
  return { settings: structuredClone(settings), stages, status: 'queued' };
}
/** Note written when a stage is switched off in the shared settings. */
export const DISABLED_NOTE = 'Отключено в общих настройках';
/** Make stage availability follow `settings`, so a queue created earlier still obeys an off switch.
 *  Completed stages keep their results; the manually exported video stage is never touched. */
export function syncStageFlags(state: BatchProject): boolean {
  let changed = false;
  const enabled = { prepare: true, transcribe: state.settings.transcribe, fillers: state.settings.fillers, carve: state.settings.carve, texts: state.settings.texts };
  for (const [id, on] of Object.entries(enabled) as [StageId, boolean][]) {
    const stage = state.stages[id];
    if (!stage || stage.status === 'done' || stage.status === 'running') continue;
    if (!on && stage.status !== 'skipped') {
      stage.status = 'skipped'; stage.error = undefined; stage.note = DISABLED_NOTE; changed = true;
    } else if (on && stage.status === 'skipped') {
      stage.status = 'pending'; stage.error = undefined;
      if (stage.note === DISABLED_NOTE) stage.note = undefined;
      changed = true;
    }
  }
  const textStages = state.textStages || {};
  if (!state.settings.texts) {
    for (const stage of Object.values(textStages)) {
      if (stage.status === 'done' || stage.status === 'running' || stage.status === 'skipped') continue;
      stage.status = 'skipped'; stage.error = undefined; changed = true;
    }
  } else {
    // The group is on: follow the individual step checkboxes, including stale checked steps from before.
    const selected = new Set(state.settings.textSteps.filter(s => s.enabled && s.map.trim()).map(s => s.id));
    for (const [stepId, stage] of Object.entries(textStages)) {
      if (stage.status === 'done' || stage.status === 'running') continue;
      if (!selected.has(stepId) && stage.status !== 'skipped') { stage.status = 'skipped'; stage.error = undefined; changed = true; }
      else if (selected.has(stepId) && stage.status === 'skipped') { stage.status = 'pending'; stage.error = undefined; changed = true; }
    }
  }
  return changed;
}
export function recoverBatch(state: BatchProject): boolean {
  let changed = false;
  for (const stage of [...Object.values(state.stages), ...Object.values(state.textStages || {})]) if (stage.status === 'running') {
    stage.status = 'interrupted'; stage.error = 'Вкладка закрылась или обработка была прервана.'; changed = true;
  }
  if (state.status === 'running') { state.status = 'interrupted'; changed = true; }
  return changed;
}
/** Pure sequential primitive: never launches the next job before the previous promise settles. */
export async function sequentialJobs<T>(jobs: readonly T[], run: (job: T) => Promise<void>, stopped: () => boolean) {
  for (const job of jobs) { if (stopped()) break; await run(job); }
}
