import { useEffect, useState } from 'react';
import { S, prefs, useStore } from '../store';
import { exportMp4, pickOutputFile, defaultVideoBitrate, buildClipAudio } from '../export/render';
import { exportMp3 } from '../export/audio';
import { openTitle, titleFileName, type TitleMedia } from '../lib/titles';
import { makeTimelineXml, type XmlSource } from '../export/xml';
import { outWords, makeSRT, makeJSON, makePlainText, makeTimedText } from '../export/subs';
import { getExportDir, subfolder, fileIn, writeFile, folderSupported, rememberedDirName } from '../export/folder';
import { loadSteps } from '../llm/pipeline';
import { saveBlob, fmtDur } from '../lib/util';
import { mediaHasVideo } from '../lib/media';
import { hub } from './hub';
import { levelerFromPoints } from '../lib/leveler';
import type { MasterOptions, RestoreOptions } from '../export/audio';
import { TILE_S } from '../restore/engine';
import { idb } from '../lib/db';

// ---------------------------------------------------------------- options (remembered)
export interface ExportPrefs {
  videoBitrate: number | null;       // null = default for this source
  videoMute: boolean;                // silence muted words in the MP4
  mp3Bitrate: number;
  audioMute: boolean;                // silence muted words in the MP3
  maskSubs: boolean;                 // write muted words as «х****» in subtitles / texts
  all: { video: boolean; audio: boolean; texts: boolean; ai: boolean; project: boolean };
}
const KEY = 'carver:export';
export function loadExportPrefs(): ExportPrefs {
  const d: ExportPrefs = { videoBitrate: null, videoMute: false, mp3Bitrate: 320000, audioMute: true, maskSubs: false,
    all: { video: true, audio: true, texts: true, ai: true, project: true } };
  try { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); return { ...d, ...s, all: { ...d.all, ...(s.all || {}) } }; } catch { return d; }
}
const saveExportPrefs = (p: ExportPrefs) => localStorage.setItem(KEY, JSON.stringify(p));

const muteArgs = (on: boolean) => ({ mutes: on ? S.muteRegions() : [], muteFade: S.profOpts().fadeMs / 1000 });

/** What the timeline holds goes to the file: the stored gain curve and the compressor settings of the
 *  Аудио tab (S.master), rendered sample-exactly here — this is the only full-length render. */
function masterOptions(): MasterOptions | undefined {
  if (prefs.audioBypass) return undefined;
  const m = S.master;
  if (!m) return undefined;              // an empty curve = phrase leveling off (unity gain)
  return { leveler: levelerFromPoints(m.full).gainAt, compressor: { ...m.comp, makeupDb: m.makeupDb ?? 0 }, ceilingDb: m.ceilingDb };
}
/** «Реставрация» for one render: plan every tile the kept main content touches (in output order), hand the
 *  renderer an awaiting accessor, and release the plan afterwards. Off (0 %) ⇒ no model, original sound. */
async function withRestore<T>(ac: AbortController, fn: (r: RestoreOptions | undefined) => Promise<T>): Promise<T> {
  const R = S.restorer;
  if (prefs.audioBypass || R.amount <= 0) return fn(undefined);
  const plan: number[] = [];
  for (const c of S.composite?.clips || []) {
    if (c.kind !== 'main') continue;
    for (let k = Math.floor(c.a / TILE_S); k * TILE_S < c.b; k++) if (!plan.includes(k)) plan.push(k);
  }
  R.beginExport(plan);
  try { return await fn({ amount: R.amount, wet: (s0, n) => R.wetAsync(s0, n, ac.signal) }); }
  finally { R.endExport(); }
}
const outName = (ext: string) => `${S.project!.name} (резак)${ext}`;

function guard(): boolean {
  const p = S.project, m = S.media, edl = S.edl;
  if (!p || !m || !edl) { S.toast('Сначала укажите исходный файл.', 'err'); return false; }
  if (!edl.segments.length) { S.toast('Нечего экспортировать: всё вырезано.', 'err'); return false; }
  return true;
}
/** Audio-only project: the video is black and only MP3 is produced. */
const hasVideoNow = () => !!(S.media ? S.media.video : S.project && mediaHasVideo(S.project.media));
const busyText = (what: string, f: number, info: string) => `${what} ${Math.round(f * 100)}% ${info}`;

