# Checks a «Сохранить всё» result: MP4 and MP3 have the same length, the MP3 is in sync with the MP4
# audio, and muted words are silent in the MP3 (muted) but audible in the MP4 (not muted).
# Usage: python3 verify_mute.py all.mp4 all.mp3 mutes.json
import json, subprocess, sys
import numpy as np
mp4, mp3, mj = sys.argv[1:4]
m = json.load(open(mj))
def dur(p, sel):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', p], capture_output=True, text=True).stdout.strip() or 0)
def pcm(p):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.int16).astype(float) / 32768
dv, da, d3 = dur(mp4, 'v:0'), dur(mp4, 'a:0'), dur(mp3, 'a:0')
print(f'durations: video {dv:.3f} s, MP4 audio {da:.3f} s, MP3 {d3:.3f} s, edit {m["outDuration"]:.3f} s')
a4, a3 = pcm(mp4), pcm(mp3)
print(f'decoded length: MP4 audio {len(a4)/16000:.3f} s, MP3 {len(a3)/16000:.3f} s (diff {(len(a3)-len(a4))/16:.0f} ms)')
fail = 0
if abs(d3 - dv) > 0.06: print('FAIL: MP3 length differs from video'); fail += 1
# sync: cross-correlate 0.5 s windows away from muted regions
lags = []
for t in np.linspace(3, min(len(a4), len(a3)) / 16000 - 3, 12):
    if any(a - 1 < t < b + 1 for a, b in m['mutes']): continue
    x = a4[int(t*16000):int((t+0.5)*16000)]; y = a3[int((t-0.05)*16000):int((t+0.55)*16000)]
    if np.abs(x).max() < 0.01: continue
    c = np.correlate(y, x, 'valid'); lags.append((np.argmax(c) - 800) / 16)
print('MP3 vs MP4 audio lag (ms):', [round(l, 1) for l in lags])
if not lags or max(abs(l) for l in lags) > 1.0: print('FAIL: MP3 out of sync'); fail += 1
rms = lambda v: 20 * np.log10(np.sqrt((v ** 2).mean()) + 1e-9)
for a, b in m['mutes']:
    s, e = int((a + 0.01) * 16000), int((b - 0.01) * 16000)
    if e - s < 400: continue
    r4, r3 = rms(a4[s:e]), rms(a3[s:e])
    ok = r3 < -60 and r4 > -50
    fail += not ok
    print(f'muted {a:7.2f}–{b:7.2f}: MP4 {r4:6.1f} dBFS (should be speech), MP3 {r3:6.1f} dBFS (should be silent)  {"OK" if ok else "FAIL"}')
print('RESULT:', 'OK' if not fail else f'{fail} problem(s)')
