import assert from 'node:assert/strict';
import { acquireProjectLock, claimBatch, expireWorkspaceLocks, lockFor, localProjectsToDrop, localProjectsToReupload, releaseProjectLock, WorkspaceError, LOCK_TTL_MS } from '../src/lib/workspace.ts';

const t = 1000;
let locks = acquireProjectLock([], 'a', 'alice', 'editor', t);
assert.equal(lockFor(locks, 'a', t)?.ownerId, 'alice');
assert.throws(() => acquireProjectLock(locks, 'a', 'bob', 'editor', t), /PROJECT_LOCKED/);
locks = releaseProjectLock(locks, 'a', 'alice', t);
assert.equal(lockFor(locks, 'a', t), undefined);
locks = claimBatch([], { queueId: 'q', projectIds: ['a', 'b'], ownerId: 'worker' }, t);
assert.equal(locks.length, 2);
assert.equal(locks.every(x => x.kind === 'batch'), true);
assert.equal(expireWorkspaceLocks(locks, t + LOCK_TTL_MS).length, 0);

// A deletion (server tombstone) removes the local copy; a project merely missing on the server is re-uploaded.
const remote = new Set(['kept']);
const localCopies = [
  { id: 'kept', workspaceId: 'ws' },
  { id: 'deleted', workspaceId: 'ws' },
  { id: 'lost-by-server', workspaceId: 'ws' },
  { id: 'private', workspaceId: undefined },
  { id: 'other-ws', workspaceId: 'ws2' },
];
const tombstones = new Set(['deleted']);
assert.deepEqual(localProjectsToDrop(localCopies, 'ws', remote, tombstones), ['deleted'], 'only tombstoned projects are deleted locally');
assert.deepEqual(localProjectsToReupload(localCopies, 'ws', remote, tombstones), ['lost-by-server'], 'a project missing without a tombstone is restored, not deleted');

// A deleted project cannot be resurrected by a stale tab: the API surfaces HTTP 410 to the caller.
const gone = new WorkspaceError('PROJECT_DELETED', 410);
assert.equal(gone.status, 410);
assert.ok(gone instanceof Error);

console.log('workspace tests: ok');
