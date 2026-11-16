# Architecture

This document is the map. The invariants and feature-level traps live in [AGENTS.md](../AGENTS.md);
the decisions behind them are in [HISTORY.md](HISTORY.md). Read those before changing behavior.

## System context

```
┌──────────────────────────── Browser (Chrome / Edge) ────────────────────────────┐
│                                                                                  │
│  React UI ──► Store (singleton S) ──► Project JSON ──► IndexedDB                 │
│                  │  │  │                                                        │
│                  │  │  └──► EDL / composite timeline ──► Player / Export         │
│                  │  └─────► PCM + levels ──► waveform, silence, loudness         │
│                  └────────► Workers: speech (Whisper + wav2vec2), DSP, restore   │
│                                                                                  │
│  Outbound: user-configured LLM API · Hugging Face (models) · optional workspace  │
└──────────────────────────────────────────────────────────────────────────────────┘
             │ HTTPS (project JSON only)              │ static files
             ▼                                        ▼
   optional server/workspace-server.mjs        any static host / nginx
```

The editor is a static single-page app. `server/workspace-server.mjs` is optional: it stores project
JSON for shared workspaces and never receives media bytes. There is no database, no auth provider and
no application server in the default deployment.

The video is never uploaded. The only data that leaves the browser is transcript text sent to the
LLM endpoint the user configures, plus model downloads from Hugging Face / the optional mirror.

## Main data flow

```
File (FileSystemFileHandle, remembered in IndexedDB)
 └─ mediabunny Input (lazy byte-range BlobSource)
     ├─ audio → extractPcm16 → Int16Array 16 kHz mono
     │    ├─ computeLevels (10 ms dBFS) → silence detection, waveform, auto-threshold
     │    └─ speech.worker: Whisper (WebGPU/CPU) + wav2vec2-ru CTC alignment → Word[]
     │         └─ fillers.ts: acoustic «эээ/ммм» in gaps, wav2vec2 veto → Word kind 'filler'
     └─ video/audio → Player (preview) and export (render.ts / audio.ts)

Word[] + wordState + keptSilences + rangeCuts + settings
    ──buildEdl──► Edl { segments (kept, SOURCE time), outStarts, removed }
Word[] + wordMute ──muteRegions──► source ranges to silence (per-output switch)
TitleInsert[] + kept segments ──buildComposite──► output timeline with заставки
```

All edit times are **SOURCE seconds**. The output timeline is derived; only names containing `out`
refer to it. Conversion goes through `srcToOut` / `outToSrc` / `segAt` (`src/lib/edl.ts`) and
`composite.srcToOut` when titles are present.

## Module map

