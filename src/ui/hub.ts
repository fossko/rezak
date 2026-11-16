// Shared non-React singletons for the editor UI.
import type { Player } from '../player/player';
import { S, prefs } from '../store';

type TimeListener = (src: number, out: number) => void;
export const hub = {
  player: null as Player | null,
  timeListeners: new Set<TimeListener>(),
  onTime(f: TimeListener) { this.timeListeners.add(f); return () => { this.timeListeners.delete(f); }; },
  /** set when the user scrolls the text by hand: auto-follow pauses for a few seconds */
  userScrolledAt: 0,
  scrollToWord: null as ((i: number, smooth?: boolean) => void) | null,
  /** Word on the visual line above (dir -1) / below (dir 1) word i, nearest to the remembered column. */
  lineTarget: null as ((i: number, dir: 1 | -1) => number | null) | null,
  /** the last keyboard move went backwards (←/↑): the caret sits before the focus word instead of after it */
  caretBack: false,
};

/** Formats the app can open as a SOURCE: video, plus plain audio (no picture) for podcasts/voice notes. */
export const MEDIA_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.mp3', '.m4a', '.m4b', '.aac', '.wav', '.wave', '.flac', '.ogg', '.oga', '.opus'];
export const MEDIA_ACCEPT = 'video/*,audio/*,' + MEDIA_EXTENSIONS.join(',');
export const MEDIA_TYPES = [
  { description: 'Видео и аудио', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.mkv', '.webm'], 'audio/*': ['.mp3', '.m4a', '.m4b', '.aac', '.wav', '.wave', '.flac', '.ogg', '.oga', '.opus'] } },
];

/** Source picker: video or plain audio. An audio-only source gets a black preview and MP3 export. */
export async function pickMedia(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  const w = window as any;
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({ types: MEDIA_TYPES, excludeAcceptAllOption: false, multiple: false });
      return { file: await h.getFile(), handle: h };
    } catch (e: any) { if (e?.name === 'AbortError') return null; }
  }
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = MEDIA_ACCEPT;
    inp.onchange = () => res(inp.files && inp.files[0] ? { file: inp.files[0], handle: null } : null);
    inp.click();
  });
}

/** Video-only picker: заставки need a picture (their audio alone would make no sense as an insert). */
export async function pickVideo(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  const w = window as any;
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({
        types: [{ description: 'Видео', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.mkv', '.webm'] } }],
        excludeAcceptAllOption: false, multiple: false,
      });
      return { file: await h.getFile(), handle: h };
    } catch (e: any) { if (e?.name === 'AbortError') return null; }
  }
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'video/*,.mp4,.mov,.m4v,.mkv,.webm';
    inp.onchange = () => res(inp.files && inp.files[0] ? { file: inp.files[0], handle: null } : null);
    inp.click();
  });
}

export async function fileFromDrop(e: DragEvent | React.DragEvent): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  const dt = e.dataTransfer; if (!dt) return null;
  const item = dt.items && dt.items[0];
  if (item && (item as any).getAsFileSystemHandle) {
    try {
      const h = await (item as any).getAsFileSystemHandle();
      if (h && h.kind === 'file') return { file: await h.getFile(), handle: h };
    } catch { /* fall through */ }
  }
  const f = dt.files && dt.files[0];
  return f ? { file: f, handle: null } : null;
}

/** Playback-synced "scrub": when the focused word changes, hear the first few ms of its source audio.
 *  Ignored while the player is running and when the user turned scrubbing off. */
export function scrubWord(i: number) {
  const p = hub.player, w = S.project?.words[i];
  if (!p || !w || prefs.scrub === false) return;
  void p.scrub(w.start, prefs.scrubMs);
}
