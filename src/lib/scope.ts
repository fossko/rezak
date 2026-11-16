/** Visibility scope of projects: local (this machine only) or one shared workspace.
 *  A project belongs to exactly one of them: `workspaceId` is set for workspace projects and absent for local ones. */
export type ProjectScope = { kind: 'local' } | { kind: 'workspace'; id: string };

export interface ScopedProject { id: string; workspaceId?: string }

export function inScope(project: ScopedProject, scope: ProjectScope | null): boolean {
  if (!scope) return false;
  return scope.kind === 'local' ? !project.workspaceId : project.workspaceId === scope.id;
}

export function filterProjects<T extends ScopedProject>(list: readonly T[], scope: ProjectScope | null): T[] {
  return scope ? list.filter((p) => inScope(p, scope)) : [];
}

/** The batch queue is per scope: a local queue must never be read (or pruned) inside a workspace. */
export function queueKey(scope: ProjectScope): string {
  return scope.kind === 'local' ? 'batch-queue-v1:local' : `batch-queue-v1:ws:${scope.id}`;
}

/** Key used before scopes existed; its ids are filtered by scope when migrated. */
export const LEGACY_QUEUE_KEY = 'batch-queue-v1';