async function titleMedia(): Promise<Map<string, TitleMedia>> {
  const ids = new Set((S.composite?.clips || []).filter((c) => c.kind === 'title').map((c) => c.titleId!));
  const m = new Map<string, TitleMedia>();
  for (const id of ids) m.set(id, await openTitle(id));
  return m;
}
async function renderMp4(handle: FileSystemFileHandle | null, o: ExportPrefs, ac: AbortController, label = 'Видео') {
  if (!S.media?.video) throw new Error('В проекте только звук — MP4 не создаётся. Экспортируйте MP3.');
  const p = S.project!, comp = S.composite!, tm = await titleMedia();
  return withRestore(ac, (restore) => exportMp4(S.media!, comp, tm, handle, {
    videoBitrate: o.videoBitrate || defaultVideoBitrate(p.media.videoBitrate), audioBitrate: 192000, fade: p.cut.fade, signal: ac.signal,
    master: masterOptions(), restore,
    ...muteArgs(o.videoMute),
    onProgress: (f, info) => S.setTask({ kind: 'export', frac: f, text: busyText(label, f, info), cancel: () => ac.abort() }),
  }));
}
async function renderMp3(handle: FileSystemFileHandle | null, o: ExportPrefs, ac: AbortController, label = 'Аудио MP3') {
  const p = S.project!, comp = S.composite!, tm = await titleMedia();
  const clips = await buildClipAudio(S.media!, comp, tm);
  return withRestore(ac, (restore) => exportMp3(S.media!, clips, comp.duration, handle, {
    bitrate: o.mp3Bitrate, fade: p.cut.fade, signal: ac.signal, master: masterOptions(), restore, ...muteArgs(o.audioMute),
    onProgress: (f, info) => S.setTask({ kind: 'export', frac: f, text: busyText(label, f, info), cancel: () => ac.abort() }),
  }));
}
async function runTask(fn: (ac: AbortController) => Promise<string | null>) {
  hub.player?.pause();
  const ac = new AbortController();
  const t0 = performance.now();
  S.setTask({ kind: 'export', frac: 0, text: 'Экспорт…', cancel: () => ac.abort() });
  try {
    const msg = await fn(ac);
    S.setTask(null);
    if (msg) S.toast(`${msg} — за ${fmtDur((performance.now() - t0) / 1000)}`, 'ok');
  } catch (e: any) {
    S.setTask(null);
    if (e?.name === 'AbortError') S.toast('Экспорт отменён', 'info');
    else { console.error(e); S.toast('Ошибка экспорта: ' + (e.message || e), 'err'); }
  }
}

async function markManualVideoExport(projectId: string, name: string, handle: FileSystemFileHandle | null) {
  // Mark only the project that was snapshotted for this command; never infer completion from XML/results.
  const p = S.project;
  if (!p || p.id !== projectId) return;
  p.videoExport = { at: Date.now(), name };
  if (p.batch) {
    p.batch.stages.video = { ...p.batch.stages.video, status: 'done', finished: Date.now() };
  }
  if (handle) await idb.put('handles', `export-video:${projectId}`, handle).catch(() => {});
  else await idb.del('handles', `export-video:${projectId}`).catch(() => {});
  await S.saveNow(true);
  S.bump();
}

export async function runExportMp4() {
  if (!guard()) return;
  if (!hasVideoNow()) { S.toast('Это аудиопроект: видео нет, экспортируется только MP3.', 'info'); return; }
  const projectId = S.project!.id;
  const o = loadExportPrefs(), name = outName('.mp4');
  let handle: FileSystemFileHandle | null;
  try { handle = await pickOutputFile(name, 'mp4'); } catch { return; }
  if (!handle && S.composite!.duration > 1200 && !confirm('Браузер не даёт записать файл напрямую на диск, поэтому видео будет собрано в памяти. Для длинных записей это может не хватить памяти. Продолжить?')) return;
  await runTask(async (ac) => {
    const b = await renderMp4(handle, o, ac);
    if (b) saveBlob(b, name);
    await markManualVideoExport(projectId, handle?.name || name, handle);
    return `Готово: ${handle?.name || name}`;
  });
}
export async function runExportMp3() {
  if (!guard()) return;
  const o = loadExportPrefs(), name = outName('.mp3');
  let handle: FileSystemFileHandle | null;
  try { handle = await pickOutputFile(name, 'mp3'); } catch { return; }
  await runTask(async (ac) => { const b = await renderMp3(handle, o, ac); if (b) saveBlob(b, name); return `Готово: ${handle?.name || name}`; });
}

