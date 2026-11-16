// Core data model of a Carver project.
// All times are in seconds of the SOURCE media unless a name says otherwise ("out").

/** A transcript token. Words come from Whisper; "extra" tokens are sounds heard by wav2vec2
 *  between Whisper's words (fillers, false starts Whisper silently dropped). */
export interface Word {
  text: string;          // display text incl. punctuation, e.g. "привет,"
  start: number;
  end: number;
  score?: number;        // alignment confidence 0..1 (undefined = interpolated)
  kind?: 'extra' | 'filler';   // undefined = Whisper word; extra = sound wav2vec2 heard; filler = «эээ/ммм»
  para?: boolean;        // true = this word starts a new paragraph
  auto?: boolean;        // filler found acoustically (replaced on re-detection)
}

export interface MediaMeta {
  name: string;
  size: number;
  lastModified: number;
  duration: number;
  /** false for an audio-only import (MP3, M4A, WAV, FLAC, OGG…). Absent in older saved projects:
   *  derive with `mediaHasVideo()` in lib/media.ts. */
  hasVideo?: boolean;
  width: number;         // 0 for audio-only
  height: number;        // 0 for audio-only
  fps: number;           // 30 for audio-only (the timeline only needs a frame grid for video)
  videoCodec: string;    // '' for audio-only
  audioCodec: string;
  sampleRate: number;
  channels: number;
  videoBitrate: number;  // bits/s estimate (0 if unknown)
}

export interface SilenceSettings {
  enabled: boolean;
  thresholdDb: number;   // noise floor: frames quieter than this are silence (dBFS)
  minDuration: number;   // only silences at least this long are cut (s)
  padBefore: number;     // kept after speech ends (s) — "padding left" of the cut
  padAfter: number;      // kept before speech resumes (s)
}

export interface CutSettings {
  wordMargin: number;    // safety margin around removed words (s)
  fade: number;          // audio fade at every join (s)
  minKeep: number;       // kept slivers shorter than this are dropped (s)
}

/** Why a word is removed. 0 = kept. */
export const WS = { Kept: 0, Manual: 1, Llm: 2, Filler: 3, Profanity: 4 } as const;
/** Why a word is muted (silenced but kept in the timeline). 0 = audible. */
export const MU = { None: 0, Manual: 1, Profanity: 2 } as const;

export interface FastTrack {
  status: 'running' | 'done' | 'error';
  step: 'transcribe' | 'mat' | 'ai' | 'done';
  strength: 'careful' | 'normal' | 'aggressive';
  started: number;
  finished?: number;
  matFound?: number;
  aiFound?: number;
  aiSkipped?: string;        // why the AI step didn't run (not configured, error…)
  error?: string;
  dismissed?: boolean;       // the result card was closed
}

export interface ProfanitySettings { mode: 'mute' | 'cut'; extra: string; exclude: string; marginMs: number; fadeMs: number }
export const DEFAULT_PROFANITY: ProfanitySettings = { mode: 'mute', extra: '', exclude: '', marginMs: 30, fadeMs: 4 };

export type SuggestionType = 'false_start' | 'repetition' | 'filler' | 'slip' | 'aside' | 'other';

export interface Suggestion {
  id: string;
  from: number;          // first word index
  to: number;            // last word index (inclusive)
  type: SuggestionType;
  reason: string;
  confidence?: number;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface PipelineResult { stepId: string; text: string; at: number; model?: string }

export interface Project {
  id: string;
  /** Server workspace association; video bytes and local handles are never serialized. */
  workspaceId?: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  media: MediaMeta;
  transcriptModel?: string;
  /** Unedited transcription-stage result, retained even after filler insertion/removal and editing. */
  transcription?: { words: Word[]; model: string; at: number; device?: string };

  words: Word[];
  /** per-word removal state (WS), same length as words */
  wordState: number[];
  silence: SilenceSettings;
  cut: CutSettings;
  /** silences the user restored manually, identified by rounded start time (ms) */
  keptSilences: number[];
  /** manual time-range cuts not tied to words (e.g. from the timeline) */
  rangeCuts: [number, number][];
  suggestions: Suggestion[];
  pipeline: PipelineResult[];
  /** Per-project overrides of the text-step prompts (id → prompt). Absent = the global/preset prompt. */
  prompts?: Record<string, { map: string; reduce?: string }>;
  /** «Заметки редактора»: free-form notes shared with everyone in the workspace (synced as project data). */
  notes?: string;
  fillers?: { sensitivity: 'low' | 'normal' | 'high'; autoCut: boolean; scanned?: boolean };
  /** per-word mute state (MU), same length as words */
  wordMute?: number[];
  profanity?: ProfanitySettings;
  /** last «Почистить мат» result: word ranges */
  profHits?: { from: number; to: number; kind: string }[];
  /** fast track (file dropped on the right half): transcribe → mute мат → AI carving, unattended */
  fastTrack?: FastTrack;
  /** custom cut edges set in the waveform (see EdgeOverrides in lib/edl.ts) */
  edges?: Record<string, number>;
  /** заставки placed on this project's timeline (in output order after rebuild) */
  titles?: TitleInsert[];
  /** loudness processing (leveler variant + compressor + the resulting gain curve); absent = original sound */
  master?: import('../audio/live').MasterSaved;
  /** «Реставрация» (Sidon speech restoration) dry/wet, 0…100 in steps of 20; absent/0 = off (no model) */
  restore?: number;
  /** Last saved composite duration, including titles. */
  outputDuration?: number;
  /** Stage history for sequential processing. */
  batch?: import('./batch-types').BatchProject;
  /** Successful user-initiated MP4 export only (never inferred from editing/XML/downloads). */
  videoExport?: { at: number; name: string };
  version: 1;
}

export const DEFAULT_SILENCE: SilenceSettings = {
  enabled: true, thresholdDb: -42, minDuration: 1.0, padBefore: 0.15, padAfter: 0.12,
};
export const DEFAULT_CUT: CutSettings = { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 };

/** A kept piece of the source, in order. */
/** A заставка in the user's library: a short intro/outro/header video on disk. */
export interface TitleAsset {
  id: string; name: string;
  duration: number;              // full asset length (s)
  width: number; height: number; fps: number;
  hasVideo: boolean; hasAudio: boolean;
  sampleRate: number; channels: number;
  videoCodec: string; audioCodec: string;
}

/** A заставка placed on the timeline. anchor = SOURCE time of the main video where it is inserted;
 *  a..b = which part of the asset plays (trim points, default the whole thing). */
export interface TitleInsert {
  id: string;
  assetId: string;
  anchor: number;
  a: number; b: number;
}

export interface Segment { start: number; end: number }
