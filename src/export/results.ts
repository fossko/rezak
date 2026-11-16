// Batch-result downloads. This module never activates a project or renders media.
import type { Project, Word } from '../lib/types';
import { idb, projects } from '../lib/db';
import { S } from '../store';
import { computeLevels } from '../lib/pcm';
import { buildEdl, detectSilences, type Edl } from '../lib/edl';
import { outWords, makeSRT, makeJSON, makePlainText, makeTimedText } from './subs';
import { makeTimelineXml, type XmlSource } from './xml';
import { titleFileName, loadTitleLib } from '../lib/titles';
import { buildComposite } from '../lib/composite';
import { getExportDir, subfolder, writeFile, safeName } from './folder';
import { mediaHasVideo } from '../lib/media';
import { loadSteps } from '../llm/pipeline';
import { batchLog } from '../lib/batch-log';

export interface ResultManifest { project: string; id: string; exportedAt: string; stages: Record<string, unknown>; files: string[]; skipped: string[]; error?: string }

type Dir = FileSystemDirectoryHandle;
const json = (x: unknown) => JSON.stringify(x, null, 2) + '\n';
const rawWords = (p: Project) => p.transcription?.words ?? p.words;
const text = (p: Project) => rawWords(p).filter(w => !w.kind).map(w => w.text).join(' ').replace(/\s+([,.;:!?])/g, '$1');
const originalPlain = (p: Project) => {
  const out: string[] = [];
  for (const w of rawWords(p)) { if (w.para || !out.length) out.push(w.text); else out[out.length - 1] += ' ' + w.text; }
  return out.join('\n\n') + '\n';
};

async function archivedEdl(p: Project): Promise<Edl | null> {
  const active = S.project?.id === p.id && S.edl;
  if (active) return S.edl;
  const blob = await idb.get<Blob>('blobs', `${p.id}:pcm`).catch(() => undefined);
  if (!blob) return null;
  const pcm = new Int16Array(await blob.arrayBuffer());
  const levels = computeLevels(pcm);
  const silences = detectSilences(levels, p.silence);
  return buildEdl({ duration: p.media.duration, words: p.words, wordState: p.wordState, silences, silence: p.silence,
    keptSilences: new Set(p.keptSilences || []), rangeCuts: p.rangeCuts, cut: p.cut, edges: p.edges });
}
function stageMap(p: Project) {
  return Object.fromEntries(Object.entries(p.batch?.stages || {}).map(([k, v]) => [k, v]));
}
function sourceJson(p: Project) {
  return json({ app: 'carver', version: 1, source: p.media.name, duration: p.media.duration,
    words: rawWords(p).map((w, i) => ({ ...w, i })), projectId: p.id });
}
async function writeProject(dir: Dir, p: Project): Promise<ResultManifest> {
  if (S.project?.id === p.id) await S.saveNow(true);
  p = await projects.get(p.id) || p;
  const m: ResultManifest = { project: p.name, id: p.id, exportedAt: new Date().toISOString(), stages: stageMap(p), files: [], skipped: [] };
  const sub = await subfolder(dir, `${safeName(p.name).slice(0, 80)}-${safeName(p.id).slice(0, 32)}`);
  await batchLog.load(p.id);
  batchLog.event(p.id, 'Выгрузка', 'Сохранение результатов в папку', { folder: sub.name });
  const put = async (name: string, data: string, required = false) => {
    await writeFile(sub, name, data); m.files.push(name);
    batchLog.event(p.id, 'Выгрузка', 'Файл записан: ' + name, { chars: data.length });
    if (required) m.skipped = m.skipped.filter(x => x !== name);
  };
  try {
    await put('project.carver.json', json({ app: 'carver', ...p }), true);
    if (p.words?.length) {
      await put('transcript.original.txt', originalPlain(p), true);
      await put('transcript.original.json', sourceJson(p), true);
    } else {
      m.skipped.push('original transcript: transcript is unavailable');
    }
    if (p.videoExport) {
      try {
        const handle = await idb.get<FileSystemFileHandle>('handles', `export-video:${p.id}`);
        if (!handle) throw new Error('готовый MP4 сохранён отдельно; доступ к файлу не запомнен');
        const file = await handle.getFile();
        await writeFile(sub, p.videoExport.name, file); m.files.push(safeName(p.videoExport.name));
      } catch (e: any) { m.skipped.push('video: ' + (e.message || e)); }
    }
    for (const r of p.pipeline || []) {
      if (!r.text?.trim()) continue;
      const steps = p.batch?.settings.textSteps || loadSteps();
      const i = steps.findIndex(s => s.id === r.stepId);
      await put(`llm-${String(i < 0 ? r.stepId : `${i + 1}-${steps[i]?.name || r.stepId}`)}.md`, r.text);
    }
    const edl = await archivedEdl(p);
    const titleAssets = new Map((await loadTitleLib()).map(a => [a.id, a]));
    const missingTitles = (p.titles || []).some(t => !titleAssets.has(t.assetId));
    const composite = edl && !missingTitles ? buildComposite(edl, p.titles, titleAssets) : null;
    if (!edl || !composite) {
      m.skipped.push(!edl ? 'processed subtitles/texts and XML: cached PCM is unavailable' : 'processed subtitles/texts and XML: title metadata is missing');
    } else {
      const state = p.wordState || [];
      const toOut = composite.srcToOut;
      const ws = outWords(p.words, state, edl, undefined, toOut);
      await put('processed.srt', makeSRT(ws));
      await put('processed.txt', makePlainText(ws));
      await put('processed.timecoded.txt', makeTimedText(ws));
      await put('processed.json', makeJSON({ source: p.media.name, duration: p.media.duration }, p.words, state, edl, undefined, undefined, toOut, composite.duration));
      if (mediaHasVideo(p.media)) {
        try {
          const main: XmlSource = { ...p.media, name: p.media.name, hasVideo: true, hasAudio: true };
          const clips = composite.clips;
          const titles = new Map<string, XmlSource>();
          for (const c of clips) if (c.kind === 'title' && c.titleId) {
            const a = titleAssets.get(c.titleId);
            if (!a) throw new Error('кэш метаданных заставки недоступен');
            titles.set(c.titleId, { ...a, name: await titleFileName(c.titleId) });
          }
          const x = makeTimelineXml(`${p.name} (резак)`, clips, main, titles);
          await put('timeline.xml', x.xml);
        } catch (e: any) { m.skipped.push(`XML: ${e?.message || 'metadata unavailable'}`); }
      }
    }
  } catch (e: any) { m.error = e?.message || String(e); }
  batchLog.event(p.id, 'Выгрузка', m.error || m.skipped.length ? 'Результаты выгружены частично' : 'Результаты подготовлены', m);
  try {
    await batchLog.flush(p.id);
    await writeFile(sub, 'processing.log.txt', batchLog.text(p.id)); m.files.push('processing.log.txt');
  } catch (e: any) { m.skipped.push('processing.log.txt: ' + (e.message || e)); }
  try { await writeFile(sub, 'manifest.json', json(m)); } catch (e: any) { m.error = (m.error ? m.error + '; ' : '') + (e?.message || e); }
  return m;
}

