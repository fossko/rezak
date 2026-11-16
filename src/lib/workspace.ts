/** Collaboration primitives and client for shared Carver workspaces.
 * Video bytes never cross this boundary: only project metadata/transcript/edit state is synced.
 */
export type WorkspaceLockKind = 'editor' | 'batch';
export interface WorkspaceLock { projectId: string; ownerId: string; kind: WorkspaceLockKind; acquiredAt: number; lastSeen: number; queueId?: string }
export interface WorkspaceProject { id: string; name: string; updatedAt: number; revision: number; data: unknown; video?: never }
/** Project entry of the light poll: no data, just what is needed to notice a change. */
export interface WorkspaceProjectMeta { id: string; name: string; revision: number; updatedAt: number }
export interface WorkspaceDeleted { id: string; at: number }
/** What the 5 s poll fetches: kilobytes instead of the whole workspace. */
export interface WorkspaceManifest { id: string; name: string; updatedAt: number; projects: WorkspaceProjectMeta[]; locks: WorkspaceLock[]; deleted: WorkspaceDeleted[] }
export interface Workspace { id: string; name: string; token: string; projects: WorkspaceProject[]; locks: WorkspaceLock[]; updatedAt: number; deleted?: WorkspaceDeleted[] }
export interface BatchClaim { queueId: string; projectIds: string[]; ownerId: string }

export const LOCK_TTL_MS = 60_000;
export const POLL_MS = 5_000;

export function expireWorkspaceLocks(locks: readonly WorkspaceLock[], now = Date.now()): WorkspaceLock[] {
  return locks.filter(lock => now - lock.lastSeen < LOCK_TTL_MS);
}
export function lockFor(locks: readonly WorkspaceLock[], projectId: string, now = Date.now()): WorkspaceLock | undefined {
  return expireWorkspaceLocks(locks, now).find(lock => lock.projectId === projectId);
}
export function acquireProjectLock(locks: readonly WorkspaceLock[], projectId: string, ownerId: string, kind: WorkspaceLockKind, now = Date.now(), queueId?: string): WorkspaceLock[] {
  const live = expireWorkspaceLocks(locks, now);
  const current = live.find(lock => lock.projectId === projectId);
  if (current && current.ownerId !== ownerId) throw new Error('PROJECT_LOCKED');
  const next: WorkspaceLock = current ? { ...current, kind, lastSeen: now, queueId } : { projectId, ownerId, kind, acquiredAt: now, lastSeen: now, queueId };
  return [...live.filter(lock => lock.projectId !== projectId), next];
}
export function heartbeatProjectLocks(locks: readonly WorkspaceLock[], ownerId: string, projectIds: readonly string[], now = Date.now()): WorkspaceLock[] {
  const wanted = new Set(projectIds);
  return expireWorkspaceLocks(locks, now).map(lock => lock.ownerId === ownerId && wanted.has(lock.projectId) ? { ...lock, lastSeen: now } : lock);
}
export function releaseProjectLock(locks: readonly WorkspaceLock[], projectId: string, ownerId: string, now = Date.now()): WorkspaceLock[] {
  return expireWorkspaceLocks(locks, now).filter(lock => !(lock.projectId === projectId && lock.ownerId === ownerId));
}
export function claimBatch(locks: readonly WorkspaceLock[], claim: BatchClaim, now = Date.now()): WorkspaceLock[] {
  let next = [...locks];
  for (const projectId of claim.projectIds) next = acquireProjectLock(next, projectId, claim.ownerId, 'batch', now, claim.queueId);
  return next;
}

/** API failure that keeps the HTTP status, so callers can tell 410 GONE (deleted) from 401/409. */
export class WorkspaceError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body = message) { super(message); this.name = 'WorkspaceError'; this.status = status; this.body = body; }
}

/** Server revision carried by a `409 STALE_REVISION` answer, or null when the body is not one. */
export function staleRevision(error: unknown): number | null {
  if (!(error instanceof WorkspaceError) || error.status !== 409) return null;
  try {
    const body = JSON.parse(error.body) as { project?: { revision?: unknown }; revision?: unknown };
    const revision = body.project?.revision ?? body.revision;
    return typeof revision === 'number' && Number.isFinite(revision) ? revision : null;
  } catch { return null; }
}

export interface WorkspaceApi {
  enter(token: string): Promise<void>;
  getWorkspace(): Promise<Workspace>;
  /** Light poll: revisions of every project, locks and tombstones, without project bodies. */
  getManifest(): Promise<WorkspaceManifest>;
  /** One project with its data (fetched only when its revision changed). */
  getProject(projectId: string): Promise<WorkspaceProject>;
  saveProject(projectId: string, data: unknown, revision: number): Promise<WorkspaceProject>;
  /** Removes the project from the workspace for every participant. Idempotent: a missing project is fine. */
  deleteProject(projectId: string): Promise<void>;
  /** «Заметки редактора»: patches only the notes field, so a stale editor cannot overwrite the rest. */
  saveNotes(projectId: string, notes: string): Promise<WorkspaceProject>;
  lock(projectId: string, kind?: WorkspaceLockKind, queueId?: string): Promise<void>;
  unlock(projectId: string): Promise<void>;
  heartbeat(projectIds: string[]): Promise<void>;
  claimBatch(queueId: string, projectIds: string[]): Promise<void>;
}

