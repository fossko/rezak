import assert from 'node:assert/strict';
import { planRelink } from '../src/lib/relink.ts';

const f = (name, size, lastModified, path = name) => ({ name, size, lastModified, path });
const w = (id, name, size, lastModified) => ({ id, name, size, lastModified });

// Same name and size wins.
let plan = planRelink([w('a', 'lesson1.mp4', 100, 5)], [f('lesson1.mp4', 100, 5), f('other.mp4', 100, 9)]);
assert.deepEqual(plan.matched, [{ id: 'a', path: 'lesson1.mp4', how: 'name' }]);

// Renamed copy: same size and modification time is still recognised.
plan = planRelink([w('a', 'old.mp4', 100, 5)], [f('new-name.mp4', 100, 5)]);
assert.deepEqual(plan.matched, [{ id: 'a', path: 'new-name.mp4', how: 'same-time' }]);

// A different size is never accepted, even with the same name.
plan = planRelink([w('a', 'lesson1.mp4', 100, 5)], [f('lesson1.mp4', 101, 5)]);
assert.deepEqual(plan.missing, ['a']);
assert.deepEqual(plan.matched, []);

// Two equally plausible files → ambiguous, nothing is guessed.
plan = planRelink([w('a', 'lesson1.mp4', 100, 5)], [f('lesson1.mp4', 100, 5, 'a/lesson1.mp4'), f('lesson1.mp4', 100, 5, 'b/lesson1.mp4')]);
assert.deepEqual(plan.ambiguous, ['a']);

// Two projects looking for the same name get different files when both exist.
plan = planRelink(
  [w('a', 'lesson1.mp4', 100, 5), w('b', 'lesson1.mp4', 100, 5)],
  [f('lesson1.mp4', 100, 5, 'a/lesson1.mp4'), f('lesson1.mp4', 100, 5, 'b/lesson1.mp4')],
);
assert.equal(plan.matched.length, 2);
assert.notEqual(plan.matched[0].path, plan.matched[1].path);

// Recursive folder paths are preserved in the report.
plan = planRelink([w('a', 'x.mp4', 7, 1)], [f('x.mp4', 7, 1, 'Съёмка/День 1/x.mp4')]);
assert.equal(plan.matched[0].path, 'Съёмка/День 1/x.mp4');

// Name comparison is case-insensitive (macOS filesystems are too).
plan = planRelink([w('a', 'Lesson.MP4', 100, 5)], [f('lesson.mp4', 100, 5)]);
assert.equal(plan.matched.length, 1);

// Cache hit: nothing matches, everything reported as missing.
plan = planRelink([w('a', 'one.mp4', 1, 1), w('b', 'two.mp4', 2, 2)], [f('three.mp4', 3, 3)]);
assert.deepEqual(plan.missing.sort(), ['a', 'b']);

console.log('relink tests: ok');