/** Edit-list interchange only: never render/re-encode the media or start restoration/model downloads. */
export async function runExportXml() {
  if (!guard() || !S.composite) return;
  // Snapshot before the async filename lookups, so edits/project changes cannot mix two timelines.
  const p = S.project!, clips = S.composite.clips.map((c) => ({ ...c }));
  const main: XmlSource = { ...p.media, name: S.media!.file.name, hasVideo: !!S.media!.video, hasAudio: true };
  const assets = new Map(S.titleLib.map((a) => [a.id, { ...a }]));
  const name = `${p.name} (резак)`;
  try {
    const titles = new Map<string, XmlSource>();
    for (const c of clips) {
      if (c.kind !== 'title' || titles.has(c.titleId!)) continue;
      const asset = assets.get(c.titleId!);
      if (!asset) throw new Error('Не найдена заставка для XML.');
      titles.set(c.titleId!, { ...asset, name: await titleFileName(c.titleId!) });
    }
    const result = makeTimelineXml(name, clips, main, titles);
    saveBlob(new Blob([result.xml], { type: 'application/xml;charset=utf-8' }), `${name}.xml`);
    S.toast(result.skippedClips
      ? `XML сохранён. Фрагменты короче целого кадра пропущены: ${result.skippedClips}. При импорте укажите исходные файлы.`
      : 'XML сохранён. При импорте укажите исходное видео и файлы заставок.', result.skippedClips ? 'info' : 'ok');
  } catch (e: any) {
    console.error(e);
    S.toast('Ошибка экспорта XML: ' + (e.message || e), 'err');
  }
}

/** Text outputs of the carved result (subtitles, JSON, plain / timecoded text). */
export function textFiles(o: ExportPrefs): [string, string][] {
  const p = S.project!, edl = S.edl!;
  const mask = o.maskSubs ? S.wordMute : undefined;
  const ws = outWords(p.words, S.wordState, edl, mask, S.composite?.srcToOut);
  return [
    [outName('.srt'), makeSRT(ws)],
    [outName('.json'), makeJSON({ source: p.media.name, duration: p.media.duration }, p.words, S.wordState, edl, mask, S.muteRegions(), S.composite?.srcToOut, S.composite?.duration)],
    [outName('.txt'), makePlainText(ws)],
    [outName('.timecoded.txt'), makeTimedText(ws)],
  ];
}
function aiFiles(): [string, string][] {
  const p = S.project!, steps = loadSteps();
  return p.pipeline.filter((r) => r.text.trim()).map((r) => {
    const i = steps.findIndex((s) => s.id === r.stepId), st = steps[i];
    return [`${p.name}.${i >= 0 ? i + 1 : 'x'}-${st ? st.name : r.stepId}.md`, r.text] as [string, string];
  });
}

