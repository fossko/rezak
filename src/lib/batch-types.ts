// Persisted processing state. No API keys, media bytes, or live AbortControllers in projects.
import type { StepDef } from '../llm/pipeline';
export const STAGE_IDS = ['prepare', 'transcribe', 'fillers', 'carve', 'texts', 'video'] as const;
export type StageId = typeof STAGE_IDS[number];
export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'interrupted';
export interface StageRecord { status: StageStatus; started?: number; finished?: number; error?: string; note?: string }
export interface BatchSettings {
  transcribe: boolean; fillers: boolean; carve: boolean; texts: boolean;
  strength: 'careful' | 'normal' | 'aggressive';
  textSteps: StepDef[];
  model: string;
  targetLufs: number;
}
export interface BatchProject {
  settings: BatchSettings;
  stages: Record<StageId, StageRecord>;
  status: 'queued' | 'running' | 'done' | 'error' | 'interrupted';
  gpuWarning?: string;
  textStages?: Record<string, StageRecord>;
  outputDuration?: number;
}
export const STAGE_LABELS: Record<StageId, string> = {
  prepare: 'Аудио и громкость', transcribe: 'Расшифровка', fillers: 'Слова-паразиты',
  carve: 'ИИ-монтаж', texts: 'Тексты', video: 'Экспорт видео',
};
export const STAGE_ICONS: Record<StageId, string> = {
  prepare: '♫', transcribe: 'Т', fillers: '✂', carve: '✦', texts: '≡', video: '▶',
};
export const STATUS_LABELS: Record<StageStatus, string> = {
  pending: 'Ожидает', running: 'Выполняется', done: 'Готово', error: 'Ошибка', skipped: 'Не выбран', interrupted: 'Прервано',
};
