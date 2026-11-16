// node tests/xml.test.ts (Node with native TS stripping + Python 3 stdlib).
// No DOM, media decoder, XML npm dependency, or application runtime imports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTimelineXml, xmlRate } from '../src/export/xml.ts';
import type { XmlSource } from '../src/export/xml.ts';
import type { Clip } from '../src/lib/composite.ts';

type Element = { tag: string; attrs: Record<string, string>; text: string; children: Element[] };
const source = (overrides: Partial<XmlSource> = {}): XmlSource => ({
  name: 'Запись.mp4', duration: 100, fps: 25, width: 1920, height: 1080,
  hasVideo: true, hasAudio: true, sampleRate: 48000, channels: 2, ...overrides,
});
const mainClip = (a: number, b: number, out = 0): Clip => ({ kind: 'main', a, b, out });
const titleClip = (titleId: string, a: number, b: number): Clip => ({ kind: 'title', titleId, a, b, out: 1234 });
const children = (e: Element, tag: string) => e.children.filter(c => c.tag === tag);
function at(e: Element, path: string): Element {
  for (const tag of path.split('/')) {
    const next = children(e, tag)[0];
    assert.ok(next, `Missing ${path}`);
    e = next;
  }
  return e;
}
const text = (e: Element, path: string) => at(e, path).text;
const num = (e: Element, path: string) => Number(text(e, path));
function all(e: Element, tag: string): Element[] {
  return [...(e.tag === tag ? [e] : []), ...e.children.flatMap(c => all(c, tag))];
}
function parse(xml: string): Element {
  const p = spawnSync('python3', [fileURLToPath(new URL('./verify_xml.py', import.meta.url))], {
    input: xml, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(p.error);
  assert.equal(p.status, 0, p.stderr);
  return at(JSON.parse(p.stdout), 'sequence');
}
function render(clips: Clip[], main = source(), titles = new Map<string, XmlSource>(), name = 'Монтаж') {
  const result = makeTimelineXml(name, clips, main, titles);
  const seq = parse(result.xml);
  assert.equal(num(seq, 'duration'), result.durationFrames);
  assert.equal(num(seq, 'rate/timebase'), result.rate.timebase);
  assert.equal(text(seq, 'rate/ntsc'), result.rate.ntsc ? 'TRUE' : 'FALSE');
  return { ...result, seq };
}
const video = (seq: Element) => children(at(seq, 'media/video/track'), 'clipitem');
const audio = (seq: Element) => children(at(seq, 'media/audio'), 'track').map(t => children(t, 'clipitem'));
const bounds = (items: Element[]) => items.map(c => ['start', 'end', 'in', 'out'].map(k => num(c, k)));
const files = (seq: Element) => all(seq, 'file').filter(f => f.children.length);

test('cuts are conservatively snapped and packed, ignoring stale composite out positions', () => {
  const clips = [mainClip(0.011, 1.019, 90), mainClip(10.021, 12.099, 100), mainClip(20, 20.04, 200)];
  const before = structuredClone(clips);
  const { seq, durationFrames, skippedClips } = render(clips);
  assert.deepEqual(bounds(video(seq)), [[0, 24, 1, 25], [24, 75, 251, 302], [75, 76, 500, 501]]);
  for (const track of audio(seq)) assert.deepEqual(bounds(track), bounds(video(seq)));
  assert.equal(durationFrames, 76);
  assert.equal(skippedClips, 0);
  assert.equal(files(seq).length, 1);
  assert.deepEqual(clips, before);
});

test('trimmed repeated titles use their own rate, one file definition, and cumulative output rounding', () => {
  const title = source({ name: 'Отбивка.mov', fps: 30, duration: 10, width: 1280, height: 720 });
  const titles = new Map([['intro', title]]);
  const clips = [mainClip(0, 1), titleClip('intro', .11, .29), titleClip('intro', .11, .29), mainClip(5, 6)];
  const { seq, durationFrames } = render(clips, source(), titles);
  assert.deepEqual(bounds(video(seq)), [[0, 25, 0, 25], [25, 28, 4, 8], [28, 32, 4, 8], [32, 57, 125, 150]]);
  assert.equal(durationFrames, 57);
  const vs = video(seq);
  assert.equal(text(vs[1], 'rate/timebase'), '30');
  assert.equal(at(vs[1], 'file').attrs.id, at(vs[2], 'file').attrs.id);
  assert.notEqual(at(vs[0], 'file').attrs.id, at(vs[1], 'file').attrs.id);
  assert.equal(files(seq).length, 2);
  assert.equal(num(files(seq).find(f => text(f, 'name') === title.name)!, 'media/video/samplecharacteristics/width'), 1280);
});

for (const base of [24, 30, 60]) {
  for (const fps of [base * 1000 / 1001, Number((base * 1000 / 1001).toFixed(3))]) {
    test(`NTSC ${fps}: exact rational frame grid, source/file/sequence rates agree`, () => {
      const actual = base * 1000 / 1001;
      const { seq, rate, durationFrames } = render([mainClip(10 / actual, 110 / actual)], source({ fps }));
      assert.deepEqual(rate, { timebase: base, ntsc: true, fps: actual });
      assert.deepEqual(bounds(video(seq)), [[0, 100, 10, 110]]);
      assert.equal(durationFrames, 100);
      for (const r of all(seq, 'rate')) {
        assert.equal(num(r, 'timebase'), base);
        assert.equal(text(r, 'ntsc'), 'TRUE');
      }
    });
  }
}

test('mixed NTSC title and integer sequence preserve source frame counts', () => {
  const fps = 30000 / 1001;
  const { seq } = render([mainClip(0, 1), titleClip('ntsc', 30 / fps, 90 / fps), mainClip(3, 4)],
    source(), new Map([['ntsc', source({ fps, name: 'ntsc.mp4' })]]));
  assert.deepEqual(bounds(video(seq)), [[0, 25, 0, 25], [25, 75, 30, 90], [75, 100, 75, 100]]);
  assert.equal(text(video(seq)[1], 'rate/ntsc'), 'TRUE');
});

test('stereo source channel routing and links survive silent and mono title track gaps', () => {
  const titles = new Map([
    ['silent', source({ name: 'silent.mp4', hasAudio: false, channels: 0, sampleRate: 0 })],
    ['mono', source({ name: 'mono.mp4', channels: 1 })],
  ]);
  const { seq } = render([mainClip(0, 1), titleClip('silent', 0, 1), titleClip('mono', 0, 1), mainClip(8, 9)], source(), titles);
  const tracks = audio(seq);
  assert.deepEqual(tracks.map(t => t.length), [3, 2]);
  assert.deepEqual(bounds(tracks[0]).map(b => b.slice(0, 2)), [[0, 25], [50, 75], [75, 100]]);
  assert.deepEqual(bounds(tracks[1]).map(b => b.slice(0, 2)), [[0, 25], [75, 100]]);
  for (let ch = 0; ch < 2; ch++) for (const c of tracks[ch]) assert.equal(num(c, 'sourcetrack/trackindex'), ch + 1);
  assert.equal(children(video(seq)[1], 'link').length, 1);
  assert.equal(children(video(seq)[2], 'link').length, 2);
  assert.equal(children(video(seq)[3], 'link').length, 3);
});

test('six discrete channels remain ungrouped while inserted stereo and mono retain correct routing', () => {
  const { seq } = render([
    mainClip(0, 1), titleClip('stereo', 0, 1), titleClip('mono', 0, 1), mainClip(3, 4),
  ], source({ channels: 6 }), new Map([
    ['stereo', source({ name: 'stereo.mp4', channels: 2 })],
    ['mono', source({ name: 'mono.mp4', channels: 1 })],
  ]));
  assert.equal(num(seq, 'media/audio/numOutputChannels'), 6);
  const tracks = audio(seq);
  assert.deepEqual(tracks.map(t => t.length), [4, 3, 2, 2, 2, 2]);
  for (let channel = 0; channel < 6; channel++) {
    for (const clip of tracks[channel]) assert.equal(num(clip, 'sourcetrack/trackindex'), channel + 1);
    for (const clip of [tracks[channel][0], tracks[channel].at(-1)!]) {
      assert.equal(children(clip, 'link').length, 7);
      assert.equal(all(clip, 'groupindex').length, 0);
    }
  }
  for (const clip of [video(seq)[1], tracks[0][1], tracks[1][1]]) {
    const links = children(clip, 'link');
    assert.equal(links.length, 3);
    assert.deepEqual(links.map(l => children(l, 'groupindex').map(g => g.text)), [[], ['1'], ['1']]);
  }
  assert.equal(all(video(seq)[2], 'groupindex').length, 0);
  assert.equal(all(tracks[0][2], 'groupindex').length, 0);
});

test('audio-only main has no fake video clip; inserted video starts after audio', () => {
  const { seq } = render([mainClip(1, 2), titleClip('title', 0, 1), mainClip(4, 5)],
    source({ name: 'речь.wav', hasVideo: false, width: 0, height: 0 }),
    new Map([['title', source({ hasAudio: false, name: 'title.mp4' })]]));
  assert.deepEqual(bounds(video(seq)), [[25, 50, 0, 25]]);
  assert.deepEqual(bounds(audio(seq)[0]), [[0, 25, 25, 50], [50, 75, 100, 125]]);
  assert.equal(num(seq, 'media/video/format/samplecharacteristics/width'), 1920);
  const f = files(seq).find(f => text(f, 'name') === 'речь.wav')!;
  assert.equal(children(at(f, 'media'), 'video').length, 0);
});

test('video-only sequence omits audio entirely', () => {
  const { seq } = render([mainClip(0, 1)], source({ hasAudio: false, channels: 0 }));
  assert.equal(children(at(seq, 'media'), 'audio').length, 0);
});

test('XML names round-trip Cyrillic, ampersands, quotes; paths percent-encode real basenames once', () => {
  const name = 'Ильяхов & <монтаж> "тест" \'один\'';
  const filename = 'Съёмка & "кадр" \'тест\' #? 100% %20 (!)*.mp4';
  const { seq, xml } = render([mainClip(0, 1)], source({ name: filename }), new Map(), name);
  assert.equal(text(seq, 'name'), name);
  assert.equal(text(video(seq)[0], 'name'), filename);
  const f = files(seq)[0];
  assert.equal(text(f, 'name'), filename);
  const path = text(f, 'pathurl');
  assert.equal(decodeURIComponent(new URL(path).pathname.slice(1)), filename);
  assert.equal(new URL(path).search, '');
  assert.equal(new URL(path).hash, '');
  assert.match(path, /%25/);
  assert.match(path, /%2520/);
  assert.match(path, /%27/);
  assert.match(path, /%22/);
  assert.match(xml, /&amp;/);
  assert.match(xml, /&quot;/);
  assert.match(xml, /&apos;/);
  assert.doesNotMatch(xml, /blob:/);
});

test('forbidden XML control characters are removed from human-readable names', () => {
  const { seq } = render([mainClip(0, 1)], source({ name: 'a\u0000b.mp4' }), new Map(), 'a\u0001b\u000bc');
  assert.equal(text(seq, 'name'), 'abc');
  assert.equal(text(files(seq)[0], 'name'), 'ab.mp4');
});

test('no-full-frame clips are counted and removed without leaving gaps or dangling refs', () => {
  const { seq, skippedClips, durationFrames } = render([
    mainClip(.001, .039), mainClip(1, 2), mainClip(3.001, 3.039), mainClip(4, 5),
  ]);
  assert.equal(skippedClips, 2);
  assert.equal(durationFrames, 50);
  assert.deepEqual(bounds(video(seq)), [[0, 25, 25, 50], [25, 50, 100, 125]]);
});

test('source frames too short for one sequence frame are skipped', () => {
  const { skippedClips, durationFrames } = render([titleClip('fast', 0, 1 / 240), mainClip(0, 1)],
    source({ fps: 24 }), new Map([['fast', source({ fps: 240 })]]));
  assert.equal(skippedClips, 1);
  assert.equal(durationFrames, 24);
});

test('empty or entirely subframe timelines fail rather than emitting invalid XML', () => {
  for (const clips of [[], [mainClip(.001, .039)]]) {
    assert.throws(() => makeTimelineXml('empty', clips, source(), new Map()), /целых кадров/);
  }
});

for (const fps of [0, -1, NaN, Infinity, 241, 29.5]) {
  test(`reject invalid or unsupported rate ${fps}`, () => assert.throws(() => xmlRate(fps)));
}
for (const fps of [24, 25, 30, 50, 60, 120, 240]) {
  test(`integer rate ${fps} stays non-NTSC`, () => assert.deepEqual(xmlRate(fps), { timebase: fps, ntsc: false, fps }));
}
for (const [a, b] of [[-1, 1], [1, 1], [2, 1], [NaN, 1], [0, Infinity], [0, 101]]) {
  test(`reject invalid clip bounds ${a}..${b}`, () => {
    assert.throws(() => makeTimelineXml('bad', [mainClip(a, b)], source(), new Map()), /границы/);
  });
}
for (const patch of [
  { name: '' }, { duration: 0 }, { duration: NaN }, { width: 0 }, { height: 1.5 },
  { channels: 0 }, { channels: 1.5 }, { sampleRate: 0 }, { sampleRate: NaN },
]) {
  test(`reject invalid source metadata ${JSON.stringify(patch)}`, () => {
    assert.throws(() => makeTimelineXml('bad', [mainClip(0, 1)], source(patch), new Map()), /метаданные/);
  });
}

test('missing title source is an actionable failure', () => {
  assert.throws(() => makeTimelineXml('bad', [titleClip('missing', 0, 1)], source(), new Map()), /заставки/);
});

test('audio-only sequence has stereo audio and an empty video track', () => {
  const { seq, durationFrames } = render([mainClip(0, 1), mainClip(3, 4)],
    source({ hasVideo: false, width: 0, height: 0, name: 'voice.wav' }));
  assert.equal(video(seq).length, 0);
  assert.equal(durationFrames, 50);
  assert.deepEqual(audio(seq).map(t => t.length), [2, 2]);
});

test('exact frame boundaries survive floating-point multiplication and duration tolerance clamps', () => {
  const { seq, durationFrames } = render([mainClip(0.28, 0.56), mainClip(.96, 1 + 5e-7)], source({ duration: 1 }));
  assert.deepEqual(bounds(video(seq)), [[0, 7, 7, 14], [7, 8, 24, 25]]);
  assert.equal(durationFrames, 8);
});

test('unused title assets do not create files or invalidate the export', () => {
  const { seq } = render([mainClip(0, 1)], source(), new Map([['unused', source({ fps: NaN })]]));
  assert.equal(files(seq).length, 1);
});

test('source without video or audio is rejected', () => {
  assert.throws(() => makeTimelineXml('bad', [mainClip(0, 1)],
    source({ hasVideo: false, hasAudio: false }), new Map()));
});

test('many irregular cuts remain conservative and packed with deterministic serialization', () => {
  const fps = 60000 / 1001;
  const clips = Array.from({ length: 100 }, (_, i) => mainClip(i * .8 + .013, i * .8 + .673, i * 4));
  const input = source({ fps });
  const first = render(clips, input);
  assert.equal(first.xml, makeTimelineXml('Монтаж', clips, input, new Map()).xml);
  let cursor = 0;
  for (const [i, c] of video(first.seq).entries()) {
    const a = num(c, 'in'), b = num(c, 'out');
    assert.ok(a / fps >= clips[i].a - 1e-9);
    assert.ok(b / fps <= clips[i].b + 1e-9);
    assert.equal(num(c, 'start'), cursor);
    cursor += b - a;
    assert.equal(num(c, 'end'), cursor);
  }
  assert.equal(cursor, first.durationFrames);
});