/** «Сохранить всё»: everything into <chosen folder>/<project name>/. */
export async function runSaveAll() {
  if (!guard()) return;
  const o = loadExportPrefs(), a = o.all;
  let dir: FileSystemDirectoryHandle | null;
  try { dir = await getExportDir(); } catch (e: any) { S.toast('Нет доступа к папке: ' + (e.message || e), 'err'); return; }
  if (!dir) return;
  await S.saveNow();
  const p = S.project!, projectId = p.id;
  await runTask(async (ac) => {
    const sub = await subfolder(dir!, p.name);
    const saved: string[] = [];
    if (a.texts) for (const [n, t] of textFiles(o)) { await writeFile(sub, n, t); saved.push(n); }
    if (a.ai) for (const [n, t] of aiFiles()) { await writeFile(sub, n, t); saved.push(n); }
    if (a.project) { const n = `${p.name}.carver.json`; await writeFile(sub, n, JSON.stringify({ app: 'carver', ...p })); saved.push(n); }
    if (a.audio) { const n = outName('.mp3'); await renderMp3(await fileIn(sub, n), o, ac, 'Сохранение: аудио MP3'); saved.push(n); }
    if (a.video && S.media?.video) { const n = outName('.mp4'), handle = await fileIn(sub, n); await renderMp4(handle, o, ac, 'Сохранение: видео'); await markManualVideoExport(projectId, n, handle); saved.push(n); }
    console.log('[carver] saved', saved);
    return `Сохранено в «${dir!.name}/${sub.name}»: ${saved.length} файлов`;
  });
}

