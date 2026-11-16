// Gentle completion jingle, synthesized with Web Audio (no audio files): a soft rising major arpeggio
// with a light echo when everything is done, a descending two-note variant when the run ended with an
// error. Plays through the normal audio output, i.e. at system volume.

export type ChimeKind = 'done' | 'error';

/** Schedules the jingle on any (also offline) audio context. Returns its length in seconds. */
export function scheduleJingle(ctx: BaseAudioContext, dest: AudioNode, t0: number, kind: ChimeKind): number {
  const notes: [number, number][] = kind === 'done'
    ? [[783.99, 0], [1046.5, 0.13], [1318.5, 0.26]]   // G5 C6 E6
    : [[659.26, 0], [523.25, 0.2]];                    // E5 C5
  const master = ctx.createGain(); master.gain.value = 0.22;
  const delay = ctx.createDelay(1); delay.delayTime.value = 0.19;
  const fb = ctx.createGain(); fb.gain.value = 0.22;
  const wet = ctx.createGain(); wet.gain.value = 0.28;
  master.connect(dest); master.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(dest);
  for (const [f, dt] of notes) {
    for (const [mult, amp] of [[1, 1], [2, 0.16], [3, 0.04]] as const) {   // soft bell-like partials
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mult;
      const g = ctx.createGain(), t = t0 + dt;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5 * amp, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0006, t + 0.95);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 1);
    }
  }
  return notes[notes.length - 1][1] + 1.6;
}

let ctx: AudioContext | null = null;
/** Create the audio context during a user gesture so it may play later, even from a background tab. */
export function unlockChime() {
  if (!ctx) { try { ctx = new AudioContext(); } catch { /* no audio */ } }
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
export async function playChime(kind: ChimeKind) {
  unlockChime();
  if (!ctx) return;
  try { await ctx.resume(); } catch { /* */ }
  scheduleJingle(ctx, ctx.destination, ctx.currentTime + 0.05, kind);
}
