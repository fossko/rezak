// Central app state (outside React). Components subscribe via useStore().
import { useSyncExternalStore } from 'react';
import type { Project, Word, Suggestion, SilenceSettings, CutSettings, ProfanitySettings, FastTrack, TitleAsset, TitleInsert } from './lib/types';
import { DEFAULT_CUT, DEFAULT_SILENCE, DEFAULT_PROFANITY, WS, MU } from './lib/types';
import { findProfanity } from './lib/profanity';
import { projects, idb, requestPersistentStorage } from './lib/db';
import { openMedia, sameFile, type OpenedMedia } from './lib/media';
import { extractPcm16, computeLevels, suggestThreshold, pcmSlice } from './lib/pcm';
import { buildEdl, detectSilences, srcToOut, remapEdges, type Edl, type Silence, type CutRegion, silenceKey } from './lib/edl';
import { buildComposite, type Composite } from './lib/composite';
import { addTitleFile, replaceTitleFile, removeTitleAsset as removeTitleLib, loadTitleLib, type TitleMedia } from './lib/titles';
import { transcribeAll, DEFAULT_MODEL, getSpeechRPC, disposeSpeechRPC, lastAsr, type TProgress, type Checkpoint } from './transcribe/run';
import { detectFillers, FILLER_TEXT } from './transcribe/fillers';
import { measureLoudness, LoudnessMeter, type LoudnessReport } from './lib/loudness';
import { levelerFromPoints, type Leveler } from './lib/leveler';
import { DEFAULT_COMPRESSOR, DEFAULT_CEILING_DB, type CompressorSettings } from './lib/masterchain';
import { measurePhrases, ExactStream, rmsBlocks, BLK, DEFAULT_DUCK, MAX_MAKEUP_DB_COMP_ONLY, type DuckSettings } from './lib/dsp';
import { LiveMaster, type MasterOpt, type MasterState } from './audio/live';
import { Restorer, TILE_S } from './restore/engine';
import { uid, baseName, lastLE } from './lib/util';
import { batchLog } from './lib/batch-log';
import { createWorkspaceApi, localProjectsToDrop, localProjectsToReupload, staleRevision, workspaceTokenFromLocation, type Workspace, type WorkspaceManifest } from './lib/workspace';
import { inScope, type ProjectScope } from './lib/scope';

export interface Task {
  kind: 'open' | 'extract' | 'transcribe' | 'export' | 'llm' | 'pipeline' | 'models' | 'fillers' | 'loudness'; frac: number; text: string; live?: string; cancel?: () => void;
  /** Transcription only: where Whisper actually runs ('webgpu' | 'wasm') and, on the CPU, why (TaskBar ⚠️). */
  asr?: { device: string; why?: string | null };
}
export interface Toast { id: number; text: string; kind: 'ok' | 'err' | 'info' }

export interface Prefs {
  model: string; device: string; followPlayhead: boolean; playbackRate: number; sound: boolean; scrub: boolean; scrubMs: number; selFollow: boolean;
  /** Loudness target for the meter and the leveler, LUFS. */
  targetLufs: number;
  /** Phrase leveling (gain changes inside pauses) before the compressor. Off by default: compressor only. */
  phraseLeveler: boolean;
  /** «Усиление звука»: how hard the AUTOMATIC processing pushes (make-up aim + compressor preset). */
  gainMode: GainMode;
  /** «Подсказки к приложению»: show the grey explanatory texts (`.tip`). Off by default — clean UI for experienced users. */
  hints: boolean;
  /** Bypass all sound processing (restoration, leveler, ducking, compressor/limiter, make-up) globally. */
  audioBypass: boolean;
}
export type GainMode = 'aggressive' | 'medium' | 'soft';
/** «Усиление звука» presets (user spec): where the automatic make-up aims (dB below the target) and the
 *  compressor a new processing starts with. Attack/release/knee stay the defaults. Only AUTOMATIC parts follow a
 *  mode change: a make-up set by hand («авто» off) and a hand-edited compressor are kept. */
export const GAIN_MODES: Record<GainMode, { label: string; below: number; comp: Pick<CompressorSettings, 'thresholdDb' | 'ratio'> }> = {
  aggressive: { label: 'Агрессивно', below: 0, comp: { thresholdDb: -10, ratio: 5 } },
  medium: { label: 'Средне', below: 0.9, comp: { thresholdDb: -5, ratio: 5 } },
  soft: { label: 'Мягко', below: 1.3, comp: { thresholdDb: -4, ratio: 4 } },
};
export const modeCompressor = (m: GainMode): CompressorSettings => ({ ...DEFAULT_COMPRESSOR, ...GAIN_MODES[m].comp });
const PREFS_KEY = 'carver:prefs';
/** Mode of the current processing: the project's own once it has one (a project keeps the mode it was made with),
 *  otherwise the app setting (next automatic processing). */
export const gainMode = (): GainMode => S.master?.mode ?? (S.master ? 'medium' : prefs.gainMode);
/** Where the automatic make-up aims: target − mode offset (Средне −0.9 = lower edge of the ±1 window, with 0.1 to spare). */
export const aimLufs = (m: GainMode = gainMode()) => prefs.targetLufs - GAIN_MODES[m].below;
export const prefs: Prefs = {
  model: DEFAULT_MODEL, device: 'auto', followPlayhead: true, playbackRate: 1, sound: true, scrub: true, scrubMs: 40, selFollow: false,
  targetLufs: -14, phraseLeveler: false, gainMode: 'medium', hints: false, audioBypass: false,
  ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'),
};
/** Hints are hidden by CSS unless <html> has `tips-on` (styles.css: `html:not(.tips-on) .tip`). */
const applyHints = () => document.documentElement.classList.toggle('tips-on', prefs.hints === true);
applyHints();
export function savePrefs(p: Partial<Prefs>) { Object.assign(prefs, p); localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); applyHints(); S.bump(); }

interface Snap { ws: Uint8Array; mu: Uint8Array; kept: number[]; ranges: [number, number][]; sugg: string; edges: string; titles: string }

class Store {
  version = 0;
  private subs = new Set<() => void>();
  project: Project | null = null;
  /** Queue owns the active project while the Home table stays visible. */
  batchRunning = false;
  batchView = false;
  batchCancel: (() => void) | null = null;
  /** True when this tab owns the server lease for the open project; false means read-only. */
  workspaceEditable = true;
  workspaceSessionReady = false;
  workspaceRevision = 0;
  workspaceId: string | null = null;
  /** Human name of the workspace from the server snapshot (used by explicit-save notices). */
  workspaceName: string | null = null;
  /** True when this tab was opened through a workspace magic link (?workspace=…). */
  workspaceMode = workspaceTokenFromLocation() != null;
  /** What the UI may show: local projects, or the projects of this one workspace (null while it is loading). */
  get scope(): ProjectScope | null {
    if (!this.workspaceMode) return { kind: 'local' };
    return this.workspaceId ? { kind: 'workspace', id: this.workspaceId } : null;
  }
  /** A project may only be edited/pushed here if it belongs to this tab's scope. */
  inScope(project: { id: string; workspaceId?: string }) { return inScope(project, this.scope); }
  /** Why the workspace has not loaded yet (offline, expired link); shown instead of an endless spinner. */
  workspaceLoadError: string | null = null;
  setWorkspaceLoadError(message: string | null) { if (this.workspaceLoadError === message) return; this.workspaceLoadError = message; this.bump(); }
  /** Last workspace manifest from the 5 s poll: revisions for projects opened later. */
  private workspaceSnapshot: WorkspaceManifest | null = null;
  /** Server revision of every project we have already applied locally (so the poll can fetch only changes). */
  private workspaceRevisions = new Map<string, number>();
  private workspaceRevisionsFor: string | null = null;
  /** IDs deleted in this workspace: never re-upload, never resurrect from a local copy. */
  private workspaceDeleted = new Set<string>();
  private workspaceApi = createWorkspaceApi((import.meta as any).env?.VITE_WORKSPACE_API || '/api/workspace');
  setWorkspaceEditable(value: boolean) { if (this.workspaceEditable === value) return; this.workspaceEditable = value; this.bump(); }
  async acquireWorkspaceLock(projectId: string) {
    const p = this.project;
    if (!this.workspaceId || !p || p.id !== projectId || p.workspaceId !== this.workspaceId) { this.setWorkspaceEditable(true); return; }
    try { await this.workspaceApi.lock(projectId); this.workspaceSessionReady = true; this.setWorkspaceEditable(true); } catch { this.workspaceSessionReady = false; this.setWorkspaceEditable(false); this.toast('Проект заблокирован другим участником.', 'info'); } }
  releaseWorkspaceLock(projectId: string) { void this.workspaceApi.unlock(projectId).catch(() => {}); this.workspaceSessionReady = false; this.workspaceRevision = 0; this.setWorkspaceEditable(true); }
  heartbeatWorkspace(projectIds: string[]) { void this.workspaceApi.heartbeat(projectIds).catch(() => {}); }
  /** Apply a light poll from the server: fetch project bodies only when their revision changed,
   *  drop local copies deleted elsewhere, re-upload copies the server lost. Source files stay local. */
  async syncWorkspace(workspace: WorkspaceManifest) {
    this.workspaceId = workspace.id;
    this.workspaceName = workspace.name?.trim() || null;
    this.workspaceSnapshot = workspace;
    await this.loadWorkspaceRevisions(workspace.id);
    const remoteIds = new Set(workspace.projects.map(p => p.id));
    const tombstones = new Set<string>((workspace.deleted ?? []).map(d => String(d.id)));
    for (const id of tombstones) this.workspaceDeleted.add(id);
    for (const remote of workspace.projects) {
      if (this.workspaceDeleted.has(remote.id)) continue;
      const known = this.workspaceRevisions.get(remote.id);
      const local = await projects.get(remote.id).catch(() => undefined);
      // Already applied this revision and the local copy is here: nothing to download.
      if (known === remote.revision && local) { if (this.project?.id === remote.id) this.workspaceRevision = remote.revision; continue; }
      try {
        const full = await this.workspaceApi.getProject(remote.id);
        const incoming = full.data as Project;
        if (!incoming || incoming.id !== remote.id) continue;
        incoming.workspaceId = workspace.id;
        await projects.save(incoming);
        this.workspaceRevisions.set(remote.id, remote.revision);
        if (this.project?.id === remote.id) {
          this.workspaceRevision = remote.revision;
          // Someone else's note must not be lost by the next save of the open project.
          if ((this.project.notes ?? '') !== (incoming.notes ?? '')) { this.project.notes = incoming.notes; this.bump(); }
        }
      } catch { /* offline or racing with a save: the next poll retries */ }
    }
    const local = await projects.list().catch(() => [] as Project[]);
    // Deleted for everyone: the server has a tombstone, so the local copy goes too.
    for (const id of localProjectsToDrop(local, workspace.id, remoteIds, tombstones)) {
      const gone = local.find(p => p.id === id)!;
      this.workspaceDeleted.add(id);
      if (this.project?.id === id) { this.workspaceSessionReady = false; this.toast('Проект удалён из рабочего пространства другим участником.', 'info'); this.closeProject(true); }
      await projects.remove(gone.id).catch(() => {});
    }
    // Missing on the server WITHOUT a tombstone: the server lost it (crash, restore, old bug). Keep the local
    // copy and put it back instead of quietly deleting the only remaining copy.
    for (const id of localProjectsToReupload(local, workspace.id, remoteIds, tombstones)) {
      const copy = local.find(p => p.id === id)!;
      this.workspaceDeleted.delete(id);
      await this.publishWorkspaceProject(copy).catch(() => {});
    }
    this.persistWorkspaceRevisions();
    this.bump();
  }

