// Fast track: a file dropped on the right half of the window is processed unattended —
// transcription (+ filler sounds) → мат muted → AI carving — so the user can walk away and come
// back to review. Also handles the older «walk-away» option (AI carving + texts after transcription).
import { S } from './store';
import type { FastTrack } from './lib/types';
import { llmConfigured } from './llm/client';
import { runCarve, loadOpts } from './ui/AiPanel';
import { runPipelineUI } from './ui/TextsPanel';

let wake: any = null;
async function holdWake() {
  try { if (!wake && (navigator as any).wakeLock) { wake = await (navigator as any).wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { /* not allowed */ }
}
function releaseWake() { try { wake?.release(); } catch { /* */ } wake = null; }
// the lock is dropped when the tab is hidden; take it back when the user returns mid-run
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.project?.fastTrack?.status === 'running') holdWake();
});

/** Called from the drop handler (a user gesture: permission prompts are allowed here). */
export function startFastTrack(file: File, handle: FileSystemFileHandle | null) {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch { /* */ }
  holdWake();
  S.openNewFile(file, handle, { fastTrack: loadOpts().fastStrength });
}

function notify(title: string, body: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const n = new Notification(title, { body, tag: 'carver-fasttrack' });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch { /* */ }
}

async function continueFastTrack(ft: FastTrack) {
  const p = S.project!;
  const save = () => { S.scheduleSave(); S.bump(); };
  holdWake();
  try {
    // 2. мат: mute (not cut) with the remembered word lists
    ft.step = 'mat'; save();
    S.setProfOpts({ mode: 'mute' });
    ft.matFound = S.cleanProfanity();
    // 3. AI carving (auto-applied, reviewable in «ИИ-монтаж»)
    ft.step = 'ai'; save();
    if (!llmConfigured()) ft.aiSkipped = 'ИИ не настроен — откройте настройки (⚙) и выберите модель';
    else {
      try { ft.aiFound = (await runCarve('all', ft.strength, true, { quiet: true, throwOnError: true })) ?? 0; }
      catch (e: any) { ft.aiSkipped = e?.name === 'AbortError' ? 'остановлено' : 'ошибка: ' + (e.message || e); }
    }
    ft.step = 'done'; ft.status = 'done'; ft.finished = Date.now();
    save();
    await S.saveNow();
    if (S.project === p) S.setSideTab(ft.aiFound ? 'ai' : 'silence');
    const mins = Math.max(1, Math.round((ft.finished - ft.started) / 60000));
    notify('Резак: готово', `«${p.name}» — ${mins} мин. ИИ вырезал ${ft.aiFound ?? 0} фрагм., мат: ${ft.matFound ?? 0}. Проверьте правки.`);
  } catch (e: any) {
    S.failFastTrack(e.message || String(e));
  } finally { releaseWake(); }
}

S.afterTranscribe = async () => {
  const ft = S.project?.fastTrack;
  if (ft && ft.status === 'running') return continueFastTrack(ft);
  const o = loadOpts();
  if (!o.walkAway || !llmConfigured()) return;
  if (await runCarve('all', o.strength, true) != null) await runPipelineUI(null);
};