| Path | Responsibility |
|---|---|
| `src/store.ts` | Singleton `S`: project, media, PCM, levels, EDL, selection, undo/redo, tasks, toasts, autosave, open/link/transcribe flows, filler merge, mute/мат actions, AI suggestions, side tab. `useStore(sel)` hook. |
| `src/lib/types.ts` | Data model: `Word`, `Project`, `WS`/`MU` enums, settings defaults, `FastTrack`, `Suggestion`. |
| `src/lib/edl.ts` | Silence detection, word cuts, `buildEdl`, `srcToOut` / `outToSrc` / `segAt`, custom cut edges. |
| `src/lib/pcm.ts` | PCM extraction/resampling, level envelope, auto threshold, `pcmSlice`. |
| `src/lib/media.ts` | `openMedia` (mediabunny), `MediaMeta`, `sameFile`, `mediaHasVideo`; audio-only sources have `hasVideo: false`. |
| `src/lib/composite.ts` | Composite output timeline: kept main content interleaved with заставки. |
| `src/lib/titles.ts` | Заставка library (metadata in IndexedDB kv, bytes in blobs), lazy open, decodability check. |
| `src/lib/db.ts` | IndexedDB `carver`: `projects`, `blobs` (`<id>:pcm`, title bytes), `handles`, `kv` (checkpoints, export dir). |
| `src/lib/profanity.ts` | Russian мат detector, custom list compiler (`*`, `/regex/`), `findProfanity`, `maskWord`. |
| `src/transcribe/speech.worker.ts` | Whisper pipeline + wav2vec2 CTC; returns forced alignment and per-character `heard` tokens. |
| `src/transcribe/run.ts` | VAD, 5-minute windows with 15 s overlap, loop guards, alignment groups, “squeezed” retries, edge snapping, paragraphs, checkpoints, model preloading. |
| `src/transcribe/fillers.ts` | Acoustic filler detection (voiced, spectrally steady, flat pitch) + wav2vec2 veto. |
| `src/player/player.ts` | Preview: `CanvasSink` frames on the output grid + `AudioContext` clock; fades, mute automation, playback rate. |
| `src/player/stretch.ts` | WSOLA pitch-preserving time stretch for 0.75–2× preview. |
| `src/lib/dsp.ts` | Block model of processed sound: phrase measurement, leveler, compressor/limiter model, modelled LUFS, calibration, exact render. |
| `src/audio/live.ts` | `LiveMaster` (`S.live`): analysis cache, settings, model levels, exact tiles, visible samples, settle-then-measure. |
| `src/audio/dsp.worker.ts` | DSP worker: one-pass analysis, exact 60 s tiles, exact whole-programme loudness. |
| `src/restore/*` | Sidon speech restoration: fbank front-end, ONNX worker (WebGPU/WASM), tile cache, preview/export plans, dry/wet mix. |
| `src/lib/leveler.ts` | Gain function from stored breakpoints, shared by player and export. |
| `src/lib/masterchain.ts` | Master bus: soft compressor + automatic make-up + look-ahead limiter at −3 dBFS. |
| `src/lib/loudness.ts` | BS.1770-4 meter: K-weighting, 400 ms gated blocks, short-term/LRA, true-peak estimate. |
| `src/export/render.ts` | MP4: WebCodecs H.264 frame grid + AAC, priming delay measured/compensated, streams to a file handle. |
| `src/export/audio.ts` | Shared sample-accurate audio renderer + MP3 export + MP3 delay measurement. |
| `src/export/subs.ts` | SRT, JSON, plain and timecoded text on the output timeline; optional mute masking. |
| `src/export/folder.ts` | «Сохранить всё»: remembered directory handle, per-project subfolder, file writes. |
| `src/export/results.ts` | Batch result folder: manifest, texts, XML, previously rendered MP4. |
| `src/export/xml.ts` | Final Cut Pro 7 XML (`xmeml` v5) serializer and frame/rate validation. |
| `src/llm/client.ts` | OpenAI-compatible client: streaming, retries, compatibility adaptation, reasoning/thinking, model listing. |
| `src/llm/carve.ts` | AI carving prompt, indexed transcript lines, quote → word range matching, confidence filter. |
| `src/llm/pipeline.ts` | Text steps and map/merge for long texts. |
| `src/llm/phase.ts` | Human-readable status for in-flight requests. |
| `src/fasttrack.ts` | Fast-track orchestration, wake lock, notification; hooks `S.afterTranscribe`. |
| `src/batch.ts` | Sequential batch queue: stage state, retries, stop/resume, folder relink, result download. |
| `src/ui/*` | React components; `hub.ts` holds non-React singletons (player, scroll, time listeners). |
| `public/sw.js` | Service worker: page network-first, hashed assets cache-first. |
| `server/workspace-server.mjs` | Optional workspace service: project JSON, sessions, leases, admin page. |

## Persistence and state

- **IndexedDB `carver`** is the source of truth for projects, PCM blobs, title bytes, file handles
  and key-value settings/checkpoints. Project JSON is autosaved after a 300 ms debounce and flushed on
  `visibilitychange` / `pagehide`. PCM is cached so reopening a project does not decode again; the
  source file still has to be re-linked because browsers cannot persist permission forever.
- **`localStorage`** holds preferences and last-used settings, not project content:
  `carver:prefs`, `carver:llm`, `carver:carve`, `carver:pipeline`, `carver:export`, `carver:profanity`,
  `carver:modelsReady:<model>`, `carver:device`.
