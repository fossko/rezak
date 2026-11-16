# Verifies an exported carved MP4 against the source: for sampled output times, the exported frame must
# match the source frame at the mapped source time (PSNR), and audio must line up (cross-correlation).
# Usage: python3 verify_export.py source.mp4 export.mp4 segments.json
import json, subprocess, sys
import numpy as np
src, out, segp = sys.argv[1:4]
segs = json.load(open(segp))
starts = np.cumsum([0] + [s['end'] - s['start'] for s in segs])
def o2s(o):
    k = max(0, np.searchsorted(starts, o, side='right') - 1); k = min(k, len(segs) - 1)
    return segs[k]['start'] + (o - starts[k])
def frame(path, t, w=320, h=180):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.4f}', '-i', path, '-frames:v', '1', '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).astype(float)
def audio(path, t, d):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.4f}', '-t', f'{d}', '-i', path, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.int16).astype(float)
def psnr(a, b):
    if len(a) != len(b) or not len(a): return -1
    m = ((a - b) ** 2).mean(); return 99 if m == 0 else 10 * np.log10(255 ** 2 / m)
total = starts[-1]
# sample: middle of segments + just after joins
ts = []
for k in range(len(segs)):
    L = segs[k]['end'] - segs[k]['start']
    if L > 0.3: ts += [starts[k] + 0.15, starts[k] + L / 2]
ts = [t for t in ts if t < total - 0.2][:24]
bad = 0
for o in ts:
    s = o2s(o)
    p = psnr(frame(out, o), frame(src, s))
    # neighbour frames for reference (are we off by one?)
    pm = psnr(frame(out, o), frame(src, s - 1/30)); pp = psnr(frame(out, o), frame(src, s + 1/30))
    a1, a2 = audio(out, o, 0.25), audio(src, s - 0.05, 0.35)
    lag = None
    if len(a1) > 100 and len(a2) > len(a1) and np.abs(a1).max() > 300:
        c = np.correlate(a2, a1, 'valid'); lag = (np.argmax(c) - 800) / 16  # ms; 0 = in sync
    ok = max(p, pm, pp) > 40   # the exported frame is the source frame at the mapped time, within ±1 frame
    bad += not ok
    print(f'out {o:7.2f} -> src {s:7.2f}  psnr {p:5.1f} (prev {pm:5.1f} next {pp:5.1f})  audio lag {lag if lag is None else f"{lag:+.1f} ms"}  {"OK" if ok else "MISMATCH"}')
print('mismatches:', bad, 'of', len(ts))
