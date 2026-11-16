// Saving many files at once: Chrome asks once for a folder (File System Access API); the handle is
// remembered in IndexedDB and permission is re-requested on later use. Each project gets a subfolder.
import { idb } from '../lib/db';

const KEY = 'exportDir';
export const folderSupported = () => typeof (window as any).showDirectoryPicker === 'function' || !!(window as any).__carverTestDir;

/** Must be called from a click (permission prompts need a user gesture). */
export async function getExportDir(pickNew = false): Promise<FileSystemDirectoryHandle | null> {
  const w = window as any;
  if (w.__carverTestDir) return await w.__carverTestDir();   // automated tests: OPFS directory
  if (!pickNew) {
    const h = await idb.get<FileSystemDirectoryHandle>('kv', KEY).catch(() => undefined);
    if (h) {
      try {
        let perm = await (h as any).queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await (h as any).requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') return h;
      } catch { /* fall through to the picker */ }
    }
  }
  try {
    const h: FileSystemDirectoryHandle = await w.showDirectoryPicker({ id: 'carver-export', mode: 'readwrite', startIn: 'videos' });
    await idb.put('kv', KEY, h).catch(() => {});
    return h;
  } catch (e: any) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
}
export async function rememberedDirName(): Promise<string | null> {
  const h = await idb.get<FileSystemDirectoryHandle>('kv', KEY).catch(() => undefined);
  return h ? h.name : null;
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'carver';

export async function subfolder(dir: FileSystemDirectoryHandle, name: string) {
  return dir.getDirectoryHandle(safeName(name), { create: true });
}
export async function fileIn(dir: FileSystemDirectoryHandle, name: string) {
  return dir.getFileHandle(safeName(name), { create: true });
}
export async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: string | Blob) {
  const fh = await fileIn(dir, name);
  const w = await (fh as any).createWritable();
  await w.write(data);
  await w.close();
}
