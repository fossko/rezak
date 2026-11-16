import assert from 'node:assert/strict';
import {
  DISABLED_NOTE, makeBatchState, recoverBatch, sequentialJobs, syncStageFlags, validateBatchSettings,
} from '../src/lib/batch-state.ts';
import type { BatchSettings } from '../src/lib/batch-types.ts';

const step = (enabled = true, map = 'summary') => ({
  id: 'summary', name: 'Summary', enabled, source: 'transcript', map, reduce: '', mode: 'single',
});
const settings = (overrides: Partial<BatchSettings> = {}): BatchSettings => ({
  transcribe: true, fillers: false, carve: false, texts: false,
  strength: 'careful', textSteps: [step()], model: 'model', targetLufs: -14, ...overrides,
});

// Settings are persisted as a snapshot, not a live reference.
const source = settings();
const state = makeBatchState(source);
source.textSteps[0].map = 'changed after creation';
source.transcribe = false;
assert.equal(state.settings.textSteps[0].map, 'summary');
assert.equal(state.settings.transcribe, true);

// Selected stages begin pending; video is always pending because export is manual.
assert.equal(state.stages.prepare.status, 'pending');
assert.equal(state.stages.transcribe.status, 'pending');
assert.equal(state.stages.fillers.status, 'skipped');
assert.equal(state.stages.carve.status, 'skipped');
assert.equal(state.stages.texts.status, 'skipped');
assert.equal(state.stages.video.status, 'pending');
assert.equal(state.stages.video.note, 'Только после ручного экспорта видео');

// Stage dependencies and setting constraints are validated before state creation.
assert.throws(() => validateBatchSettings(settings({ transcribe: false, fillers: true })), /расшифровка/);
assert.throws(() => validateBatchSettings(settings({ transcribe: false, carve: true })), /расшифровка/);
assert.throws(() => validateBatchSettings(settings({ strength: 'bad' as any })), /режим/);
assert.throws(() => validateBatchSettings(settings({ model: '' })), /Некоррект/);
assert.throws(() => validateBatchSettings(settings({ targetLufs: -30 })), /Некоррект/);
assert.throws(() => validateBatchSettings(settings({ texts: true, textSteps: [step(false, '')] })), /этап/);

// Recovery marks interrupted work, but leaves pending work pending.
const recovering = makeBatchState(settings({ texts: true }));
recovering.status = 'running';
recovering.stages.prepare.status = 'done';
recovering.stages.transcribe.status = 'running';
recovering.stages.texts.status = 'pending';
assert.equal(recoverBatch(recovering), true);
assert.equal(recovering.status, 'interrupted');
assert.equal(recovering.stages.transcribe.status, 'interrupted');
assert.equal(recovering.stages.texts.status, 'pending');
assert.equal(recoverBatch(recovering), false);

// Text sub-stages are persisted stage records too and must recover if running.
const textRecover = makeBatchState(settings({ texts: true }));
textRecover.status = 'running';
textRecover.textStages = { summary: { status: 'running' } };
assert.equal(recoverBatch(textRecover), true);
assert.equal(textRecover.textStages.summary.status, 'interrupted');

// Sequential primitive has at most one active run and observes stop before next.
const active: number[] = [];
let maxActive = 0;
await sequentialJobs([1, 2, 3], async (job) => {
  active.push(job); maxActive = Math.max(maxActive, active.length);
  await Promise.resolve();
  active.pop();
}, () => false);
assert.equal(maxActive, 1);

const stopped: number[] = [];
let stop = false;
await sequentialJobs([1, 2, 3], async (job) => { stopped.push(job); if (job === 1) stop = true; }, () => stop);
assert.deepEqual(stopped, [1]);

const rejected: number[] = [];
await assert.rejects(() => sequentialJobs([1, 2], async (job) => {
  rejected.push(job);
  if (job === 1) throw new Error('stop');
}, () => false), /stop/);
assert.deepEqual(rejected, [1]);

// Turning the whole «Тексты» group off must also disable checked text steps and pending/running stages.
const off = makeBatchState(settings({ texts: true, textSteps: [step(true)] }));
off.stages.texts.status = 'pending';
off.textStages = { summary: { status: 'interrupted' } };
off.settings.texts = false;
assert.equal(syncStageFlags(off), true);
assert.equal(off.stages.texts.status, 'skipped');
assert.equal(off.stages.texts.note, DISABLED_NOTE);
assert.equal(off.textStages.summary.status, 'skipped');
// Re-enabling restores pending work; completed results are never reset.
off.settings.texts = true;
off.settings.textSteps = [step(true)];
assert.equal(syncStageFlags(off), true);
assert.equal(off.stages.texts.status, 'pending');
assert.equal(off.stages.texts.note, undefined);
assert.equal(off.textStages.summary.status, 'pending');
const completed = makeBatchState(settings({ texts: true }));
completed.stages.texts.status = 'done';
completed.textStages = { summary: { status: 'done' } };
completed.settings.texts = false;
syncStageFlags(completed);
assert.equal(completed.stages.texts.status, 'done', 'completed text stage keeps its result');
assert.equal(completed.textStages.summary.status, 'done', 'completed text step keeps its result');
// The manual video stage and prepare are never altered by a group switch.
assert.equal(completed.stages.video.status, 'pending');
assert.equal(completed.stages.prepare.status, 'pending');
// Deselecting a text step while the group is on skips it; selecting it again makes it pending.
const stepToggle = makeBatchState(settings({ texts: true }));
stepToggle.textStages = { summary: { status: 'error', error: 'x' } };
stepToggle.settings.textSteps = [step(false)];
assert.equal(syncStageFlags(stepToggle), true);
assert.equal(stepToggle.textStages.summary.status, 'skipped');
assert.equal(stepToggle.textStages.summary.error, undefined);
stepToggle.settings.textSteps = [step(true)];
assert.equal(syncStageFlags(stepToggle), true);
assert.equal(stepToggle.textStages.summary.status, 'pending');

console.log('batch-state: ok');