/** Pick a directory during the click, then export this project without changing S.project. */
export async function downloadProjectResults(p: Project): Promise<void> {
  let dir: Dir | null;
  try { dir = await getExportDir(); } catch (e: any) { S.toast('Нет доступа к папке: ' + (e?.message || e), 'err'); return; }
  if (!dir) return;
  try {
    const m = await writeProject(dir, p);
    S.toast(m.error || m.skipped.length ? `Результаты сохранены частично: ${m.error || m.skipped.join('; ')}` : `Результаты проекта сохранены (${m.files.length} файлов)`, m.error || m.skipped.length ? 'info' : 'ok');
  } catch (e: any) { S.toast('Не удалось сохранить результаты: ' + (e.message || e), 'err'); }
}

/** One picker gesture, then sequential per-project exports; one failure does not stop the queue. */
export async function downloadAllResults(list: Project[]): Promise<void> {
  let dir: Dir | null;
  try { dir = await getExportDir(); } catch (e: any) { S.toast('Нет доступа к папке: ' + (e?.message || e), 'err'); return; }
  if (!dir) return;
  const reports: ResultManifest[] = [];
  for (const p of list) { try { reports.push(await writeProject(dir, p)); } catch (e: any) { reports.push({ project: p.name, id: p.id, exportedAt: new Date().toISOString(), stages: stageMap(p), files: [], skipped: [], error: e?.message || String(e) }); } }
  const failed = reports.filter(r => r.error).length;
  const skipped = reports.reduce((n, r) => n + r.skipped.length, 0);
  S.toast(failed || skipped ? `Результаты сохранены частично: ${reports.length - failed}/${reports.length} проектов, пропусков ${skipped}` : `Результаты сохранены: ${reports.length} проектов`, failed || skipped ? 'info' : 'ok');
}

// Kept for pure callers/tests and to make accidental fabricated text obvious.
export { text as originalText };
