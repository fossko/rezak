// Заставки: a small library of short intro/outro/header videos the user uploads from disk and inserts
// into the main timeline. Metadata and file handles live in IndexedDB; the media is opened lazily
// (mediabunny) and cached for preview and export.
import { Input, BlobSource, ALL_FORMATS, type InputVideoTrack, type InputAudioTrack } from 'mediabunny';
import { idb } from './db';
import type { TitleAsset } from './types';
import { uid } from './util';

const LIB_KEY = 'title-lib';

export async function loadTitleLib(): Promise<TitleAsset[]> {
  return (await idb.get<TitleAsset[]>('kv', LIB_KEY).catch(() => undefined)) || [];
}
async function saveTitleLib(list: TitleAsset[]) { await idb.put('kv', LIB_KEY, list); }


/** A title must be decodable by THIS browser. WebCodecs has no ProRes (and no HEVC outside hardware
 *  support), so without this check the failure surfaces much later — in mediabunny, in the middle of an
 *  export, as "This video track cannot be decoded in this environment". */
async function assertDecodable(video: InputVideoTrack, audio: InputAudioTrack | null, name: string) {
  if (!(await video.canDecode().catch(() => false))) {
    const codec = String(await video.getCodec().catch(() => '?')).toUpperCase();
    throw new Error(
      `Заставка «${name}»: кодек ${codec} Chrome не декодирует. Перекодируйте в H.264 (MP4) — ` +
      `QuickTime → «Файл» → «Экспортировать» → 1080p, либо в терминале: ` +
      `avconvert --preset Preset1920x1080 --source "in.mov" --output "out.mp4"`,
    );
  }
  if (audio && !(await audio.canDecode().catch(() => false))) {
    const codec = String(await audio.getCodec().catch(() => '?')).toUpperCase();
    throw new Error(`Заставка «${name}»: звук ${codec} Chrome не декодирует — перекодируйте заставку в H.264/AAC (MP4).`);
  }
}

export async function addTitleFile(file: File, handle: FileSystemFileHandle | null): Promise<TitleAsset> {
  const input = new Input({ source: new BlobSource(file, { maxCacheSize: 64 << 20 }), formats: ALL_FORMATS });
  if (!(await input.canRead())) throw new Error('Формат заставки не поддерживается. Нужен MP4/MOV/WebM.');
  const video = await input.getPrimaryVideoTrack().catch(() => null);
  if (!video) throw new Error('В заставке нет видео.');
  const audio = await input.getPrimaryAudioTrack().catch(() => null);
  await assertDecodable(video, audio, file.name);
  const duration = await input.computeDuration();
  const fps = (await video.computeFrameRateMetrics().then((m) => m.bestGuessFrameRate).catch(() => 24)) || 24;
  const meta: TitleAsset = {
    id: uid(), name: file.name.replace(/\.[^.]+$/, ''),
    duration,
    width: await video.getDisplayWidth(), height: await video.getDisplayHeight(),
    fps: Math.round(fps * 1000) / 1000,
    hasVideo: true,
    hasAudio: !!audio,
    sampleRate: audio ? await audio.getSampleRate() : 0, channels: audio ? await audio.getNumberOfChannels() : 0,
    videoCodec: String(await video.getCodec()), audioCodec: audio ? String(await audio.getCodec()) : '',
  };
  input.dispose();
  if (handle) await idb.put('handles', `title:${meta.id}`, handle).catch(() => {});
  // titles are short: keep the bytes too, so they stay readable even if the file handle is lost
  await idb.put('blobs', `title:${meta.id}`, file).catch(() => {});
  const list = await loadTitleLib();
  list.push(meta);
  await saveTitleLib(list);
  return meta;
}

export async function removeTitleAsset(id: string) {
  await idb.del('handles', `title:${id}`);
  await idb.del('blobs', `title:${id}`);
  await idb.del('kv', `title-input:${id}`);
  await saveTitleLib((await loadTitleLib()).filter((t) => t.id !== id));
  titleCache.delete(id);
}

export interface TitleMedia { input: Input; video: InputVideoTrack; audio: InputAudioTrack | null }

