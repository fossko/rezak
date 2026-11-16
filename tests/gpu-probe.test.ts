import assert from 'node:assert/strict';
import { probeWebGPU } from '../src/lib/gpu-probe.ts';

const adapter = (device: any) => ({ features: { has: (x: string) => x === 'shader-f16' }, requestDevice: async () => device });
const device = () => ({ destroyed: false, destroy() { this.destroyed = true; } });

let calls = 0;
const retry = await probeWebGPU({ gpu: { requestAdapter: async () => ++calls < 2 ? null : adapter(device()) }, timeoutMs: 10, retryDelayMs: 0 });
assert.equal(retry.ok, true);
assert.equal(retry.attempts, 2);
assert.equal(retry.f16, true);

const missing = await probeWebGPU({ gpu: undefined, timeoutMs: 10, retryDelayMs: 0 });
assert.equal(missing.ok, false);

const hanging = await probeWebGPU({ gpu: { requestAdapter: () => new Promise(() => {}) }, attempts: 3, timeoutMs: 5, retryDelayMs: 0 });
assert.equal(hanging.ok, false);
assert.equal(hanging.attempts, 3);

const failed = await probeWebGPU({ gpu: { requestAdapter: async () => ({ requestDevice: async () => { throw new Error('device failed'); } }) }, attempts: 2, timeoutMs: 10, retryDelayMs: 0 });
assert.equal(failed.ok, false);
assert.match(failed.reason!, /device failed/);

let late: ReturnType<typeof device> | undefined;
const timed = await probeWebGPU({ gpu: { requestAdapter: async () => ({ requestDevice: () => new Promise((resolve) => { late = device(); setTimeout(() => resolve(late), 30); }) }) }, attempts: 1, timeoutMs: 5, retryDelayMs: 0 });
assert.equal(timed.ok, false);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(late?.destroyed, true);

console.log('gpu-probe: ok');
