// "Everything is done" signal: one chime when the whole queue of work has finished and the app needs
// the user again — not after each step of a chain (transcription → fillers → мат → AI → texts).
import { S, prefs } from './store';
import { playChime, unlockChime, scheduleJingle, type ChimeKind } from './lib/chime';

const cfg = { idleMs: 2500, minBusyMs: 12000 };   // idle this long = queue empty; ignore short operations
const log: { at: number; kind: ChimeKind; busyMs: number }[] = [];
(window as any).__carverChime = { cfg, log, scheduleJingle };   // tests

let busySince = 0, idleTimer = 0, cancelled = false, hadError = false;
const seenToasts = new Set<number>();

const busy = () => S.batchRunning || !!S.task || S.project?.fastTrack?.status === 'running';

function finish() {
  idleTimer = 0;
  if (busy() || !busySince) return;
  const busyMs = performance.now() - cfg.idleMs - busySince;
  const kind: ChimeKind = hadError ? 'error' : 'done';
  busySince = 0;
  if (cancelled || busyMs < cfg.minBusyMs || prefs.sound === false) return;
  log.push({ at: Date.now(), kind, busyMs: Math.round(busyMs) });
  playChime(kind);
}

S.subscribe(() => {
  for (const t of S.toasts) if (!seenToasts.has(t.id)) { seenToasts.add(t.id); if (t.kind === 'err' && (busySince || idleTimer)) hadError = true; }
  if (busy()) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }   // the next step of the chain started
    if (!busySince) { busySince = performance.now(); cancelled = false; hadError = false; }
  } else if (busySince && !idleTimer) {
    idleTimer = window.setTimeout(finish, cfg.idleMs);
  }
});

// a run stopped by the user ends silently (they are at the screen)
const cancelTask = S.cancelTask.bind(S);
S.cancelTask = () => { cancelled = true; cancelTask(); };

// the audio context must be created during a user gesture to be allowed to play later
for (const ev of ['pointerdown', 'keydown', 'drop']) window.addEventListener(ev, unlockChime, { capture: true });
