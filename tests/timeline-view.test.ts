// Unit test for the waveform view window at the end of a recording.
import assert from 'node:assert/strict';
import { followViewStart } from '../src/lib/util.ts';

assert.equal(followViewStart(100, 30, 105), 75, 'window ends exactly at the recording end');
assert.equal(followViewStart(104, 30, 105), 75, 'playhead near the end does not push the window past it');
assert.equal(followViewStart(10, 30, 105), 2.5, 'normal follow keeps 25% before the playhead');
assert.equal(followViewStart(2, 30, 105), 0, 'never before zero');
assert.equal(followViewStart(100, 200, 105), 0, 'a window longer than the recording starts at zero');
assert.equal(followViewStart(1230, 30, 1237), 1207);
console.log('timeline view: ok');
