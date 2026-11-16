import assert from 'node:assert/strict';
import { machineLabel } from '../src/lib/device.ts';

// Chrome exposes a platform name, not the OS hostname; map it to a readable label.
assert.equal(machineLabel('macOS'), 'macOS');
assert.equal(machineLabel('MacIntel'), 'macOS');
assert.equal(machineLabel('Windows'), 'Windows');
assert.equal(machineLabel('Win32'), 'Windows');
assert.equal(machineLabel('Linux x86_64'), 'Linux');
assert.equal(machineLabel('Chrome OS'), 'ChromeOS');
assert.equal(machineLabel('Android'), 'Android');
assert.equal(machineLabel('iPad'), 'iOS');
assert.equal(machineLabel('Plan9'), 'Plan9');
assert.equal(machineLabel(''), 'этом компьютере');
console.log('device: ok');
