import assert from 'node:assert/strict';
import { filterProjects, inScope, queueKey, LEGACY_QUEUE_KEY } from '../src/lib/scope.ts';

const local = { id: 'local-1' };
const other = { id: 'other-local' };
const ws = { id: 'ws-1', workspaceId: 'ws-a' };
const otherWs = { id: 'ws-2', workspaceId: 'ws-b' };
const all = [local, other, ws, otherWs];

const localScope = { kind: 'local' } as const;
const wsScope = { kind: 'workspace', id: 'ws-a' } as const;

assert.equal(inScope(local, localScope), true);
assert.equal(inScope(ws, localScope), false);
assert.equal(inScope(ws, wsScope), true);
assert.equal(inScope(local, wsScope), false);
assert.equal(inScope(ws, null), false);   // while a workspace is loading nothing is shown

assert.deepEqual(filterProjects(all, localScope).map((p) => p.id), ['local-1', 'other-local']);
assert.deepEqual(filterProjects(all, wsScope).map((p) => p.id), ['ws-1']);
assert.deepEqual(filterProjects(all, { kind: 'workspace', id: 'ws-b' }).map((p) => p.id), ['ws-2']);
assert.deepEqual(filterProjects(all, null), []);

// Queues are separate per scope: a local queue must never be pruned or shown inside a workspace.
assert.notEqual(queueKey(localScope), queueKey(wsScope));
assert.equal(queueKey(localScope), 'batch-queue-v1:local');
assert.equal(queueKey(wsScope), 'batch-queue-v1:ws:ws-a');
assert.equal(LEGACY_QUEUE_KEY, 'batch-queue-v1');

console.log('scope tests: ok');
