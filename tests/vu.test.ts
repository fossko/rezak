// Unit test of the VU scale and RMS/peak conversion.
import assert from 'node:assert/strict';
import { VU_FLOOR_DB, vuPercent, vuDb } from '../src/lib/vu.ts';

assert.equal(VU_FLOOR_DB, -60);
assert.equal(vuPercent(-60), 0);
assert.equal(vuPercent(-30), 50);
assert.equal(vuPercent(0), 100);
assert.equal(vuPercent(-100), 0, 'below the floor stays empty');
assert.equal(vuPercent(6), 100, 'above 0 dBFS stays full');
const q = vuDb(0.5, 1);
assert.ok(Math.abs(q.rmsDb - 20 * Math.log10(0.5)) < 1e-9);
assert.ok(Math.abs(q.peakDb - 0) < 1e-9);
const z = vuDb(0, 0);
assert.equal(z.rmsDb, VU_FLOOR_DB);
assert.equal(z.peakDb, VU_FLOOR_DB);
console.log('vu: ok');