- **Undo** snapshots (`Snap`) contain word cut/mute state, kept silences, range cuts, suggestion
  statuses and custom cut edges. Any new per-word or per-project edit state must be added to
  `snap()` / `restore()`. Operations that re-index words clear the undo stack.
- **One task at a time**: `S.task` (`kind`, `frac`, `text`, `cancel`). Long operations report progress
  and must be cancellable. Completion chimes are driven by idle detection, not by individual steps.

## Editing model

Two independent axes:

1. **Cut** (`wordState[i]`, reasons `WS.Kept/Manual/Llm/Filler/Profanity`): removes time from the EDL.
2. **Mute** (`wordMute[i]`, reasons `MU.None/Manual/Profanity`): keeps time but silences the word.

All outputs share the same cuts and length; only muting may differ per output (for example video with
мат, MP3 without). Bulk actions only touch their own reason, so «Вернуть все» fillers cannot undo a
manual or AI cut.

`buildEdl` removes a run of words together with the pause that follows it, so the remaining pause
sits before the next kept word. Silence cuts never clip kept words, and slivers shorter than
`cut.minKeep` are dropped. Custom cut edges are absolute source times owned by a stable key
(`rs:`/`re:`, `gs:`/`ge:`), survive automatic recomputation, and are re-keyed when words are
inserted/removed by filler merging.

Заставки are a composite layer on top of the kept timeline. They do not consume source time; they
shift later output. The waveform stays in source time and draws a fixed-width green marker at the
anchor. Subtitles and timecoded text use the composite mapping.

## Audio processing

The sound chain is project state and is evaluated live:

```
restore (optional) → gain curve (phrase leveler + silence ducking) → compressor → make-up → limiter
```

- The meter uses 16 kHz mono PCM, so stereo material may read 1–3 dB low and true peak is a floor.
- The block model is fast enough to redraw 1.5 h of waveform in ~100 ms; exact 60 s tiles replace it
  as they arrive. The panel shows «≈» until the whole processed programme has been measured.
- Export uses the same curve and compressor/limiter settings; the limiter's 1.5 ms latency is
  trimmed at the start and flushed at the end.
- Restoration mixes before the gain curve. Tiles are loudness-matched to dry and crossfaded in.

## Workspace concurrency (optional service)

- The client polls a ~1 KB **manifest** every 5 s and downloads a project only when its revision is
  new. Applied revisions are stored in IndexedDB so reloads are cheap.
- Saves are revision-checked: a stale `PUT` gets `409 STALE_REVISION`; a deleted project gets
  `410 PROJECT_DELETED` via a tombstone.
- Editor and batch locks are 60 s leases with heartbeats. Releasing a lock uses
  `DELETE /projects/:id/lock`; deleting a project uses `DELETE /projects/:id`.
- The server serializes read-modify-write per workspace, writes atomically via a temp file + rename,
  and bounds body reads and jobs so one stalled upload cannot wedge the workspace.
- Sessions are cookie-based and persisted to disk so a service restart does not log everyone out.
  On `401`, the client re-exchanges the magic-link token once and retries.

## Batch queue

The queue runs one project at a time using the normal store operations, but does not open the editor.
Every file becomes a saved project before processing; each stage is awaited and persisted before the
next one starts. A failed file does not block later files. Settings are shared and can only change at
safe boundaries. The video stage is manual by default: downloading results never starts an expensive
render. See [BATCH.md](BATCH.md).

## Security boundaries

- No secrets in the repository. LLM keys live in browser `localStorage`; the workspace service uses
  environment variables.
- Workspace tokens are bearer secrets in a URL; they are exchanged for an HttpOnly cookie on first
  use. Do not log them or put them in docs.
- The workspace service accepts project JSON only; media bytes are rejected. Admin routes require
  Basic Auth (or a bearer admin secret for scripts).
- Static hosting must not add COOP/COEP; the app does not need cross-origin isolation and those
  headers break model downloads.