// ---------------------------------------------------------------- UI
export function ExportPanel() {
  const p = useStore((s) => s.project!);
  const edl = useStore((s) => s.edl);
  const media = useStore((s) => s.media);
  const task = useStore((s) => s.task);
  useStore((s) => s.editRev);
  const [o, setO] = useState<ExportPrefs>(loadExportPrefs());
  const [dirName, setDirName] = useState<string | null>(null);
  const [xmlBusy, setXmlBusy] = useState(false);
  useEffect(() => { rememberedDirName().then(setDirName); }, [task]);
  const upd = (x: Partial<ExportPrefs>) => { const n = { ...o, ...x }; setO(n); saveExportPrefs(n); };
  const updAll = (x: Partial<ExportPrefs['all']>) => upd({ all: { ...o.all, ...x } });
  const hasVideo = mediaHasVideo(p.media);
  const def = defaultVideoBitrate(p.media.videoBitrate);
  const br = o.videoBitrate || def;
  const busy = !!task && task.kind !== 'models';
  const opts = [...new Set([def, 8e6, 12e6, 20e6, 30e6])].sort((a, b) => a - b);
  const dl = (name: string, text: string, mime = 'text/plain') => saveBlob(new Blob([text], { type: mime + ';charset=utf-8' }), name);
  const muted = Array.from(S.wordMute).filter(Boolean).length;
  const est = S.composite ? (br + 192000) / 8 * S.composite.duration : 0;
  // A hidden checkbox (видео MP4) must not keep «Сохранить всё» enabled in an audio-only project.
  const nothing = !((hasVideo && o.all.video) || o.all.audio || o.all.texts || o.all.ai || o.all.project);
  return (
    <div className="panel">
      {hasVideo ? <>
        <h3>Видео MP4</h3>
        <label className="col" style={{ gap: 4 }}>Качество (H.264)
          <select value={br} onChange={(e) => upd({ videoBitrate: +e.target.value })}>
            {opts.map((b) => <option key={b} value={b}>{(b / 1e6).toFixed(1).replace('.', ',')} Мбит/с{b === def ? ' — как исходник с запасом' : ''}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={o.videoMute} onChange={(e) => upd({ videoMute: e.target.checked })} />
          заглушать заглушённые слова в видео{muted ? ` (${muted})` : ''}</label>
        <div className="hint">{p.media.width}×{p.media.height}, {p.media.fps} к/с · ≈ {(est / 1e9).toFixed(2).replace('.', ',')} ГБ · кодирование на видеокарте, звук AAC 192 кбит/с.</div>
        <button disabled={!media || !edl || busy} onClick={runExportMp4}>Экспортировать MP4…</button>
      </> : <>
        <h3>Аудиопроект</h3>
        <div className="hint" data-audio-only>Исходник без видео: в проигрывателе чёрный кадр, MP4 не создаётся. Экспорт — MP3, субтитры и текст.</div>
      </>}

      <h3 style={{ marginTop: 8 }}>Аудио MP3</h3>
      <div className="row wrap">
        <select value={o.mp3Bitrate} onChange={(e) => upd({ mp3Bitrate: +e.target.value })}>
          <option value={320000}>320 кбит/с</option><option value={256000}>256 кбит/с</option><option value={192000}>192 кбит/с</option><option value={128000}>128 кбит/с</option>
        </select>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={o.audioMute} onChange={(e) => upd({ audioMute: e.target.checked })} /> заглушать заглушённые слова</label>
      </div>
      <div className="hint tip">Вырезано одинаково во всех файлах — длина всегда одинаковая. Отличаться может только заглушение.</div>
      <button disabled={!media || !edl || busy} onClick={runExportMp3}>Экспортировать MP3…</button>

      {hasVideo && <>
        <h3 style={{ marginTop: 8 }}>Таймлайн XML</h3>
        <button disabled={!media || !edl?.segments.length || busy || xmlBusy} onClick={async () => {
          setXmlBusy(true);
          try { await runExportXml(); } finally { setXmlBusy(false); }
        }}>{xmlBusy ? 'Подготовка XML…' : 'Экспортировать XML'}</button>
        <div className="hint">Premiere Pro / DaVinci Resolve · Final Cut Pro 7 XML. После импорта укажите исходное видео и файлы заставок: XML не содержит само видео.</div>
        <div className="hint">Звук — исходный: обработка и заглушение слов не переносятся, заглушённые слова будут слышны.</div>
        <div className="hint">Границы подрезаются до целых кадров внутрь оставленных фрагментов: XML может быть немного короче MP4 и субтитров. Нужны исходники с постоянной частотой кадров.</div>
        <div className="hint tip">Только оставшиеся фрагменты и заставки, без промежутков. Фрагменты короче целого кадра пропускаются.</div>
      </>}

      <h3 style={{ marginTop: 8 }}>Сохранить всё</h3>
      <div className="col" style={{ gap: 4 }}>
        {hasVideo && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={o.all.video} onChange={(e) => updAll({ video: e.target.checked })} /> видео MP4 {o.videoMute ? '(мат заглушён)' : '(без заглушения)'}</label>}
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={o.all.audio} onChange={(e) => updAll({ audio: e.target.checked })} /> аудио MP3 {o.audioMute ? '(мат заглушён)' : '(без заглушения)'}</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={o.all.texts} onChange={(e) => updAll({ texts: e.target.checked })} /> субтитры SRT, JSON, текст и текст с таймкодами</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={o.all.ai} onChange={(e) => updAll({ ai: e.target.checked })} /> результаты вкладки «Тексты» ({p.pipeline.length})</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={o.all.project} onChange={(e) => updAll({ project: e.target.checked })} /> файл проекта (.carver.json)</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={o.maskSubs} onChange={(e) => upd({ maskSubs: e.target.checked })} /> в субтитрах и текстах скрывать заглушённые слова (х***)</label>
      </div>
      <div className="row wrap">
        <button className="primary" disabled={!media || !edl || busy || nothing || !folderSupported()} onClick={runSaveAll}>Сохранить всё в папку…</button>
        {dirName && <span className="hint">папка: <b>{dirName}</b> · <a href="#" onClick={async (e) => { e.preventDefault(); const d = await getExportDir(true); if (d) setDirName(d.name); }}>сменить</a></span>}
      </div>
      <div className="hint tip">Chrome один раз попросит доступ к папке и запомнит его. Внутри будет создана папка «{p.name}».</div>

      <h3 style={{ marginTop: 8 }}>Отдельные файлы</h3>
      <div className="row wrap">
        {edl && textFiles(o).map(([n, t]) => <button key={n} className="small" onClick={() => dl(n, t, n.endsWith('.json') ? 'application/json' : n.endsWith('.srt') ? 'application/x-subrip' : 'text/plain')}>{n.slice(n.lastIndexOf(')') + 1)}</button>)}
        <button className="small" onClick={async () => { await S.saveNow(); saveBlob(new Blob([JSON.stringify({ app: 'carver', ...S.project })], { type: 'application/json' }), `${p.name}.carver.json`); }}>.carver.json</button>
      </div>
      <div className="hint tip">Таймкоды субтитров и текстов — по смонтированной записи. Файл проекта (расшифровка и все правки) можно передать коллеге.</div>
    </div>
  );
}