/** Thin API client. The server authenticates the HttpOnly workspace cookie created by the magic link. */
export function createWorkspaceApi(base = '/api/workspace'): WorkspaceApi {
  // The service keeps sessions in memory: a restart invalidates every open tab's cookie. The magic-link
  // token is still in the page URL, so silently exchange it for a new session and retry the request.
  let reauth: Promise<boolean> | null = null;
  function reauthenticate(): Promise<boolean> {
    if (reauth) return reauth;
    const token = workspaceTokenFromLocation();
    if (!token) return Promise.resolve(false);
    reauth = fetch(`${base}/enter`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(r => r.ok).catch(() => false)
      .finally(() => { reauth = null; });
    return reauth;
  }
  async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
    } catch {
      // fetch() rejects only when no response arrived at all (offline, connection reset mid-upload).
      throw new WorkspaceError('нет связи с сервером — проверьте интернет и повторите', 0, '');
    }
    if (response.status === 401 && !retried && path !== '/enter' && await reauthenticate()) {
      return request<T>(path, init, true);
    }
    if (response.status === 413) {
      // nginx refused the upload before the service saw it (client_max_body_size).
      throw new WorkspaceError('проект слишком большой для сервера (лимит загрузки nginx)', 413, '');
    }
    if (!response.ok) {
      const body = await response.text();
      // The service answers with {"error": "…"}; show that text, not the raw JSON.
      let message = body;
      try { const parsed = JSON.parse(body) as { error?: unknown }; if (parsed && typeof parsed.error === 'string') message = parsed.error; } catch { /* not JSON */ }
      throw new WorkspaceError(message || `Workspace request failed (${response.status})`, response.status, body);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  return {
    enter: token => request<void>('/enter', { method: 'POST', body: JSON.stringify({ token }) }),
    getWorkspace: () => request<Workspace>(''),
    getManifest: () => request<WorkspaceManifest>('/manifest'),
    getProject: projectId => request<WorkspaceProject>(`/projects/${encodeURIComponent(projectId)}`),
    saveProject: (projectId, data, revision) => request<WorkspaceProject>(`/projects/${encodeURIComponent(projectId)}`, { method: 'PUT', body: JSON.stringify({ data, revision }) }),
    deleteProject: projectId => request<void>(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
    saveNotes: (projectId, notes) => request<WorkspaceProject>(`/projects/${encodeURIComponent(projectId)}/notes`, { method: 'PATCH', body: JSON.stringify({ notes }) }),
    lock: (projectId, kind = 'editor', queueId) => request<void>(`/projects/${encodeURIComponent(projectId)}/lock`, { method: 'POST', body: JSON.stringify({ kind, queueId }) }),
    unlock: projectId => request<void>(`/projects/${encodeURIComponent(projectId)}/lock`, { method: 'DELETE' }),
    heartbeat: projectIds => request<void>('/heartbeat', { method: 'POST', body: JSON.stringify({ projectIds }) }),
    claimBatch: (queueId, projectIds) => request<void>('/batch/claim', { method: 'POST', body: JSON.stringify({ queueId, projectIds }) }),
  };
}

/** Local copies that came from this workspace but are neither on the server nor explicitly deleted there.
 *  Those are re-uploaded: a project must only vanish locally when the server recorded a deletion (tombstone),
 *  never merely because the file lost it. */
export function localProjectsToReupload(
  local: readonly { id: string; workspaceId?: string }[],
  workspaceId: string,
  remoteIds: ReadonlySet<string>,
  tombstones: ReadonlySet<string>,
): string[] {
  return local
    .filter(p => p.workspaceId === workspaceId && !remoteIds.has(p.id) && !tombstones.has(p.id))
    .map(p => p.id);
}

/** Local copies deleted for everyone (the server has a tombstone for them).
 *  Only copies that came from this workspace are touched: unrelated local projects are never deleted. */
export function localProjectsToDrop(
  local: readonly { id: string; workspaceId?: string }[],
  workspaceId: string,
  remoteIds: ReadonlySet<string>,
  tombstones: ReadonlySet<string>,
): string[] {
  return local
    .filter(p => p.workspaceId === workspaceId && !remoteIds.has(p.id) && tombstones.has(p.id))
    .map(p => p.id);
}

export function workspaceTokenFromLocation(location = window.location): string | null {
  const params = new URLSearchParams(location.search);
  return params.get('workspace') || (location.hash.startsWith('#workspace=') ? decodeURIComponent(location.hash.slice(11)) : null);
}
