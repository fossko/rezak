// Tiny IndexedDB wrapper. Stores:
//  projects  — Project objects (transcript + edits), key = id
//  blobs     — large binary data per project: `${id}:pcm` (16 kHz s16 mono), `${id}:levels`
//  handles   — FileSystemFileHandle of the source video, key = project id
//  kv        — misc (transcription checkpoints, settings)
import type { Project } from './types';

const DB_NAME = 'carver';
const DB_VER = 1;
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ['projects', 'blobs', 'handles', 'kv']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await open();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? (req.result as T) : (undefined as T));
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('IndexedDB transaction aborted'));
  });
}

export const idb = {
  get: <T>(store: string, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key)),
  put: (store: string, key: string, val: unknown) => tx<void>(store, 'readwrite', (s) => { s.put(val, key); }),
  del: (store: string, key: string) => tx<void>(store, 'readwrite', (s) => { s.delete(key); }),
  all: <T>(store: string) => tx<T[]>(store, 'readonly', (s) => s.getAll()),
};

export const projects = {
  list: async () => (await idb.all<Project>('projects')).sort((a, b) => b.updatedAt - a.updatedAt),
  get: (id: string) => idb.get<Project>('projects', id),
  save: (p: Project) => idb.put('projects', p.id, p),
  async remove(id: string) {
    await idb.del('projects', id);
    for (const k of ['pcm', 'levels']) await idb.del('blobs', `${id}:${k}`);
    await idb.del('handles', id);
    await idb.del('handles', `export-video:${id}`);
    await idb.del('kv', `ckpt:${id}`);
    await (await import('./batch-log')).batchLog.remove(id);
  },
};

export async function requestPersistentStorage() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
