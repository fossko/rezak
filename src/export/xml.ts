// Final Cut Pro 7 XML (xmeml v5), supported by Premiere Pro and DaVinci Resolve.
// Pure serializer: no browser APIs, decoding, rendering, or audio-effect translation.
import type { Clip } from '../lib/composite';

export interface XmlSource {
  name: string; duration: number; fps: number; width: number; height: number;
  hasVideo: boolean; hasAudio: boolean; sampleRate: number; channels: number;
}
export interface XmlRate { timebase: number; ntsc: boolean; fps: number }
export function xmlRate(fps: number): XmlRate {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error('Некорректная частота кадров исходника.');
  for (const timebase of [24, 30, 60, 120, 240]) {
    const actual = timebase * 1000 / 1001;
    if (Math.abs(fps - actual) < 0.002) return { timebase, ntsc: true, fps: actual };
  }
  // xmeml only represents integer rates and 1000/1001 rates, not arbitrary VFR.
  const timebase = Math.round(fps);
  if (!timebase || Math.abs(timebase - fps) > 0.002) {
    throw new Error(`XML не поддерживает частоту ${fps} к/с. Сначала преобразуйте исходник в постоянную стандартную частоту кадров.`);
  }
  return { timebase, ntsc: false, fps: timebase };
}
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const rateXml = (r: XmlRate) => `<rate><timebase>${r.timebase}</timebase><ntsc>${r.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
const videoFormat = (s: XmlSource, r: XmlRate) => `<samplecharacteristics>${rateXml(r)}<width>${s.width}</width><height>${s.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;

/** Only complete source frames inside each kept interval are exported. Packing is based on integer
 * output-frame lengths, never independently rounded starts: there can be no holes or overlaps.
 * For mixed rates, in/out/duration are source frames; start/end are sequence frames. */
export function makeTimelineXml(name: string, clips: readonly Clip[], main: XmlSource, titles: ReadonlyMap<string, XmlSource>) {
  const rate = xmlRate(main.fps);
  const sources = new Map<string, { source: XmlSource; rate: XmlRate; id: string }>();
  let skippedClips = 0, cursor = 0, exactFrames = 0;
  const items: { source: XmlSource; rate: XmlRate; fileId: string; start: number; end: number; a: number; b: number; index: number }[] = [];
  for (const c of clips) {
    const key = c.kind === 'main' ? 'main' : `title:${c.titleId}`;
    const source = c.kind === 'main' ? main : titles.get(c.titleId || '');
    if (!source) throw new Error('Не найден исходный файл заставки для XML.');
    if ((!source.hasVideo && !source.hasAudio) || !source.name || !Number.isFinite(source.duration) || source.duration <= 0 ||
      (source.hasVideo && (!Number.isInteger(source.width) || source.width <= 0 || !Number.isInteger(source.height) || source.height <= 0)) ||
      (source.hasAudio && (!Number.isInteger(source.channels) || source.channels < 1 || !Number.isInteger(source.sampleRate) || source.sampleRate < 1))) {
      throw new Error(`Некорректные метаданные файла «${source.name}».`);
    }
    if (!Number.isFinite(c.a) || !Number.isFinite(c.b) || c.b <= c.a || c.a < 0 || c.b > source.duration + 1e-6) throw new Error('Некорректные границы клипа для XML.');
    let entry = sources.get(key);
    if (!entry) { entry = { source, rate: xmlRate(source.fps), id: `file-${sources.size + 1}` }; sources.set(key, entry); }
    const a = Math.ceil(c.a * entry.rate.fps - 1e-7);
    const b = Math.floor(Math.min(c.b, source.duration) * entry.rate.fps + 1e-7);
    if (b <= a) { skippedClips++; continue; }
    const duration = (b - a) * rate.fps / entry.rate.fps;
    const end = Math.round(exactFrames + duration);
    if (end <= cursor) { skippedClips++; continue; }
    exactFrames += duration;
    items.push({ source, rate: entry.rate, fileId: entry.id, start: cursor, end, a, b, index: items.length + 1 });
    cursor = end;
  }
  if (!items.length) throw new Error('Нечего экспортировать: не осталось целых кадров.');
  const emittedFiles = new Set<string>();
  const fileXml = (item: typeof items[number]) => {
    const { source: s, rate: r, fileId } = item;
    if (emittedFiles.has(fileId)) return `<file id="${fileId}"/>`;
    emittedFiles.add(fileId);
    // A browser cannot know an absolute local filesystem path. This offline URL preserves the real
    // basename (including extension) for the editor's Locate/Relink command; it is NOT a blob URL.
    const path = `file://localhost/${encodeURIComponent(s.name).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
    return `<file id="${fileId}"><name>${esc(s.name)}</name><pathurl>${esc(path)}</pathurl>${rateXml(r)}<duration>${Math.floor(s.duration * r.fps + 1e-7)}</duration><media>${s.hasVideo ? `<video>${videoFormat(s, r)}</video>` : ''}${s.hasAudio ? `<audio><samplecharacteristics><depth>16</depth><samplerate>${s.sampleRate}</samplerate></samplecharacteristics><channelcount>${s.channels}</channelcount></audio>` : ''}</media></file>`;
  };
  const videoItems = items.filter((i) => i.source.hasVideo);
  const channels = items.reduce((n, i) => Math.max(n, i.source.hasAudio ? i.source.channels : 0), 0);
  const audioItems = Array.from({ length: channels }, (_, channel) => items.filter((i) => i.source.hasAudio && i.source.channels > channel));
  const videoIndices = new Map(videoItems.map((i, n) => [i.index, n + 1]));
  const audioIndices = audioItems.map((track) => new Map(track.map((i, n) => [i.index, n + 1])));
  const id = (i: typeof items[number], channel: number) => `clip-${i.index}-${channel < 0 ? 'v' : `a${channel + 1}`}`;
  const clipXml = (i: typeof items[number], channel: number) => {
    const video = channel < 0;
    const links: string[] = [];
    const link = (ch: number, track: number, index: number) => `<link><linkclipref>${id(i, ch)}</linkclipref><mediatype>${ch < 0 ? 'video' : 'audio'}</mediatype><trackindex>${track}</trackindex><clipindex>${index}</clipindex>${ch >= 0 && i.source.channels === 2 ? '<groupindex>1</groupindex>' : ''}</link>`;
    if (i.source.hasVideo) links.push(link(-1, 1, videoIndices.get(i.index)!));
    if (i.source.hasAudio) for (let ch = 0; ch < i.source.channels; ch++) links.push(link(ch, ch + 1, audioIndices[ch].get(i.index)!));
    return `<clipitem id="${id(i, channel)}"><name>${esc(i.source.name)}</name><enabled>TRUE</enabled><duration>${Math.floor(i.source.duration * i.rate.fps + 1e-7)}</duration>${rateXml(i.rate)}<start>${i.start}</start><end>${i.end}</end><in>${i.a}</in><out>${i.b}</out>${fileXml(i)}<sourcetrack><mediatype>${video ? 'video' : 'audio'}</mediatype><trackindex>${video ? 1 : channel + 1}</trackindex></sourcetrack>${links.join('')}</clipitem>`;
  };
  const video = `<video><format>${videoFormat(main.hasVideo ? main : { ...main, width: 1920, height: 1080 }, rate)}</format><track>${videoItems.map((i) => clipXml(i, -1)).join('')}</track></video>`;
  const audio = channels ? `<audio><numOutputChannels>${channels}</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>${main.sampleRate || 48000}</samplerate></samplecharacteristics></format>${audioItems.map((track, ch) => `<track>${track.map((i) => clipXml(i, ch)).join('')}</track>`).join('')}</audio>` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="sequence-1"><name>${esc(name)}</name><duration>${cursor}</duration>${rateXml(rate)}<timecode>${rateXml(rate)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media>${video}${audio}</media></sequence></xmeml>\n`;
  return { xml, skippedClips, durationFrames: cursor, rate };
}