const titleCache = new Map<string, Promise<TitleMedia>>();

/** Open (or reuse) a title's media. The file is read lazily from disk. */
export async function openTitle(id: string): Promise<TitleMedia> {
  let p = titleCache.get(id);
  if (!p) {
    p = (async () => {
      let file = await idb.get<FileSystemFileHandle>('handles', `title:${id}`).then((h) => h?.getFile?.()).catch(() => undefined);
      if (!file) file = await idb.get<File>('blobs', `title:${id}`).catch(() => undefined);
      if (!file) throw new Error('Заставка не найдена — укажите файл заново.');
      const input = new Input({ source: new BlobSource(file, { maxCacheSize: 64 << 20 }), formats: ALL_FORMATS });
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new Error('В заставке нет видео.');
      const audio = await input.getPrimaryAudioTrack().catch(() => null);
      const lib = await loadTitleLib().catch(() => []);
      await assertDecodable(video, audio, lib.find((x) => x.id === id)?.name || id);
      return { input, video, audio } as TitleMedia;
    })();
    titleCache.set(id, p);
  }
  return p;
}

/** Replace the bytes behind an existing заставка, keeping its id: every insertion in the project keeps
 *  working. Needed when the original file turns out to be undecodable (ProRes) or was re-exported. */
export async function replaceTitleFile(id: string, file: File, handle: FileSystemFileHandle | null): Promise<TitleAsset> {
  const input = new Input({ source: new BlobSource(file, { maxCacheSize: 64 << 20 }), formats: ALL_FORMATS });
  if (!(await input.canRead())) throw new Error('Формат заставки не поддерживается. Нужен MP4/MOV/WebM.');
  const video = await input.getPrimaryVideoTrack().catch(() => null);
  if (!video) throw new Error('В заставке нет видео.');
  const audio = await input.getPrimaryAudioTrack().catch(() => null);
  await assertDecodable(video, audio, file.name);
  const duration = await input.computeDuration();
  const fps = (await video.computeFrameRateMetrics().then((m) => m.bestGuessFrameRate).catch(() => 24)) || 24;
  const list = await loadTitleLib();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('Заставка не найдена в библиотеке.');
  const updated: TitleAsset = {
    ...list[i],
    name: file.name.replace(/\.[^.]+$/, ''),
    duration,
    width: await video.getDisplayWidth(), height: await video.getDisplayHeight(),
    fps: Math.round(fps * 1000) / 1000,
    hasAudio: !!audio,
    sampleRate: audio ? await audio.getSampleRate() : 0, channels: audio ? await audio.getNumberOfChannels() : 0,
    videoCodec: String(await video.getCodec()), audioCodec: audio ? String(await audio.getCodec()) : '',
  };
  input.dispose();
  const cached = titleCache.get(id);
  if (cached) { cached.then((t) => t.input.dispose()).catch(() => {}); titleCache.delete(id); }
  if (handle) await idb.put('handles', `title:${id}`, handle).catch(() => {});
  else await idb.del('handles', `title:${id}`).catch(() => {});
  await idb.put('blobs', `title:${id}`, file).catch(() => {});
  list[i] = updated;
  await saveTitleLib(list);
  return updated;
}

export function disposeTitleInputs() { for (const p of titleCache.values()) p.then((t) => t.input.dispose()).catch(() => {}); titleCache.clear(); }

/** Original basename (WITH extension) for an offline XML media reference. No decoding or permission
 * prompt: the handle name and the persisted File survive a closed/reopened project. Never guess .mp4. */
export async function titleFileName(id: string): Promise<string> {
  const handle = await idb.get<FileSystemFileHandle>('handles', `title:${id}`).catch(() => undefined);
  if (handle?.name) return handle.name;
  const file = await idb.get<File>('blobs', `title:${id}`).catch(() => undefined);
  if (file?.name) return file.name;
  throw new Error('Не найдено имя исходного файла заставки. Укажите файл заставки заново.');
}

/** File handle of a title, so it can be re-linked if the browser forgot it. */
export async function titleHandle(id: string) { return idb.get<FileSystemFileHandle>('handles', `title:${id}`).catch(() => undefined); }
