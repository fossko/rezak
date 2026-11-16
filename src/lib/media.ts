// Opening the source media lazily with mediabunny (reads only the byte ranges it needs,
// so multi-GB files never sit in memory).
import { Input, BlobSource, ALL_FORMATS, type InputVideoTrack, type InputAudioTrack } from 'mediabunny';
import type { MediaMeta } from './types';

export interface OpenedMedia {
  file: File;
  input: Input;
  video: InputVideoTrack | null;
  audio: InputAudioTrack;
  meta: MediaMeta;
}

/** Whether the media has a picture. Audio-only imports (MP3, M4A, WAV, FLAC, OGG…) and projects
 *  saved before `MediaMeta.hasVideo` existed are both handled here. */
export function mediaHasVideo(meta: MediaMeta): boolean {
  return meta.hasVideo ?? !!meta.videoCodec;
}

export async function openMedia(file: File): Promise<OpenedMedia> {
  const input = new Input({ source: new BlobSource(file, { maxCacheSize: 64 << 20 }), formats: ALL_FORMATS });
  if (!(await input.canRead())) throw new Error('Формат файла не поддерживается. Нужен MP4, MOV, MKV, WebM, MP3, M4A, WAV, FLAC или OGG.');
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  // Audio-only files (podcasts, voice notes) are first-class: the preview shows black, export is MP3.
  if (!audio) throw new Error('В файле нет звуковой дорожки.');
  if (!(await audio.canDecode())) throw new Error(`Браузер не умеет декодировать звук этого файла (${await audio.getCodec()}).`);
  if (video && !(await video.canDecode())) throw new Error(`Браузер не умеет декодировать видео этого файла (${await video.getCodec()}).`);
  const duration = await input.computeDuration();
  let fps = 30, videoBitrate = 0;
  if (video) {
    try {
      const m = await video.computeFrameRateMetrics();
      fps = m.bestGuessFrameRate || m.averageFrameRate || fps;
      fps = Math.round(fps * 1000) / 1000;
    } catch { /* keep default */ }
    // rough estimate: everything that isn't audio is video
    const ab = 192000;
    videoBitrate = Math.max(0, (file.size * 8) / Math.max(1, duration) - ab);
  }
  const meta: MediaMeta = {
    name: file.name, size: file.size, lastModified: file.lastModified, duration,
    hasVideo: !!video,
    width: video ? await video.getDisplayWidth() : 0,
    height: video ? await video.getDisplayHeight() : 0,
    fps,
    videoCodec: video ? String(await video.getCodec()) : '',
    audioCodec: String(await audio.getCodec()),
    sampleRate: await audio.getSampleRate(),
    channels: await audio.getNumberOfChannels(),
    videoBitrate,
  };
  return { file, input, video, audio, meta };
}

export function sameFile(f: File, m: MediaMeta) {
  return f.size === m.size && (f.name === m.name || f.lastModified === m.lastModified);
}