  /** Revisions of the projects already applied locally, kept in IndexedDB so a reload does not re-download them. */
  private async loadWorkspaceRevisions(workspaceId: string) {
    if (this.workspaceRevisionsFor === workspaceId) return;
    const saved = await idb.get<Record<string, number>>('kv', `ws-revisions:${workspaceId}`).catch(() => undefined);
    this.workspaceRevisions = new Map(Object.entries(saved ?? {}).map(([id, rev]) => [id, Number(rev)]));
    this.workspaceRevisionsFor = workspaceId;
  }
  private persistWorkspaceRevisions() {
    const id = this.workspaceId;
    if (!id || this.workspaceRevisionsFor !== id) return;
    void idb.put('kv', `ws-revisions:${id}`, Object.fromEntries(this.workspaceRevisions)).catch(() => {});
  }
  /** Remember a revision we just wrote, so the next poll does not fetch our own change back. */
  private noteWorkspaceRevision(projectId: string, revision: number) {
    this.workspaceRevisions.set(projectId, revision);
    const rec = this.workspaceSnapshot?.projects.find(x => x.id === projectId);
    if (rec) rec.revision = revision;
    this.persistWorkspaceRevisions();
  }
  /** True when this project may be pushed to the server (not deleted for the whole workspace). */
  workspaceAllows(projectId: string) { return !this.workspaceDeleted.has(projectId); }
  /** «Заметки редактора» for a project that may not be open (the batch table edits them in place).
   *  In a workspace only the notes field is patched on the server, so a stale copy cannot overwrite the project. */
  async saveProjectNotes(projectId: string, notes: string) {
    const p = await projects.get(projectId);
    if (!p) return;
    const clean = notes.trim() ? notes : '';
    const stored = p.notes ?? '';
    if (stored === clean && this.workspaceId == null) return;
    p.notes = clean || undefined;
    p.updatedAt = Date.now();
    await projects.save(p);
    if (this.project?.id === projectId) this.project.notes = p.notes;
    if (this.workspaceId && p.workspaceId === this.workspaceId && this.workspaceAllows(projectId)) {
      try {
        const saved = await this.workspaceApi.saveNotes(projectId, clean);
        if (this.project?.id === projectId) this.workspaceRevision = saved.revision;
        this.noteWorkspaceRevision(projectId, saved.revision);
        const rec = this.workspaceSnapshot?.projects.find(x => x.id === projectId);
        if (rec) rec.updatedAt = saved.updatedAt;
      } catch (e: any) { this.toast('Не удалось сохранить заметку: ' + (e?.message || e), 'err'); throw e; }
    }
    this.bump();
  }
  /** Explicit ⌘S on the project table: persist every project in the current scope.
   *  In a workspace this performs a real server write for each local change, not just a notice. */
  async saveAllProjects(): Promise<{ total: number; saved: number; upToDate: number; failed: number }> {
    const result = { total: 0, saved: 0, upToDate: 0, failed: 0 };
    const scope = this.scope;
    if (!scope) return result;
    // The open project (also the batch-active one in table view) may still have in-memory edits.
    if (this.project && inScope(this.project, scope)) {
      try { await this.saveNow(true, false); } catch { /* already reported; save the rest */ }
    }
    const all = (await projects.list()).filter(p => inScope(p, scope));
    result.total = all.length;
    if (!all.length) return result;
    if (scope.kind === 'local') {
      for (const p of all) {
        try { await projects.save(p); result.saved++; } catch { result.failed++; }
      }
      return result;
    }
    const live = await this.workspaceApi.getWorkspace();
    this.workspaceId = live.id;
    this.workspaceName = live.name?.trim() || null;
    const remote = new Map(live.projects.map(p => [p.id, p]));
    for (const p of all) {
      const server = remote.get(p.id);
      if (server && server.updatedAt >= p.updatedAt) { result.upToDate++; continue; }
      p.workspaceId = live.id;
      let revision = server?.revision ?? 0;
      let settled = false;
      for (let attempt = 0; attempt < 2 && !settled; attempt++) {
        try {
          await this.workspaceApi.saveProject(p.id, p, revision);
          result.saved++; settled = true;
        } catch (e: any) {
          if (e?.status === 410) {
            this.workspaceDeleted.add(p.id);
            await projects.remove(p.id).catch(() => {});
            result.failed++; settled = true;
          } else if (e?.status === 409 && attempt === 0) {
            const fresh = staleRevision(e);
            if (fresh == null) { result.failed++; settled = true; } else revision = fresh;
          } else { result.failed++; settled = true; }
        }
      }
    }
    this.bump();
    return result;
  }
  /** Push the open project to the workspace server now (explicit user save). Resolves false if it could not be saved. */
  async forceWorkspaceSave(): Promise<boolean> {
    const p = this.project;
    if (!p || !this.workspaceId || !this.workspaceAllows(p.id)) return false;
    p.workspaceId = this.workspaceId;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const saved = await this.workspaceApi.saveProject(p.id, p, this.workspaceRevision);
        this.workspaceRevision = saved.revision;
        this.noteWorkspaceRevision(p.id, saved.revision);
        this.workspaceSessionReady = true;
        return true;
      } catch (e: any) {
        if (e?.status === 410) {
          this.workspaceDeleted.add(p.id);
          this.toast('Проект удалён из рабочего пространства другим участником.', 'err');
          return false;
        }
        // Someone else saved after us: take their revision and write again — this is an explicit save.
        const revision = e?.status === 409 ? staleRevision(e) : null;
        if (revision == null) { this.toast('Не удалось сохранить проект на сервере: ' + (e?.message || e), 'err'); return false; }
        this.workspaceRevision = revision;
      }
    }
    this.toast('Не удалось сохранить проект на сервере: проект изменён другим участником.', 'err');
    return false;
  }
  async publishWorkspaceProject(project: Project) {
    if (!this.workspaceId || !this.workspaceAllows(project.id)) return;
    project.workspaceId = this.workspaceId;
    let revision = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const saved = await this.workspaceApi.saveProject(project.id, project, revision);
        this.workspaceRevision = saved.revision;
        this.noteWorkspaceRevision(project.id, saved.revision);
        return;
      } catch (e: any) {
        if (e?.status === 410) { this.workspaceDeleted.add(project.id); return; }
        const serverRevision = e?.status === 409 ? staleRevision(e) : null;
        if (serverRevision == null) { this.toast('Не удалось добавить проект в рабочее пространство: ' + e.message, 'err'); return; }
        revision = serverRevision;   // the id already exists on the server: overwrite it deliberately
      }
    }
    this.toast('Не удалось добавить проект в рабочее пространство: конфликт версий.', 'err');
  }
  /** Delete a project for the whole workspace (server) and from this browser. */
  async deleteWorkspaceProject(projectId: string) {
    this.workspaceDeleted.add(projectId);
    if (this.workspaceId) {
      // 404/410 mean it is already gone; any other failure must not silently leave it on the server.
      await this.workspaceApi.deleteProject(projectId).catch((e: any) => { if (e?.status !== 404 && e?.status !== 410) throw e; });
    }
    if (this.project?.id === projectId) this.closeProject(true);
    await projects.remove(projectId);
  }
  media: OpenedMedia | null = null;
  needsFile = false;               // project open but source file not linked yet
  pcm: Int16Array | null = null;
  levels: Float32Array | null = null;
  /** Live loudness processing (leveler + compressor + limiter): settings, the block model of the
   *  processed wave, exact tiles from the DSP worker. Nothing is rendered for the whole recording. */
  live = new LiveMaster();
  /** bumps whenever the processed sound changes (player re-sync, timeline redraw) */
  masterRev = 0;
  /** Leveler of the applied settings (the player's monitoring and the export use it). */
  masterLeveler: Leveler | null = null;
  /** exact-measurement corrections done since the last user change (bias loop bound) */
  private masterFixes = 0;
  silences: Silence[] = [];
  edl: Edl | null = null;
  composite: Composite | null = null;
  titleLib: TitleAsset[] = [];
  titleAssets = new Map<string, TitleAsset>();
  titleSel: { id: string; handle: 'a' | 'b' } | null = null;
  wordState = new Uint8Array(0);
  wordMute = new Uint8Array(0);   // MU per word
  keptSilences = new Set<number>();
  selection: { a: number; b: number } | null = null;   // anchor, focus word indices
  showOriginal = false;
  task: Task | null = null;
  toasts: Toast[] = [];
  editRev = 0;                     // bumps on every edit (for re-render of the text)
  edlRev = 0;                      // bumps whenever the EDL is recomputed
  private undoStack: Snap[] = [];
  private redoStack: Snap[] = [];
  private saveTimer = 0;
  /** Last background-save error toast; repeated autosave failures must not flood the screen. */
  private saveErrorAt = 0;
  private abort: AbortController | null = null;

  /** «Реставрация» (Sidon): model lifecycle + restored tiles around the playhead; full render only on export. */
  restorer = new Restorer();
  /** bumps when the restored sound near the playhead changes (new tile, dry/wet change) — player re-sync */
  restoreRev = 0;
  /** SOURCE time the restoration renders ahead from (playhead; set by the player card) */
  restoreFocus = 0;
  private restoreProject: string | null = null;

  constructor() {
    this.live.onMeasured = (rev, r, g) => this.onMasterMeasured(rev, r, g); this.live.duckSource = this.duckRegions;
    const R = this.restorer;
    R.onChange = () => this.bumpSoon();
    R.canRun = () => !this.task;
    R.plan = () => this.restorePlan();
    R.onTile = (k) => {
      // re-sync the player only if the new tile is about to be heard
      const t = this.restoreFocus;
      if ((k + 1) * TILE_S + 0.2 > t && k * TILE_S - 0.2 < t + 4) { this.restoreRev++; this.bumpSoon(); }
    };
  }
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  bump() { this.version++; this.syncRestorer(); for (const f of this.subs) f(); }

  /** Keep the restorer in step with the project (source PCM, saved amount) and the task state. Cheap. */
  private syncRestorer() {
    const p = this.project, R = this.restorer;
    if ((p?.id ?? null) !== this.restoreProject) { this.restoreProject = p?.id ?? null; R.setAmount((p?.restore ?? 0) / 100); }
    R.setSource(p ? this.pcm : null, p?.media.sampleRate || 48000);
    R.kick();
  }
  /** Tiles to restore ahead of the playhead: along the kept timeline (or the source in «Исходник»), 60 s. */
  private restorePlan(): number[] {
    const p = this.project; if (!p) return [];
    const t = this.restoreFocus, out: number[] = [];
    const segs = !this.showOriginal && this.edl ? this.edl.segments : [{ start: 0, end: p.media.duration }];
    let left = 60;
    for (const s of segs) {
      if (s.end <= t) continue;
      const a = Math.max(s.start, t);
      for (let k = Math.floor(a / TILE_S); k * TILE_S < s.end; k++) if (!out.includes(k)) out.push(k);
      left -= s.end - a;
      if (left <= 0) break;
    }
    const k0 = Math.floor(t / TILE_S);
    if (k0 > 0 && !out.includes(k0 - 1)) out.push(k0 - 1);
    return out;
  }
  /** Реставрация, dry/wet 0…100 % (persisted per project as `project.restore`). */
  setRestore(pct: number) {
    const p = this.project; if (!p) return;
    const v = Math.max(0, Math.min(100, Math.round(pct / 20) * 20));
    if ((p.restore ?? 0) === v) return;
    const was = p.restore ?? 0;
    p.restore = v; this.scheduleSave();
    this.restorer.setAmount(v / 100);
    this.restoreRev++;
    if (!was && v && this.task && !this.restorer.ready)
      this.toast('Реставрация включится, когда закончится текущая операция: тогда скачается и запустится модель. Можно продолжать монтаж.', 'info');
    this.bump();
  }

  private lastToast = { text: '', at: 0 };
  toast(text: string, kind: Toast['kind'] = 'info') {
    if (this.lastToast.text === text && Date.now() - this.lastToast.at < 1500) return;   // ⌘S twice → one card
    this.lastToast = { text, at: Date.now() };
    if (this.project?.batch) batchLog.event(this.project.id, 'Уведомление: ' + kind, text);
    const t = { id: Date.now() + Math.random(), text, kind };
    this.toasts = [...this.toasts, t]; this.bump();
    setTimeout(() => { this.toasts = this.toasts.filter((x) => x !== t); this.bump(); }, kind === 'err' ? 9000 : 4500);
  }
  private taskLogKey = '';
  setTask(t: Task | null) {
    if (this.project?.batch) {
      const key = JSON.stringify([this.project.id, t?.kind, t?.text, t ? Math.round(t.frac * 1000) : null, t?.asr]);
      if (key !== this.taskLogKey) {
        this.taskLogKey = key;
        batchLog.event(this.project.id, t ? `Задача: ${t.kind}` : 'Задача', t?.text || 'Текущая операция завершена / снята', t ? { progressPercent: +(t.frac * 100).toFixed(2), asr: t.asr } : undefined);
      }
    }
    this.task = t; this.bump();
  }

  /** The applied processing (null = original sound). */
  get master(): MasterState | null { return this.live.state; }
  /** What the waveform's level view draws: the processed model when processing is on. */
  get levelsView() { return prefs.audioBypass ? this.levels : this.live.levels ?? this.levels; }

  /** Block analysis + loudness of the ORIGINAL (one pass in the DSP worker, cached per PCM). */
  private async ensureAnalysis() {
    const pcm = this.pcm, lv = this.levels;
    if (!pcm || !lv) throw new Error('нет звука');
    const fresh = !this.live.an;
    if (fresh && !this.task) this.setTask({ kind: 'loudness', frac: 0, text: 'Замер громкости (LUFS)…' });
    this.live.onProgress = () => {
      if (this.task?.kind === 'loudness' && !this.live.an) this.setTask({ kind: 'loudness', frac: this.live.analyzeFrac, text: `Замер громкости (LUFS)… ${Math.round(this.live.analyzeFrac * 100)}%` });
      else if (this.live.measuring) this.bumpSoon();
    };
    try {
      const r = await this.live.analyze(pcm, lv);
      if (this.project?.batch) batchLog.event(this.project.id, 'DSP', 'Анализ исходной громкости завершён', r.report);
      if (!this.audioBase || fresh) this.audioBase = r.report;
      if (!this.master) { this.audio = this.audioBase; }
      return r;
    } finally { if (this.task?.kind === 'loudness') this.setTask(null); }
  }
  private bumpTimer = 0;
  /** Coalesced bump for high-rate progress (re-rendering the editor per worker message is wasteful). */
  private bumpSoon() { if (!this.bumpTimer) this.bumpTimer = window.setTimeout(() => { this.bumpTimer = 0; this.bump(); }, 150); }

  /** Called after every change of the processed sound. */
  private masterChanged() {
    const st = this.live.state;
    this.masterLeveler = st ? levelerFromPoints(st.full) : null;
    this.masterRev++;
    const p = this.project;
    if (p) {
      p.master = st ? { opt: st.opt, comp: st.comp, ceilingDb: st.ceilingDb, phrases: st.phrases, trim: st.trim, makeupDb: st.makeupDb, makeupAuto: st.makeupAuto, curve: st.curve, bias: st.bias, duck: st.duck, mode: st.mode, compManual: st.compManual } : undefined;
      this.scheduleSave();
    }
    this.bump();
  }

  /** The exact measurement of the processed programme arrived (worker). It replaces the model value
   *  under the meter, and when the model missed the target it re-aims once or twice with the bias. */
  private onMasterMeasured(rev: number, r: LoudnessReport, maxGr: number) {
    const st = this.live.state; if (!st || rev !== this.live.rev) return;
    const bias = Number.isFinite(r.integrated) && Number.isFinite(st.modelLufs) ? r.integrated - st.modelLufs : st.bias;
    if (Number.isFinite(r.integrated) && Math.abs(st.opt.targetLufs - r.integrated) > 0.1 && !st.capped && st.makeupAuto !== false && this.masterFixes < 2 && this.live.an) {
      this.masterFixes++;
      this.live.set({ ...st, bias }, true);
      this.masterChanged();
      return;
    }
    st.bias = bias; st.lufs = r.integrated; st.tp = r.truePeakDb; st.exactGrDb = maxGr;
    if (this.project?.master) this.project.master.bias = bias;
    this.audio = r;
    this.bump();
  }

  /** Turn processing on (or change the variant): analysis (cached) → phrases → instant calibration with the
   *  block model. The exact meter value follows from the worker a few seconds later. */
  async applyMaster(opt: MasterOpt, phrases?: Word[], targetOverride?: number) {
    const p = this.project;
    if (!p || !this.pcm) return false;
    const { an } = await this.ensureAnalysis();
    if (this.project !== p) return false;
    const prev = this.live.state;
    const mode: GainMode = prev ? prev.mode ?? 'medium' : prefs.gainMode;
    opt = { ...opt, leveler: prefs.phraseLeveler, targetLufs: targetOverride ?? aimLufs(mode) };
    const src = phrases ?? this.phraseSource();
    const ph = prev && !phrases ? prev.phrases : measurePhrases(src, an);
    if (!ph.length && opt.leveler) return false;
    this.masterFixes = 0;
    this.live.set({
      opt, mode, compManual: prev?.compManual, comp: prev?.comp ?? modeCompressor(mode), ceilingDb: prev?.ceilingDb ?? DEFAULT_CEILING_DB,
      phrases: ph, trim: prev?.trim ?? 0, makeupDb: prev?.makeupAuto === false ? prev.makeupDb : 0, makeupAuto: prev?.makeupAuto, duck: prev?.duck, curve: [], bias: prev?.bias ?? 0,
    }, true);
    this.masterChanged();
    return true;
  }

  private compPending: Partial<CompressorSettings> | null = null;
  /** Live compressor edit (sliders). Coalesced to one model update per frame. */
  setCompressor(c: Partial<CompressorSettings>) {
    if (!this.live.state) return;
    this.compPending = { ...(this.compPending || {}), ...c };
    if (this.compRaf) return;
    this.compRaf = requestAnimationFrame(() => {
      this.compRaf = 0;
      const st = this.live.state, c2 = this.compPending; this.compPending = null;
      if (!st || !c2) return;
      this.masterFixes = 0;
      this.live.set({ ...st, compManual: true, opt: { ...st.opt, leveler: prefs.phraseLeveler, targetLufs: aimLufs() }, comp: { ...st.comp, ...c2 } }, true);
      this.masterChanged();
    });
  }
  private compRaf = 0;

  // ---- «Приглушение тишины»: quiet stretches under the silence threshold that stay in the cut (breaths)
  private duckCache: { key: string; regs: Silence[] } | null = null;
  /** All quiet stretches under the threshold (any length; the long ones are cut anyway, the ducking of
   *  their kept padding is the same breath-level quiet). Cached per threshold. */
  duckRegions = (): Silence[] => {
    const p = this.project, lv = this.levels; if (!p || !lv) return [];
    const key = `${p.id}|${p.silence.thresholdDb}|${lv.length}`;
    if (this.duckCache?.key !== key) this.duckCache = { key, regs: detectSilences(lv, { thresholdDb: p.silence.thresholdDb, minDuration: 0.02 }) };
    return this.duckCache.regs;
  };
  private duckPending: Partial<DuckSettings> | null = null;
  private duckRaf = 0;
  /** Live edit of the silence ducking (sliders), coalesced per frame. */
  setDuck(d: Partial<DuckSettings>) {
    if (!this.live.state) return;
    this.duckPending = { ...(this.duckPending || {}), ...d };
    if (this.duckRaf) return;
    this.duckRaf = requestAnimationFrame(() => { this.duckRaf = 0; const v = this.duckPending; this.duckPending = null; if (v) this.setDuckNow(v); });
  }
  setDuckNow(d: Partial<DuckSettings>) {
    const st = this.live.state; if (!st) return;
    this.masterFixes = 0;
    this.live.set({ ...st, duck: { ...DEFAULT_DUCK, ...(st.duck || {}), ...d } }, true);
    this.masterChanged();
  }
  /** The silence threshold moved: the ducked stretches move with it. */
  private duckThrRaf = 0;
  private refreshDuck() {
    const st = this.live.state;
    if (!st?.duck || !(st.duck.depthDb < -0.01) || this.duckThrRaf) return;
    this.duckThrRaf = requestAnimationFrame(() => { this.duckThrRaf = 0; const s2 = this.live.state; if (s2) { this.live.set(s2, true); this.masterChanged(); } });
  }
  private makeupPending: number | null | undefined = undefined;
  /** Slider «Компенсация»: a number fixes the make-up (coalesced per frame); null = automatic (to the target). */
  setMakeup(db: number | null) {
    if (!this.live.state) return;
    this.makeupPending = db;
    if (this.makeupRaf) return;
    this.makeupRaf = requestAnimationFrame(() => { this.makeupRaf = 0; const v = this.makeupPending; this.makeupPending = undefined; if (v !== undefined) this.setMakeupNow(v); });
  }
  private makeupRaf = 0;
  setMakeupNow(db: number | null) {
    const st = this.live.state; if (!st) return;
    this.masterFixes = 0;
    this.live.set(db == null ? { ...st, makeupAuto: undefined, opt: { ...st.opt, targetLufs: aimLufs() } } : { ...st, makeupAuto: false, makeupDb: Math.max(0, Math.min(MAX_MAKEUP_DB_COMP_ONLY, db)) }, true);
    this.masterChanged();
  }
  /** Synchronous variant for tests. */
  setCompressorNow(c: Partial<CompressorSettings>) {
    const st = this.live.state; if (!st) return;
    this.masterFixes = 0;
    this.live.set({ ...st, compManual: true, opt: { ...st.opt, leveler: prefs.phraseLeveler, targetLufs: aimLufs() }, comp: { ...st.comp, ...c } }, true);
    this.masterChanged();
  }
  /** «Сбросить компрессор»: back to the mode's compressor and automatic make-up (follows the mode again). */
  resetCompressor() {
    const st = this.live.state; if (!st) return;
    const m = st.mode ?? 'medium';
    this.masterFixes = 0;
    this.live.set({ ...st, compManual: undefined, makeupAuto: undefined, comp: modeCompressor(m), opt: { ...st.opt, leveler: prefs.phraseLeveler, targetLufs: aimLufs(m) } }, true);
    this.masterChanged();
  }
  /** ⚙ «Звук» → «Усиление звука». Stored in the app (the next project's automatic processing uses it). In an open
   *  project only the AUTOMATIC parts follow at once: the make-up aim (if «авто») and the compressor (if not
   *  edited by hand). Manual adjustments stay as they are. */
  setGainMode(m: GainMode) {
    const st = this.live.state;
    if (prefs.gainMode !== m) savePrefs({ gainMode: m });
    else this.bump();
    if (!st || (st.mode ?? 'medium') === m) return;
    this.masterFixes = 0;
    this.live.set({ ...st, mode: m, comp: st.compManual ? st.comp : modeCompressor(m), opt: { ...st.opt, leveler: prefs.phraseLeveler, targetLufs: aimLufs(m) } }, true);
    this.masterChanged();
  }

  /** Phrases for the pre-transcription pass: speech runs between the detected silences. The leveler only
   *  needs start/end, so the sound can be matched before a single word is known. */
  private speechWords(): Word[] {
    const p = this.project; if (!p) return [];
    const dur = p.media.duration, out: Word[] = [];
    // The leveler splits phrases at pauses >= 0.35 s, so re-detect silences at that granularity instead of
    // using the (coarser) cut-oriented list — otherwise a 30 s stretch of speech becomes a single phrase.
    const levels = this.levels;
    const sils = levels ? detectSilences(levels, { thresholdDb: p.silence.thresholdDb, minDuration: 0.35 }) : [];
    let t = 0;
    for (const s of [...sils].sort((a, b) => a.start - b.start)) {
      if (s.start - t > 0.15) out.push({ start: t, end: s.start, text: '·' });
      t = Math.max(t, s.end);
    }
    if (dur - t > 0.15) out.push({ start: t, end: dur, text: '·' });
    return out;
  }

  /** Measure, pick the variant by the delta to the target and process — no questions asked. Runs right
   *  after extraction (before transcription); with the block model it costs one worker pass. */
  async autoMaster(target = aimLufs()): Promise<boolean> {
    const p = this.project;
    if (!p || !this.pcm || this.master || prefs.audioBypass) return false;
    const t0 = performance.now();
    await this.ensureAnalysis();
    const lufs = this.audioBase?.integrated ?? NaN;
    if (!Number.isFinite(lufs)) return false;
    const need = target - lufs;
    if (need < 1) return false;                        // already at or above the target
    const maxGainDb = !prefs.phraseLeveler ? 15 : need <= 8 ? 8 : need <= 11 ? 11 : 15;   // smallest preset that can cover the delta
    const phrases = this.phraseSource();
    const ok = await this.applyMaster({ kind: 'leveler', maxGainDb, targetLufs: target }, phrases, target);
    console.log(`[carver] auto master in ${Math.round(performance.now() - t0)} ms (model ${this.live.lastModelMs.toFixed(0)} ms)`);
    return ok;
  }

  /** Restore the processing saved in the project (no recalibration: the stored curve IS the sound). */
  private async restoreMaster() {
    const p = this.project, saved = p?.master;
    if (!p || !saved || !this.pcm || this.live.state) return;
    await this.ensureAnalysis();
    if (this.project !== p) return;
    this.live.set(saved, false);
    this.masterChanged();
    // saved with the other phrase-leveler setting (⚙ «Звук»): re-solve with the current one
    if ((saved.opt.leveler ?? true) !== prefs.phraseLeveler) await this.applyMaster(saved.opt);
  }

  /** Phrases for the leveler: the transcript once it is complete; while transcription runs the words cover only
   *  the start of the file, so use speech runs between pauses instead. */
  phraseSource() {
    const p = this.project!;
    return p.words.length && this.task?.kind !== 'transcribe' ? p.words : this.speechWords();
  }

  /** ⚙ «Звук» → «Выравнивание по фразам». Re-solves the applied processing at once (block model, instant). */
  async setPhraseLeveler(on: boolean) {
    savePrefs({ phraseLeveler: on });
    const st = this.master;
    if (st) await this.applyMaster(st.opt);
  }

  /** Global bypass: the preview, timeline and exports use the original sound; per-project mastering is kept
   *  for when the user turns it back on. */
  setAudioBypass(on: boolean) {
    if (prefs.audioBypass === on) return;
    savePrefs({ audioBypass: on });
    this.masterRev++;
    // Turning the bypass off means "process again". A project that was created while bypassed has no
    // stored master yet, so use the same automatic processing a fresh project normally gets.
    if (!on && !this.master) void this.autoMaster();
    this.bump();
  }

  /** Back to the original sound. */
  revertMaster() {
    if (!this.master) return;
    this.live.clear();
    this.audio = this.audioBase;
    this.masterChanged();
  }

  /** Measure again (original, or the processed programme when processing is on). */
  async remeasureAudio() {
    if (this.master) { const st = this.master; this.live.set(st, false); this.masterChanged(); return; }
    this.audio = null; this.bump(); await this.analyzeAudio();
  }

  /** Loudness of the current project (original; the processed value arrives via onMasterMeasured). */
  async analyzeAudio() {
    if (!this.project || !this.pcm || this.audioBusy) return;
    this.audioBusy = true;
    try { await this.ensureAnalysis(); }
    catch (e: any) { if (e?.name !== 'AbortError') this.toast('Не удалось измерить громкость: ' + (e.message || e), 'err'); }
    finally { this.audioBusy = false; this.bump(); }
  }

  // ---------------------------------------------------------------- derived
  recompute() {
    this.edlRev++;
    const p = this.project;
    if (!p || !this.levels) { this.edl = null; return; }
    this.silences = detectSilences(this.levels, p.silence);
    this.edl = buildEdl({
      duration: p.media.duration, words: p.words, wordState: this.wordState, silences: this.silences,
      silence: p.silence, keptSilences: this.keptSilences, rangeCuts: p.rangeCuts, cut: p.cut, edges: p.edges,
    });
    this.composite = buildComposite(this.edl, p.titles, this.titleAssets);
  }
  /** Call after any edit: recompute, persist (debounced), re-render. */
  changed(edit = true) {
    if (edit) this.editRev++;
    this.recompute();
    this.scheduleSave();
    this.bump();
  }
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = 0; this.saveNow(); }, 300);
  }
  /** Persist the open project locally. `syncWorkspace = false` leaves the server push to the caller
   *  (the explicit ⌘S path does its own push with a conflict retry). */
  async saveNow(strict = false, syncWorkspace = true) {
    const p = this.project; if (!p) return;
    p.wordState = Array.from(this.wordState);
    p.wordMute = Array.from(this.wordMute);
    p.keptSilences = [...this.keptSilences];
    p.updatedAt = Date.now();
    if (this.composite) {
      p.outputDuration = this.composite.duration;
      if (p.batch) p.batch.outputDuration = this.composite.duration;
    }
    try {
      await projects.save(p);
      // The collaboration service receives project JSON only; media/PCM/handles stay local.
      if (syncWorkspace && this.workspaceSessionReady && this.workspaceId && p.workspaceId === this.workspaceId && this.workspaceAllows(p.id)) {
        p.workspaceId = this.workspaceId || undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const synced = await this.workspaceApi.saveProject(p.id, p, this.workspaceRevision);
            this.workspaceRevision = synced.revision;
            this.noteWorkspaceRevision(p.id, synced.revision);
            break;
          } catch (e: any) {
            // Deleted by another participant while this tab kept editing: honour the deletion locally.
            if (e?.status === 410) {
              this.workspaceDeleted.add(p.id);
              this.workspaceSessionReady = false; // stop re-pushing while the project is being torn down
              this.toast('Проект удалён из рабочего пространства другим участником.', 'info');
              await projects.remove(p.id).catch(() => {});
              if (this.project?.id === p.id) this.closeProject(true);
              break;
            }
            // The tab opened the project before learning its revision: take the server's and write once more.
            const revision = e?.status === 409 ? staleRevision(e) : null;
            if (revision != null) { this.workspaceRevision = revision; continue; }
            // A server hiccup (busy disk, restart) deserves one more try; anything else is reported.
            if (e?.status >= 500 && attempt < 2) { await new Promise(r => setTimeout(r, 400)); continue; }
            throw e;
          }
        }
      }
    } catch (e: any) {
      const now = Date.now();
      if (strict || now - this.saveErrorAt >= 10_000) {
        this.saveErrorAt = now;
        this.toast('Не удалось сохранить проект: ' + (e?.message || e), 'err');
      }
      if (strict) throw e;
    }
  }

  // ---------------------------------------------------------------- undo
  private snap(): Snap {
    const p = this.project!;
    return { ws: this.wordState.slice(), mu: this.wordMute.slice(), kept: [...this.keptSilences], ranges: p.rangeCuts.map((r) => [r[0], r[1]]), sugg: JSON.stringify(p.suggestions.map((s) => s.status)), edges: JSON.stringify(p.edges || {}), titles: JSON.stringify(p.titles || []) };
  }
  private restore(s: Snap) {
    const p = this.project!;
    this.wordState = s.ws.slice(); this.wordMute = s.mu.slice(); this.keptSilences = new Set(s.kept); p.rangeCuts = s.ranges;
    p.edges = JSON.parse(s.edges || '{}');
    p.titles = JSON.parse(s.titles || '[]');
    const st = JSON.parse(s.sugg) as Suggestion['status'][];
    p.suggestions.forEach((x, i) => { if (st[i]) x.status = st[i]; });
  }
  checkpoint() { if (!this.project) return; this.undoStack.push(this.snap()); if (this.undoStack.length > 300) this.undoStack.shift(); this.redoStack = []; }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push(this.snap()); this.restore(s); this.changed(); }
  redo() { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push(this.snap()); this.restore(s); this.changed(); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ---------------------------------------------------------------- edits
  selRange(): [number, number] | null {
    if (!this.selection) return null;
    const { a, b } = this.selection;
    return [Math.min(a, b), Math.max(a, b)];
  }
  setSelection(sel: { a: number; b: number } | null) { this.selection = sel; this.editRev++; this.bump(); }
  /** Remove the range, or restore it if everything in it is already removed. */
  toggleRange(i0: number, i1: number, why: number = WS.Manual) {
    if (!this.project || !this.workspaceEditable) { if (!this.workspaceEditable) this.toast('Проект заблокирован другим участником.', 'info'); return; }
    let all = true;
    for (let i = i0; i <= i1; i++) if (!this.wordState[i]) { all = false; break; }
    this.checkpoint();
    for (let i = i0; i <= i1; i++) this.wordState[i] = all ? WS.Kept : (this.wordState[i] || why);
    this.changed();
  }
  setRange(i0: number, i1: number, v: number) {
    for (let i = i0; i <= i1; i++) this.wordState[i] = v;
  }
  /** Toggle the cut of the pause after word i. */
  toggleGap(i: number) {
    const p = this.project, edl = this.edl; if (!p || !edl || !this.workspaceEditable) { if (!this.workspaceEditable) this.toast('Проект заблокирован другим участником.', 'info'); return; }
    const w = p.words[i], n = p.words[i + 1]; if (!w || !n) return;
    const a = w.end, b = n.start;
    const removed = edl.removed.some(([x, y]) => x < b - 0.05 && y > a + 0.05);
    this.checkpoint();
    if (removed) {
      for (const s of this.silences) if (s.start < b && s.end > a) this.keptSilences.add(silenceKey(s));
      p.rangeCuts = p.rangeCuts.filter(([x, y]) => !(x < b && y > a));
    } else {
      const pad = Math.min(p.silence.padBefore, (b - a) / 3), pad2 = Math.min(p.silence.padAfter, (b - a) / 3);
      p.rangeCuts.push([a + pad, b - pad2]);
      for (const s of this.silences) if (s.start < b && s.end > a) this.keptSilences.delete(silenceKey(s));
    }
    this.changed();
  }
  setSilence(s: Partial<SilenceSettings>) { if (!this.project) return; Object.assign(this.project.silence, s); this.changed(false); if (s.thresholdDb != null) this.refreshDuck(); }
  setCut(s: Partial<CutSettings>) { if (!this.project) return; Object.assign(this.project.cut, s); this.changed(false); }
  resetEdits() { if (!this.project) return; this.checkpoint(); this.wordState.fill(0); this.wordMute.fill(0); this.keptSilences.clear(); this.project.rangeCuts = []; this.project.edges = {}; this.project.titles = []; this.cutSel = null; this.titleSel = null; for (const s of this.project.suggestions) if (s.status === 'accepted') s.status = 'pending'; this.changed(); }

  // ---------------------------------------------------------------- projects
  async openNewFile(file: File, handle?: FileSystemFileHandle | null, opts: { fastTrack?: FastTrack['strength'] } = {}) {
    if (this.batchRunning) { this.toast('Сначала остановите пакетную обработку.', 'info'); return; }
    // A project created here must land in the right scope: never silently fall back to a local project.
    if (this.workspaceMode && !this.workspaceId) { this.toast('Рабочее пространство ещё загружается — попробуйте через пару секунд.', 'info'); return; }
    this.batchView = false;
    requestPersistentStorage();
    this.closeProject();
    this.setTask({ kind: 'open', frac: 0, text: 'Чтение файла…' });
    try {
      const media = await openMedia(file);
      const p: Project = {
        id: uid(), workspaceId: this.workspaceId || undefined, name: baseName(file.name), createdAt: Date.now(), updatedAt: Date.now(), media: media.meta,
        words: [], wordState: [], silence: { ...DEFAULT_SILENCE }, cut: { ...DEFAULT_CUT }, keptSilences: [], rangeCuts: [],
        suggestions: [], pipeline: [], version: 1,
      };
      if (opts.fastTrack) p.fastTrack = { status: 'running', step: 'transcribe', strength: opts.fastTrack, started: Date.now() };
      this.project = p; this.media = media; this.needsFile = false; this.sideTab = 'silence';
      await projects.save(p);
      if (this.workspaceId) await this.publishWorkspaceProject(p);
      if (handle) await idb.put('handles', p.id, handle).catch(() => {});
      this.bump();
      await this.prepareAudio(true);
      this.transcribe();
    } catch (e: any) {
      this.setTask(null);
      if (e?.name !== 'AbortError') this.toast(e.message || String(e), 'err');
      if (this.project?.fastTrack?.status === 'running') this.failFastTrack(e.message || String(e));
    }
  }
  failFastTrack(msg: string) {
    const ft = this.project?.fastTrack; if (!ft) return;
    ft.status = 'error'; ft.error = msg; ft.finished = Date.now();
    this.scheduleSave(); this.bump();
  }

  async openProject(id: string, options: { batch?: boolean } = {}) {
    if (this.batchRunning && !options.batch) { this.toast('Сначала остановите пакетную обработку.', 'info'); return; }
    this.closeProject(!!options.batch);
    const p = await projects.get(id);
    if (!p) { this.toast('Проект не найден', 'err'); return; }
    this.project = p;
    this.workspaceRevision = this.workspaceSnapshot?.projects.find((x) => x.id === p.id)?.revision ?? 0;
    this.wordState = Uint8Array.from(p.wordState.length === p.words.length ? p.wordState : p.words.map(() => 0));
    this.wordMute = Uint8Array.from(p.wordMute && p.wordMute.length === p.words.length ? p.wordMute : p.words.map(() => 0));
    this.keptSilences = new Set(p.keptSilences);
    this.needsFile = true;
    this.sideTab = 'silence';
    // a fast track interrupted after transcription (tab closed mid-run) can't resume by itself
    if (p.fastTrack?.status === 'running' && p.fastTrack.step !== 'transcribe') {
      p.fastTrack.status = 'error'; p.fastTrack.finished = Date.now();
      p.fastTrack.error = 'Прервано: вкладку закрыли во время обработки. Запустите «Почистить мат» и ИИ-монтаж вручную.';
    }
    const pcm = await idb.get<Blob>('blobs', `${id}:pcm`);
    if (pcm) { this.pcm = new Int16Array(await pcm.arrayBuffer()); this.levels = computeLevels(this.pcm); }
    this.changed(false);
    if (options.batch) return; // queue explicitly owns preparation and transcription ordering
    if (this.pcm && p.master) void this.restoreMaster().catch((e) => console.warn('master not restored', e));
    // try the remembered file handle (permission may need a click)
    const h = await idb.get<FileSystemFileHandle>('handles', id).catch(() => undefined);
    if (h) {
      try {
        const perm = await (h as any).queryPermission?.({ mode: 'read' });
        if (perm === 'granted') await this.linkFile(await h.getFile());
      } catch { /* needs user gesture */ }
    }
  }
  /** Re-link through the remembered handle (must be called from a click). */
  async relinkWithHandle(): Promise<boolean> {
    const p = this.project; if (!p) return false;
    const h = await idb.get<FileSystemFileHandle>('handles', p.id).catch(() => undefined);
    if (!h) return false;
    try {
      const perm = await (h as any).requestPermission?.({ mode: 'read' });
      if (perm !== 'granted') return false;
      await this.linkFile(await h.getFile());
      return true;
    } catch { return false; }
  }
  async linkFile(file: File, handle?: FileSystemFileHandle | null) {
    const p = this.project; if (!p) return;
    if (!sameFile(file, p.media)) {
      if (!confirm(`Этот файл отличается от исходного («${p.media.name}», ${(p.media.size / 1e9).toFixed(2)} ГБ). Всё равно использовать?`)) return;
    }
    this.setTask({ kind: 'open', frac: 0, text: 'Чтение файла…' });
    try {
      this.media = await openMedia(file);
      this.needsFile = false;
      if (handle) await idb.put('handles', p.id, handle).catch(() => {});
      if (!this.pcm) await this.prepareAudio(false); else this.setTask(null);
      if (!p.words.length || await idb.get('kv', `ckpt:${p.id}`)) this.transcribe();
      this.bump();
    } catch (e: any) { this.setTask(null); this.toast(e.message || String(e), 'err'); }
  }
  closeProject(force = false) {
    if (this.batchRunning && !force) { this.batchView = true; this.bump(); return; }
    clearTimeout(this.saveTimer); this.saveTimer = 0;
    this.abort?.abort(); this.abort = null;
    if (this.project) this.saveNow();
    this.media?.input.dispose();
    this.project = null; this.media = null; this.pcm = null; this.levels = null; this.edl = null; this.composite = null; this.silences = [];
    this.live.reset(); this.masterLeveler = null; this.masterRev++; this.audio = null; this.audioBase = null;
    this.wordState = new Uint8Array(0); this.wordMute = new Uint8Array(0); this.keptSilences = new Set(); this.selection = null;
    this.undoStack = []; this.redoStack = []; this.task = null; this.needsFile = false;
    this.bump();
  }

  /** Queue entry point: prepare one already-created project without launching another stage. */
  async prepareBatchFile(file: File, targetLufs: number) {
    const p = this.project;
    if (!p) throw new Error('Проект не открыт.');
    if (!sameFile(file, p.media)) throw new Error('Выбран другой исходный файл.');
    this.media = await openMedia(file);
    this.needsFile = false;
    if (!this.pcm) await this.prepareAudio(true, targetLufs, true);
    else {
      this.recompute();
      if (p.master) await this.restoreMaster();
      else await this.autoMaster(targetLufs);
      this.changed(false);
    }
    await this.saveNow(true);
  }

  private async prepareAudio(autoThreshold: boolean, targetLufs?: number, strict = false) {
    const p = this.project!, m = this.media!;
    const ac = new AbortController(); this.abort = ac;
    this.setTask({ kind: 'extract', frac: 0, text: 'Извлечение звука…', cancel: () => ac.abort() });
    const t0 = performance.now();
    const pcm = await extractPcm16(m.audio, m.meta.duration, (f) => this.setTask({ kind: 'extract', frac: f, text: `Извлечение звука… ${Math.round(f * 100)}%`, cancel: () => ac.abort() }), ac.signal);
    console.log(`[carver] audio extracted in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    this.pcm = pcm; this.levels = computeLevels(pcm);
    if (autoThreshold) p.silence.thresholdDb = suggestThreshold(this.levels);
    if (p.batch) batchLog.event(p.id, 'Аудио', 'PCM извлечён; рассчитаны уровни и порог тишины', { samples: pcm.length, sampleRate: 16000, channels: 1, bytes: pcm.byteLength, elapsedMs: Math.round(performance.now() - t0), silence: p.silence });
    await idb.put('blobs', `${p.id}:pcm`, new Blob([pcm.buffer as ArrayBuffer])).catch((e) => { console.warn('pcm not cached', e); if (strict) throw e; });
    this.setTask(null);
    this.changed(false);
    // Loudness is matched BEFORE the transcript exists: the measurement and the render disappear into the
    // wait the user already has for transcription, and the original PCM stays available for «Вернуть исходный».
    if (this.project!.master) await this.restoreMaster().catch((e) => console.warn('master not restored', e));
    else if (!this.project!.words.length) await this.autoMaster(targetLufs);
    this.changed(false);
  }

  async transcribe(options: { batch?: boolean; model?: string; device?: string } = {}) {
    const p = this.project; if (!p || !this.pcm) return;
    if (this.task && this.task.kind === 'transcribe') return;
    const ac = new AbortController(); this.abort = ac;
    const pcm = this.pcm, id = p.id;
    this.setTask({ kind: 'transcribe', frac: 0, text: 'Подготовка…', cancel: () => ac.abort() });
    try {
      const model = options.model ?? prefs.model;
      if (options.batch && p.batch) delete p.batch.gpuWarning;
      let loggedWords = 0;
      const words = await transcribeAll(pcm, { model, device: options.device ?? prefs.device, language: 'ru' }, {
        signal: ac.signal,
        log: p.batch ? (...args: unknown[]) => batchLog.event(id, 'ASR: внутреннее событие', String(args[0] ?? ''), args.slice(1)) : undefined,
        onProgress: (pr: TProgress) => {
          if (options.batch && p.batch && pr.stage !== 'load' && lastAsr?.device === 'wasm') {
            p.batch.gpuWarning = `GPU не удалось использовать после повторных попыток: ${lastAsr.why || 'ошибка WebGPU'}. Расшифровка идёт на процессоре.`;
          }
          this.setTask({ kind: 'transcribe', frac: pr.frac, text: pr.text, live: pr.live, cancel: () => ac.abort(),
            asr: pr.stage !== 'load' && lastAsr ? { device: lastAsr.device, why: lastAsr.why } : undefined });
        },
        onPartial: (ws: Word[]) => {
          if (p.batch) batchLog.event(id, 'Расшифровка: промежуточный результат', `Всего ${ws.length} слов; новые слова с точными границами`, ws.slice(loggedWords));
          loggedWords = ws.length;
          if (this.project?.id === id) this.setWords(ws, true);
        },
        loadCheckpoint: async () => {
          const checkpoint = await idb.get<Checkpoint>('kv', `ckpt:${id}`);
          if (p.batch) batchLog.event(id, 'Checkpoint', checkpoint ? 'Найдено сохранённое состояние ASR' : 'Сохранённого состояния нет', checkpoint ? { version: checkpoint.v, seconds: checkpoint.t, words: checkpoint.words.length } : undefined);
          return checkpoint;
        },
        saveCheckpoint: async (c) => {
          await idb.put('kv', `ckpt:${id}`, c);
          if (p.batch) batchLog.event(id, 'Checkpoint', 'Промежуточная расшифровка сохранена', { seconds: c.t, words: c.words.length, segments: c.segs.length });
        },
      });
      if (this.project?.id !== id) return;
      this.setWords(words, false);
      p.transcriptModel = model;
      p.transcription = { words: structuredClone(words), model, at: Date.now(), device: lastAsr?.device };
      localStorage.setItem('carver:modelsReady:' + model, '1');
      if (options.batch && p.batch) {
        p.batch.gpuWarning = lastAsr?.device === 'wasm' ? `GPU недоступна после повторных попыток: ${lastAsr.why || 'не удалось запустить WebGPU'}. Расшифровка выполнена на процессоре.` : undefined;
      }
      await idb.del('kv', `ckpt:${id}`);
      this.setTask(null);
      this.toast(`Расшифровка готова: ${words.filter((w) => !w.kind).length} слов`, 'ok');
      await this.saveNow(!!options.batch);
      if (!options.batch) {
        await this.findFillers();
        this.afterTranscribe?.();
      }
    } catch (e: any) {
      this.setTask(null);
      if (options.batch) throw e;
      if (this.restartAsr) { this.restartAsr = false; if (this.project?.id === id) void this.transcribe(); return; }
      if (e?.name === 'AbortError' || /cancelled/.test(e?.message)) this.toast('Расшифровка остановлена. Её можно продолжить с того же места.', 'info');
      else { this.toast('Ошибка расшифровки: ' + (e.message || e), 'err'); if (this.project?.id === id) this.failFastTrack('Ошибка расшифровки: ' + (e.message || e)); }
    }
  }
  /** Replace the transcript (keeps removal state of words that still exist at the same index). */
  setWords(ws: Word[], partial: boolean) {
    const p = this.project!;
    const old = this.wordState;
    p.words = ws.slice();
    const st = new Uint8Array(ws.length); st.set(old.subarray(0, Math.min(old.length, ws.length)));
    this.wordState = st;
    const mu = new Uint8Array(ws.length); mu.set(this.wordMute.subarray(0, Math.min(this.wordMute.length, ws.length)));
    this.wordMute = mu;
    if (!partial) this.undoStack = [];
    this.changed();
  }
  cancelTask = () => { if (this.batchRunning && this.batchCancel) this.batchCancel(); else this.task?.cancel?.(); };
  private restartAsr = false;
  /** «Изменить на WebGPU» (TaskBar ⚠️): switch the setting to the GPU and, if a transcription is running on the CPU,
   *  stop it now (the worker is terminated, not drained) and restart — from the last checkpoint, if there is one. */
  switchToWebGPU() {
    savePrefs({ device: 'webgpu' });
    const running = this.task?.kind === 'transcribe';
    if (running) this.restartAsr = true;
    this.task?.kind === 'transcribe' && this.task.cancel?.();
    disposeSpeechRPC();
    if (!running) { this.toast('Расшифровка будет идти на видеокарте (WebGPU).', 'info'); return; }
    // Say what really happens: a checkpoint is written only after a whole 5-min speech window.
    const id = this.project?.id;
    void (id ? idb.get<Checkpoint>('kv', `ckpt:${id}`) : Promise.resolve(undefined)).then((c) => {
      this.toast(c
        ? 'Переключаю расшифровку на видеокарту (WebGPU) — продолжу с того же места.'
        : 'Переключаю расшифровку на видеокарту (WebGPU) — начну заново: до первого сохранения ещё не дошло.', 'info');
    }).catch(() => { this.toast('Переключаю расшифровку на видеокарту (WebGPU).', 'info'); });
  }

  // ---------------------------------------------------------------- filler sounds («эээ», «ммм»)
  fillerOpts() {
    const p = this.project!;
    return (p.fillers ||= { sensitivity: 'normal', autoCut: true });
  }
  /** Detect filler sounds and merge them into the transcript (replacing earlier detections). */
  async findFillers(options: { batch?: boolean; device?: string } = {}) {
    const p = this.project, pcm = this.pcm, levels = this.levels;
    if (!p || !pcm || !levels) { if (options.batch) throw new Error('Нет подготовленного аудио.'); return; }
    if (!p.words.length) { if (options.batch) { this.fillerOpts().scanned = true; await this.saveNow(true); } return; }
    const opts = this.fillerOpts(), id = p.id;
    const ac = new AbortController();
    this.setTask({ kind: 'fillers', frac: 0, text: 'Поиск звуков-паразитов…', cancel: () => ac.abort() });
    try {
      let rpc = null;
      try { rpc = getSpeechRPC(); await rpc.call('ctcLoad', { device: options.device ?? prefs.device }); } catch (e) { console.warn('wav2vec2 unavailable for filler check', e); if (p.batch) batchLog.event(p.id, 'Звуки-паразиты: предупреждение', 'wav2vec2 недоступен; используется акустическая проверка', String(e)); rpc = null; }
      const sorted = Float32Array.from(levels).sort();
      const floorDb = sorted[Math.floor(sorted.length * 0.05)];
      const found = await detectFillers(pcm, p.words, rpc, {
        sensitivity: opts.sensitivity, floorDb, signal: ac.signal,
        onProgress: (f) => this.setTask({ kind: 'fillers', frac: f, text: `Поиск звуков-паразитов… ${Math.round(f * 100)}%`, cancel: () => ac.abort() }),
      });
      if (this.project?.id !== id) return;
      if (p.batch) batchLog.event(p.id, 'Звуки-паразиты', `Найдено ${found.length}; автоматическое удаление: ${opts.autoCut}`, found);
      this.mergeFillers(found, opts.autoCut);
      opts.scanned = true;
      this.setTask(null);
      const n = p.words.filter((w) => w.kind === 'filler').length;
      this.toast(n ? `Звуков-паразитов найдено: ${n}${opts.autoCut ? ', вырезаны' : ''}` : 'Звуков-паразитов не найдено', 'ok');
      await this.saveNow(!!options.batch);
    } catch (e: any) {
      this.setTask(null);
      if (options.batch) throw e;
      if (e?.name !== 'AbortError') this.toast('Ошибка поиска звуков-паразитов: ' + (e.message || e), 'err');
    }
  }
  private mergeFillers(found: Word[], autoCut: boolean) {
    const p = this.project!;
    const oldWords = p.words, oldState = this.wordState;
    const stateOf = new Map<Word, number>(), muteOf = new Map<Word, number>();
    oldWords.forEach((w, i) => { stateOf.set(w, oldState[i] || 0); muteOf.set(w, this.wordMute[i] || 0); });
    // keep everything except earlier detections and wav2vec2 sounds the new fillers cover
    const keep = oldWords.filter((w) => !(w.kind === 'filler' && w.auto))   // fillers that came from the text itself stay
      .filter((w) => !(w.kind === 'extra' && found.some((f) => f.start < w.end && f.end > w.start)));
    for (const w of keep) if (w.kind !== 'filler' && FILLER_TEXT.test(w.text)) { w.kind = 'filler'; if (!stateOf.get(w) && autoCut) stateOf.set(w, WS.Filler); }
    // a filler must not overlap a kept word: trim it to the gap
    const fresh = found.filter((f) => !keep.some((w) => w.kind !== 'extra' && w.start < f.end - 0.05 && w.end > f.start + 0.05));
    const words = [...keep, ...fresh].sort((a, b) => a.start - b.start);
    const st = new Uint8Array(words.length);
    words.forEach((w, i) => { st[i] = stateOf.has(w) ? stateOf.get(w)! : autoCut ? WS.Filler : 0; });
    // remap suggestions (word indices shift)
    const newIdx = new Map<Word, number>(); words.forEach((w, i) => newIdx.set(w, i));
    const mapIdx = (i: number, dir: 1 | -1) => {
      for (let k = i; k >= 0 && k < oldWords.length; k += dir) { const n = newIdx.get(oldWords[k]); if (n != null) return n; }
      return -1;
    };
    p.suggestions = p.suggestions.map((s) => ({ ...s, from: mapIdx(s.from, 1), to: mapIdx(s.to, -1) })).filter((s) => s.from >= 0 && s.to >= s.from);
    if (p.profHits) p.profHits = p.profHits.map((h) => ({ ...h, from: mapIdx(h.from, 1), to: mapIdx(h.to, -1) })).filter((h) => h.from >= 0 && h.to >= h.from);
    if (p.edges) p.edges = remapEdges(p.edges, (i) => { const n = newIdx.get(oldWords[i]); return n == null ? -2 : n; });
    this.cutSel = null;
    this.wordMute = Uint8Array.from(words.map((w) => muteOf.get(w) || 0));
    p.words = words; this.wordState = st;
    this.selection = null; this.undoStack = []; this.redoStack = [];
    this.changed();
  }
  // ---------------------------------------------------------------- mute (silence a word, keep it in the timeline)
  /** Mute the range, or unmute it if every word in it is already muted. */
  toggleMute(i0: number, i1: number) {
    if (!this.project) return;
    let all = true;
    for (let i = i0; i <= i1; i++) if (!this.wordMute[i]) { all = false; break; }
    this.checkpoint();
    for (let i = i0; i <= i1; i++) this.wordMute[i] = all ? MU.None : (this.wordMute[i] || MU.Manual);
    this.changed();
  }
  /** Source-time ranges to silence (muted words that are not cut), merged; margin applied. */
  muteRegions(): [number, number][] {
    const p = this.project; if (!p) return [];
    const m = this.profOpts().marginMs / 1000;
    const out: [number, number][] = [];
    for (let i = 0; i < p.words.length; i++) {
      if (!this.wordMute[i]) continue;
      let j = i; while (j + 1 < p.words.length && this.wordMute[j + 1]) j++;
      const a = Math.max(0, p.words[i].start - m), b = p.words[j].end + m;
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
      i = j;
    }
    return out;
  }
  /** New projects start with the last-used мат settings (custom words, exclusions, mode). */
  profOpts(): ProfanitySettings {
    const p = this.project!;
    if (!p.profanity) {
      let saved: Partial<ProfanitySettings> = {};
      try { saved = JSON.parse(localStorage.getItem('carver:profanity') || '{}'); } catch { /* */ }
      p.profanity = { ...DEFAULT_PROFANITY, ...saved };
    }
    return p.profanity;
  }
  setProfOpts(o: Partial<ProfanitySettings>) {
    Object.assign(this.profOpts(), o);
    localStorage.setItem('carver:profanity', JSON.stringify(this.profOpts()));
    this.changed(false);
  }
  /** «Почистить мат»: find мат in the transcript and mute or cut it (per the chosen mode). */
  cleanProfanity() {
    const p = this.project; if (!p || !p.words.length) return 0;
    const o = this.profOpts();
    const hits = findProfanity(p.words, o);
    this.checkpoint();
    this.unapplyProfanity();
    for (const h of hits) for (let i = h.from; i <= h.to; i++) {
      if (o.mode === 'mute') this.wordMute[i] = this.wordMute[i] || MU.Profanity;
      else if (!this.wordState[i]) this.wordState[i] = WS.Profanity;
    }
    p.profHits = hits;
    this.changed();
    return hits.length;
  }
  private unapplyProfanity() {
    this.wordMute.forEach((v, i) => { if (v === MU.Profanity) this.wordMute[i] = MU.None; });
    this.wordState.forEach((v, i) => { if (v === WS.Profanity) this.wordState[i] = WS.Kept; });
  }
  /** Return every мат word (unmute / restore) found by «Почистить мат». */
  clearProfanity() {
    const p = this.project; if (!p) return;
    this.checkpoint(); this.unapplyProfanity(); p.profHits = []; this.changed();
  }
  /** Change how one hit is treated: mute / cut / keep. */
  setHitTreatment(h: { from: number; to: number }, t: 'mute' | 'cut' | 'keep') {
    this.checkpoint();
    for (let i = h.from; i <= h.to; i++) {
      if (this.wordMute[i] === MU.Profanity) this.wordMute[i] = MU.None;
      if (this.wordState[i] === WS.Profanity) this.wordState[i] = WS.Kept;
      if (t === 'mute') this.wordMute[i] = this.wordMute[i] || MU.Profanity;
      if (t === 'cut' && !this.wordState[i]) this.wordState[i] = WS.Profanity;
    }
    this.changed();
  }

  // ---------------------------------------------------------------- custom cut edges (waveform handles)
  /** Selected red region in the waveform: identified by its edge owners; `handle` = edge for keyboard nudging. */
  cutSel: { sk?: string; ek?: string; a: number; b: number; handle: 'a' | 'b' } | null = null;
  private lastNudge = 0;
  /** The currently selected region in the current EDL (owners first, then overlap with the last known span). */
  selectedRegion(): CutRegion | null {
    const sel = this.cutSel, rs = this.edl?.regions; if (!sel || !rs) return null;
    return rs.find((r) => r.sk === sel.sk && r.ek === sel.ek)
      || rs.find((r) => (sel.sk && r.sk === sel.sk) || (sel.ek && r.ek === sel.ek))
      || rs.find((r) => r.a < sel.b && r.b > sel.a) || null;
  }
  selectRegion(r: CutRegion | null, handle: 'a' | 'b' = 'a') {
    this.cutSel = r ? { sk: r.sk, ek: r.ek, a: r.a, b: r.b, handle } : null;
    this.bump();
  }
  /** Allowed range for an edge: regions never overlap or touch (a kept piece ≥ minKeep stays between). */
  edgeLimits(r: CutRegion, which: 'a' | 'b'): [number, number] {
    const p = this.project!, rs = this.edl!.regions, i = rs.indexOf(r);
    const gap = Math.max(p.cut.minKeep, 0.02) + 0.001, MIN = 0.02;
    if (which === 'a') return [i > 0 ? rs[i - 1].b + gap : 0, r.b - MIN];
    return [r.a + MIN, i + 1 < rs.length ? rs[i + 1].a - gap : p.media.duration];
  }
  /** Move one edge of a region (clamped). `undoGroup`: coalesce rapid keyboard nudges into one undo step. */
  setEdge(r: CutRegion, which: 'a' | 'b', t: number, undoGroup = false) {
    const p = this.project; if (!p) return;
    const key = which === 'a' ? r.sk : r.ek; if (!key) return;
    const [lo, hi] = this.edgeLimits(r, which);
    t = Math.min(hi, Math.max(lo, t));
    if (!undoGroup || performance.now() - this.lastNudge > 1500) this.checkpoint();
    this.lastNudge = undoGroup ? performance.now() : 0;
    p.edges = { ...(p.edges || {}), [key]: Math.round(t * 1e4) / 1e4 };
    this.changed();
    // keep the selection on the same region
    const nr = this.edl?.regions.find((x) => x.sk === r.sk && x.ek === r.ek);
    if (nr) this.cutSel = { sk: nr.sk, ek: nr.ek, a: nr.a, b: nr.b, handle: which };
  }
  /** Double-click: this region back to its automatic edges. */
  resetRegion(r: CutRegion) {
    const p = this.project; if (!p || !p.edges) return;
    if (!(r.sk && r.sk in p.edges) && !(r.ek && r.ek in p.edges)) return;
    this.checkpoint();
    const e = { ...p.edges }; if (r.sk) delete e[r.sk]; if (r.ek) delete e[r.ek];
    p.edges = e;
    this.changed();
    const nr = this.edl?.regions.find((x) => x.sk === r.sk && x.ek === r.ek);
    this.cutSel = nr ? { sk: nr.sk, ek: nr.ek, a: nr.a, b: nr.b, handle: this.cutSel?.handle || 'a' } : null;
  }

  // ---------------------------------------------------------------- заставки
  /** Load the global заставка library once at startup. */
  async initTitleLib() { this.titleLib = await loadTitleLib(); this.titleAssets = new Map(this.titleLib.map((t) => [t.id, t])); this.bump(); }
  async addTitle(file: File, handle: FileSystemFileHandle | null) {
    const t = await addTitleFile(file, handle);
    this.titleLib = [...this.titleLib.filter((x) => x.id !== t.id), t];
    this.titleAssets.set(t.id, t);
    this.bump();
  }
  /** Swap the file behind a заставка, keeping its insertions (they are trimmed to the new duration). */
  async replaceTitle(id: string, file: File, handle: FileSystemFileHandle | null) {
    const t = await replaceTitleFile(id, file, handle);
    this.titleLib = this.titleLib.map((x) => (x.id === id ? t : x));
    this.titleAssets.set(id, t);
    if (this.project?.titles?.some((x) => x.assetId === id)) {
      this.checkpoint();
      for (const ins of this.project.titles) if (ins.assetId === id) {
        ins.b = Math.min(ins.b, t.duration);
        ins.a = Math.min(ins.a, Math.max(0, ins.b - 0.05));
      }
      this.changed();
    } else this.bump();
  }
  async removeTitleAsset(id: string) {
    await removeTitleLib(id);
    this.titleLib = this.titleLib.filter((x) => x.id !== id);
    this.titleAssets.delete(id);
    // drop any insertions that used it
    if (this.project?.titles?.some((t) => t.assetId === id)) { this.checkpoint(); this.project.titles = this.project.titles.filter((t) => t.assetId !== id); this.changed(); }
    else this.bump();
  }
  /** Snap an insertion point to the end of the word under / just before it (text-first). */
  snapAnchor(src: number): number {
    const ws = this.project?.words;
    if (!ws || !ws.length) return src;
    const i = lastLE(ws, src, (w) => w.start);   // last word starting at or before src
    return i >= 0 ? ws[i].end : 0;
  }
  insertTitle(assetId: string, anchor: number): TitleInsert | null {
    const p = this.project; if (!p || !this.edl) return null;
    const asset = this.titleAssets.get(assetId); if (!asset) return null;
    anchor = this.snapAnchor(anchor);
    this.checkpoint();
    const t: TitleInsert = { id: uid(), assetId, anchor, a: 0, b: asset.duration };
    p.titles = [...(p.titles || []), t];
    this.changed();
    this.selection = null; this.cutSel = null;
    this.titleSel = { id: t.id, handle: 'b' };
    this.bump();
    return t;
  }
  removeTitle(id: string) {
    const p = this.project; if (!p || !p.titles) return;
    this.checkpoint();
    p.titles = p.titles.filter((t) => t.id !== id);
    if (this.titleSel?.id === id) this.titleSel = null;
    this.changed();
  }
  trimTitle(id: string, a: number, b: number, undoGroup = false) {
    const p = this.project; if (!p) return;
    const t = p.titles?.find((x) => x.id === id); if (!t) return;
    const d = this.titleAssets.get(t.assetId)?.duration ?? t.b;
    a = Math.max(0, Math.min(a, b - 0.02)); b = Math.min(d, Math.max(b, a + 0.02));
    if (!undoGroup || performance.now() - this.lastNudge > 1500) this.checkpoint();
    this.lastNudge = undoGroup ? performance.now() : 0;
    t.a = a; t.b = b;
    this.changed();
  }
  resetTitle(id: string) {
    const p = this.project; if (!p) return;
    const t = p.titles?.find((x) => x.id === id); if (!t) return;
    const d = this.titleAssets.get(t.assetId)?.duration; if (d == null) return;
    this.checkpoint(); t.a = 0; t.b = d; this.changed();
  }
  titleInsert(id: string) { return this.project?.titles?.find((t) => t.id === id) || null; }

  /** Cut (true) or restore (false) every filler sound. */
  setAllFillers(cut: boolean) {
    const p = this.project; if (!p) return;
    this.checkpoint();
    p.words.forEach((w, i) => {
      if (w.kind !== 'filler') return;
      if (cut && !this.wordState[i]) this.wordState[i] = WS.Filler;
      if (!cut && this.wordState[i] === WS.Filler) this.wordState[i] = WS.Kept;
    });
    this.changed();
  }

  // ---------------------------------------------------------------- LLM suggestions
  settingsTab: null | 'ui' | 'stt' | 'llm' | 'audio' = null;
  sideTab: 'silence' | 'mat' | 'titles' | 'ai' | 'texts' | 'export' | 'audio' = 'silence';
  /** Loudness measurement of the current project (null until the Аудио tab asks for it). */
  audio: LoudnessReport | null = null;
  audioBusy = false;
  /** Result of the chain, measured before exporting (Аудио tab shows it next to the raw LUFS). */
  /** Measurement of the ORIGINAL sound; `audio` is what is on the timeline right now (processed or not). */
  audioBase: LoudnessReport | null = null;
  setSideTab(t: Store['sideTab']) { this.sideTab = t; this.bump(); }
  // ---------------------------------------------------------------- text steps (project content)
  /** Save an edited text-step result into the project. */
  setPipelineText(stepId: string, text: string) {
    const p = this.project; if (!p) return;
    const at = Date.now();
    const prev = p.pipeline.find(r => r.stepId === stepId);
    p.pipeline = prev
      ? p.pipeline.map(r => (r.stepId === stepId ? { ...r, text, at } : r))
      : [...p.pipeline, { stepId, text, at }];
    this.scheduleSave(); this.bump();
  }
  /** Save this project's own version of a step prompt (the global step list is left alone). */
  setPipelinePrompt(stepId: string, patch: { map?: string; reduce?: string }) {
    const p = this.project; if (!p) return;
    const base = p.prompts?.[stepId];
    const cur = { map: base?.map ?? '', reduce: base?.reduce ?? '', ...patch };
    p.prompts = { ...(p.prompts || {}), [stepId]: cur };
    this.scheduleSave(); this.bump();
  }
  /** Drop the project's prompt override, returning the step to its default prompt. */
  clearPipelinePrompt(stepId: string) {
    const p = this.project; if (!p?.prompts?.[stepId]) return;
    const next = { ...p.prompts }; delete next[stepId];
    p.prompts = Object.keys(next).length ? next : undefined;
    this.scheduleSave(); this.bump();
  }
  afterTranscribe: (() => void) | null = null;   // set by fasttrack.ts (fast track / walk-away mode)
  openSettings(tab: 'ui' | 'stt' | 'llm' | 'audio' | null) { this.settingsTab = tab; this.bump(); }
  private applySugg(sg: Suggestion) { for (let i = sg.from; i <= sg.to; i++) if (!this.wordState[i]) this.wordState[i] = WS.Llm; sg.status = 'accepted'; }
  private unapplySugg(sg: Suggestion) {
    if (sg.status === 'accepted') for (let i = sg.from; i <= sg.to; i++) if (this.wordState[i] === WS.Llm) this.wordState[i] = WS.Kept;
  }
  /** Add new suggestions (replacing pending ones that overlap them). */
  addSuggestions(list: Suggestion[], autoApply: boolean) {
    const p = this.project; if (!p) return;
    this.checkpoint();
    const keep = p.suggestions.filter((o) => o.status !== 'pending' || !list.some((n) => n.from <= o.to && n.to >= o.from));
    const fresh = list.filter((n) => !keep.some((o) => o.status !== 'pending' && o.from === n.from && o.to === n.to));
    for (const n of fresh) if (autoApply) this.applySugg(n);
    p.suggestions = [...keep, ...fresh].sort((a, b) => a.from - b.from);
    this.changed();
  }
  setSuggestionStatus(ids: string[], status: Suggestion['status']) {
    const p = this.project; if (!p) return;
    this.checkpoint();
    for (const sg of p.suggestions) {
      if (!ids.includes(sg.id) || sg.status === status) continue;
      this.unapplySugg(sg);
      if (status === 'accepted') this.applySugg(sg); else sg.status = status;
    }
    this.changed();
  }
  clearSuggestions() {
    const p = this.project; if (!p) return;
    this.checkpoint();
    for (const sg of p.suggestions) this.unapplySugg(sg);
    p.suggestions = [];
    this.changed();
  }
}

export const S = new Store();
// flush pending autosave when the tab is hidden or closed (IndexedDB writes started here complete)
const flushSave = () => { if (S.project) S.saveNow(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', flushSave);
(window as any).__carver = S;   // for debugging & automated tests
(window as any).__carverDebug = {
  getSpeechRPC, pcmSlice, srcToOut, measureLoudness,
  /** Test only: loudness of an exported file (decoded in the page, downmixed to mono, at its own rate). */
  async measureFile(file: File) {
    const m = await openMedia(file);
    const { AudioBufferSink } = await import('mediabunny');
    const sink = new AudioBufferSink(m.audio), meter = new LoudnessMeter(m.meta.sampleRate);
    const over = { m3: 0, m1: 0, m01: 0, total: 0 };
    const t3 = Math.pow(10, -3 / 20), t1 = Math.pow(10, -1 / 20), t01 = Math.pow(10, -0.1 / 20);
    for await (const { buffer } of sink.buffers()) {
      const n = buffer.length, nc = buffer.numberOfChannels, mono = new Float32Array(n);
      for (let c = 0; c < nc; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < n; i++) { const v = d[i], a = v < 0 ? -v : v; mono[i] += v / nc; if (a > t3) { over.m3++; if (a > t1) { over.m1++; if (a > t01) over.m01++; } } }
        over.total += n;
      }
      meter.push(mono);
    }
    m.input.dispose();
    return { ...meter.finish(), over };
  },
  /** Test only: EXACT processed levels for the whole programme (slow — the app never does this). */
  exactLevels() {
    const st = S.master, pcm = S.pcm; if (!st || !pcm) return null;
    const es = new ExactStream(pcm, st.full, S.live.chain!, 0), out = new Float32Array(Math.ceil(pcm.length / BLK));
    const buf = new Float32Array(BLK * 6000);
    for (let o = 0; ;) { const n = es.next(buf, buf.length); if (!n) break; o += rmsBlocks(buf.subarray(0, n), out, o); }
    return out;
  },
};

export function useStore<T>(sel: (s: Store) => T): T {
  useSyncExternalStore(S.subscribe, () => S.version);
  return sel(S);
}
