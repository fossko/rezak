# Резак (Carver) — guide for AI coding agents

Read this before changing anything. It is written for Claude, GPT, DeepSeek and other agents working
on this codebase. The user-facing description is in [README.md](README.md); the architecture overview
is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); setup and tests are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); the request/decision history and measurements are in
[docs/HISTORY.md](docs/HISTORY.md); current limitations are in [docs/STATUS.md](docs/STATUS.md).

## Public repository rules

This is a public source release. Before every commit:

- **Never commit secrets.** No API keys, tokens, passwords, cookies, private keys, workspace magic
  links, server IPs, internal hostnames or `.env` files. Configuration belongs in environment
  variables or the browser's own settings, never in the tree.
- Run `npm run check:secrets` (also enforced in CI). If a secret is ever committed, treat it as
  compromised: rotate it, then remove it from history; a follow-up commit is not enough.
- Keep private tooling, recordings, model weights, screenshots and build output out of git; the
  `.gitignore` already covers the usual ones.
- Do not add production deployment details to docs. Use `<your-domain>` / `<server-host>` and the
  examples in `deploy/`.

## TL;DR — 12 things to know first

1. **What it is:** a browser-only (Chrome) editor that *removes* things from long Russian video
   monologues: pauses, filler sounds, false starts, мат. Text-based editing: delete words → video is cut.
   No rearranging, no multiple sources, no timeline editing beyond cutting.
2. **The editor has no backend.** It is a static Vite + React + TypeScript site deployed as plain files
   (`dist/`). Everything (decoding, Whisper, export) runs in the browser. `server/workspace-server.mjs`
   is an *optional* collaboration service for project JSON; do not make the editor depend on it.
3. **UI language is Russian.** Code, comments, identifiers and docs are English. Keep it that way.
4. **All times are SOURCE seconds** unless a name says `out` (output timeline after cuts). Conversion
   only via `srcToOut` / `outToSrc` / `segAt` in `src/lib/edl.ts`.
5. **`project.words[i]` is the index space for everything:** `wordState[i]` (cut reason, `WS`),
   `wordMute[i]` (mute reason, `MU`), `suggestions[].from/to`, `profHits[].from/to`. If you insert or
   remove words, you MUST remap all of them (see `Store.mergeFillers` for the pattern).
6. **Cut ≠ mute.** Cut removes time (EDL). Mute silences audio but keeps time. Video and MP3 always have
   identical cuts and identical length; only muting may differ per output.
7. **State lives in one store** (`src/store.ts`, singleton `S`). Mutate, then call `S.changed()`
   (edits: recompute EDL + autosave + rerender) or `S.bump()` (UI only). Call `S.checkpoint()` before
   an undoable edit.
8. **Test against the built app**, not the dev server: `npm run build && npx vite preview --port 5200`.
   Vite HMR reloads the page and silently kills long e2e runs.
9. **`@huggingface/transformers` is pinned to exactly 4.3.1** (validated in the predecessor app). Don't bump.
10. **Do not add COOP/COEP headers** anywhere (server, `.htaccess`, `serve.mjs`): they block model
    downloads from Hugging Face. The app does not need cross-origin isolation.
11. **`file://` cannot work** (module scripts, workers, WASM, fetch are blocked). Local use = `node serve.mjs`.
12. **Verify with measurements, not assumptions.** Non-trivial changes in this project were checked
    with real Chrome, a representative recording and `ffprobe`/numpy scripts. Follow that habit (see Testing).

## Repository layout

The repository root **is** the app (`package.json`, `src/`, `tests/`, `docs/` at the top level). Its
location has no meaning; confirm with `pwd`. There is one published branch, `main`; historical
worktrees and unmerged experiments are not part of this repository.

`dist/`, `node_modules/`, model weights (`models/`), recordings (`*.mp4`), archives (`*.zip`),
screenshots (`shots/`), local tooling (`.tools/`) and build caches are gitignored. Put local test
recordings anywhere outside the tree, or accept that they will not be committed.

Commit code and docs changes with a clear message. Do not rewrite published history.

## Setting up on a new machine

- Node ≥ 20 (developed on 24/26), npm, Google Chrome (tests drive the installed Chrome via
  `channel: 'chrome'`), `ffmpeg`/`ffprobe` (tests), Python 3 (required by `npm test` for the XML
  checker; `numpy` and `Pillow` for the verification/visualisation scripts).
- `npm ci` in the repo root — if `node_modules/` was copied from another machine, delete it and reinstall.
- If npm fails with EPERM on `~/.npm` (sandboxed agents): `export npm_config_cache="$TMPDIR/carver-npm-cache"`.
- Optional: Ollama (`http://localhost:11434`) for testing LLM features locally; any OpenAI-compatible
  endpoint works.
- First e2e run downloads ~2.2 GB of models into the test Chrome profile (`$TMPDIR/carver-test-profile`).
  Later runs reuse it. `$TMPDIR` differs per machine/session; everything test-related lives under it.
- macOS has no `timeout` command; use tool-level timeouts.

## Commands

```bash
npm run dev                         # http://127.0.0.1:5199 (HMR; fine for UI work, NOT for long tests)
npm run build                       # tsc -b && vite build → dist/
npx vite preview --host 127.0.0.1 --port 5200 --strictPort   # serve dist/ for tests
node serve.mjs [port]               # zero-dep server for dist/ (default 8123), correct .wasm MIME
./node_modules/.bin/tsc -p .        # typecheck (TypeScript 7; prints nothing when clean)
node tests/profanity.test.ts        # unit tests (Node runs .ts directly)
node tests/stretch.test.ts
node tests/masterchain.test.ts      # look-ahead limiter: latency, ceiling, speed
node tests/sidon-frontend.test.ts   # needs Python reference files in $SIDON_FE_DIR (default $TMPDIR/sidon-test)
node tests/e2e.mjs <video> --steps=open,transcribe,edit,export   # see Testing
node tests/cpu-warning.mjs <video>  # ⚠️ CPU transcription, «Изменить на WebGPU», GPU diagnostics (≈1 min)
node tests/audio-only.mjs <audio>   # plain-audio import: black preview, MP3-only export, save-all without MP4
```

Some older audio benches still carry historical port defaults: `tests/restore.mjs` and `tests/gain-mode.mjs`
use `http://127.0.0.1:5300/` and `$TMPDIR/carver-audio-test-profile`; `tests/sidon-bench.mjs` defaults to
port 5299. Pass `--url=http://127.0.0.1:5200/` where supported, or serve the preview on the port the script
expects. `tests/audio-dsp.mjs` uses 5200 and the main profile.

Deploy = upload the **contents** of `dist/` (including hidden `.htaccess` and `sw.js`) over HTTPS.
See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full checklist.

## Architecture

```
File (FileSystemFileHandle remembered in IndexedDB)
 └─ mediabunny Input (BlobSource: lazy byte-range reads; 15 GB files are fine)
     ├─ audio → extractPcm16 (WebCodecs decode + OfflineAudioContext resample) → Int16Array 16 kHz mono
     │          ├─ computeLevels (10 ms dBFS) → silence detection, waveform, auto-threshold
     │          └─ speech.worker: Whisper (WebGPU) + wav2vec2-ru CTC forced alignment → Word[]
     │              └─ fillers.ts: acoustic «эээ/ммм» in gaps (+ wav2vec2 check) → Word kind 'filler'
     └─ video/audio → Player (preview) and export (render.ts / audio.ts)

Word[] + wordState + silences + rangeCuts + settings ──buildEdl──► Edl { segments (kept, source time), outStarts, removed }
Word[] + wordMute ──muteRegions──► source ranges to silence (preview + exports, per-output switch)
```

### Module map

| Path | Responsibility |
|---|---|
| `src/store.ts` | Singleton `S`: project, media, pcm, levels, EDL, selection, undo/redo, tasks, toasts, autosave, open/link/transcribe flows, fillers merge, mute & мат actions, AI suggestions apply/unapply, side tab. `useStore(sel)` hook. |
| `src/lib/types.ts` | Data model: `Word`, `Project`, `WS`/`MU` enums, settings defaults, `FastTrack`, `Suggestion`. |
| `src/lib/edl.ts` | Silence detection, word cuts, `buildEdl`, time mapping (`srcToOut`, `outToSrc`, `segAt`). |
| `src/lib/pcm.ts` | PCM extraction/resampling, level envelope, auto threshold, `pcmSlice`. |
| `src/lib/media.ts` | `openMedia` (mediabunny), `MediaMeta`, `sameFile`, `mediaHasVideo` (audio-only sources are supported: `hasVideo: false`, black preview, MP3-only export). |
| `src/lib/composite.ts` | The composite OUTPUT timeline: kept main content interleaved with заставки. `Clip = {kind, a, b (media time), titleId?, anchor?, out}`; `srcToOut`/`outToSrc`/`fullComposite`/`buildComposite`. |
| `src/lib/titles.ts` | Заставка library: `TitleAsset` metadata in IndexedDB (`kv:'title-lib'`), file bytes in `blobs:'title:<id>'` (titles are short), lazily opened + cached (`openTitle`). |
| `src/lib/db.ts` | IndexedDB `carver`: stores `projects`, `blobs` (`<id>:pcm`), `handles`, `kv` (checkpoints `ckpt:<id>`, `exportDir`). |
| `src/lib/profanity.ts` | Russian мат detector (ported from whisper-web), custom list compile (`*`, `/regex/`), `findProfanity` → word ranges, `maskWord`. |
| `src/transcribe/speech.worker.ts` | Whisper pipeline + wav2vec2 CTC (`ctcAlign` returns forced alignment AND greedy `heard` tokens with per-char times). |
| `src/transcribe/run.ts` | VAD, 5-min windows with 15 s overlap, loop guards, alignment groups with next-segment context, "squeezed" retry, edge snapping, `extra` tokens, paragraphs, checkpoints, model preloading (`loadModels`, shared in-flight promise). |
| `src/transcribe/fillers.ts` | Acoustic filler detection (voiced + spectrally steady + flat pitch, min duration by sensitivity) + wav2vec2 veto (consonants ⇒ real word). |
| `src/player/player.ts` | Preview: CanvasSink frames on output grid + AudioContext clock; per-segment gain fades; mute automation; playback rate. |
| `src/player/stretch.ts` | WSOLA pitch-preserving time stretch for 0.75–2× preview. |
| `src/lib/dsp.ts` | Block model of the processed sound (10 ms blocks, 1.25 ms compressor sub-blocks): phrase measurement, leveler breakpoints, compressor/limiter model, modelled LUFS, calibration (trim + make-up), exact `renderRange` / `ExactStream`. |
| `src/audio/live.ts` | `LiveMaster` (`S.live`): analysis cache, settings, model levels, exact tiles from the worker, exact samples for the zoomed-in view, settle-then-measure. |
| `src/audio/dsp.worker.ts` | DSP worker: one-pass analysis (loudness + K-energy + sub-block peaks), exact 60 s tiles of the visible range, exact whole-programme loudness. Jobs are prioritised and superseded. |
| `src/restore/*` | «Реставрация» (Sidon speech restoration): `frontend.ts` (w2v-BERT fbank features), `restore.worker.ts` (ONNX on WebGPU, HF → mirror download, Cache Storage), `engine.ts` (`Restorer` = `S.restorer`: model lifecycle, 10 s tile cache, preview plan, export plan, constant-power dry/wet). |
| `src/lib/leveler.ts` | Gain function from the stored breakpoints (`levelerFromPoints`) for the player and export. |
| `src/lib/masterchain.ts` | Master bus: soft compressor (user settings, default −4 dB, 4:1, 8/120 ms) + automatic make-up + look-ahead limiter at −3 dBFS (1.5 ms delay, compensated everywhere). |
| `src/export/render.ts` | MP4: WebCodecs H.264 (hardware) frame grid + AAC; AAC priming delay measured and compensated; streams to a file handle. |
| `src/export/audio.ts` | Shared sample-accurate audio renderer (join fades, mute envelope) + MP3 export + MP3 delay measurement. MP3 accepts only 8–48 kHz, so high-resolution sources are resampled on the fly (`mp3OutputRate`, `LinearResampler`); other outputs keep the source rate. |
| `src/lib/loudness.ts` | ITU-R BS.1770-4 loudness meter: K-weighting (coefficients re-derived for the actual sample rate), 400 ms gated blocks, short-term/LRA (EBU 3342), true-peak estimate. Streaming, one pass over the PCM. |
| `src/export/subs.ts` | Output-timeline text: SRT, JSON, plain, timecoded; optional masking of muted words. |
| `src/export/folder.ts` | «Сохранить всё»: directory handle (remembered), subfolder per project, file writes. |
| `src/llm/client.ts` | OpenAI-compatible client: streaming, retries, compat auto-adaptation, reasoning/thinking handling, `Phase` progress, `thinkingParams` per provider, `listModels`. |
| `src/llm/carve.ts` | AI carving prompt, transcript lines (`#<wordIndex> text`), quote → word range matching (`matchQuote`), confidence filter. |
| `src/llm/pipeline.ts` | Text pipeline steps (spelling → structured → chapters → theses → summary → YouTube → post → Shorts), map/merge for long texts. |
| `src/llm/phase.ts` | Human-readable status for in-flight LLM requests (waiting / thinking / writing / retry). |
| `src/fasttrack.ts` | Fast track orchestration (transcribe → мат mute → AI carve), wake lock, notification; also the older "walk-away" option. Hooks `S.afterTranscribe`. |
| `src/ui/*` | React components. `Editor` (layout, hotkeys), `TranscriptView` (virtualized), `Timeline` (canvas), `PlayerCard`, panels per side tab, `DropOverlay` (window-wide split drop), `ModelPicker`, `TaskInline`, `FastTrackCard`. `hub.ts` = non-React singletons (player, scroll-to-word, time listeners). |
| `public/sw.js` | Service worker: page network-first, `/assets/*` cache-first. Models are cached separately by Transformers.js. |
| `public/.htaccess` | Apache: `.wasm` MIME, cache headers. |
| `serve.mjs` | Local static server for `dist/`. |

## Data model and invariants

- `Word.kind`: `undefined` = Whisper word; `'extra'` = sound wav2vec2 heard but Whisper didn't write
  (shown `‹…›`); `'filler'` = «эээ/ааа/ммм» (`auto: true` if found acoustically — replaced on re-detection).
  Exports and LLM inputs skip or bracket non-Whisper tokens (`w.kind ? …`).
- `WS` (why cut): `Kept 0, Manual 1, Llm 2, Filler 3, Profanity 4`. Bulk actions must only touch their own
  reason (e.g. «Вернуть все» fillers resets only `WS.Filler`). `MU` (why muted): `None 0, Manual 1, Profanity 2`.
- Undo snapshots (`Snap`) contain `wordState`, `wordMute`, kept silences, range cuts, suggestion statuses
  and custom cut edges.
  **Any new per-word or per-project edit state must be added to `snap()`/`restore()`.** Operations that
  re-index words clear the undo stack.
- **Custom cut edges** (`project.edges`, `EdgeOverrides` in `lib/edl.ts`): every cut piece has an owner —
  a removed word run (`rs:<i>` / `re:<j>`) or the k-th pause cut in the gap after word g (`gs:<g>:<k>` /
  `ge:<g>:<k>`). `buildEdl` merges pieces into groups, applies overrides to each group's outer edges, then
  returns `edl.regions` (= `removed` with owner keys, `autoA/autoB`, `custom`). Overrides are absolute
  times: no automatic setting may move them; they persist while their cut is off; they are keyed by word
  index, so they are re-keyed in `mergeFillers` (`remapEdges`) like every other index-based state.
  Regions never overlap: `edgeLimits` keeps ≥ `cut.minKeep` between neighbours.
- `buildEdl`: a run of removed words is cut **together with the pause after it** (so the pause before the run
  becomes the pause before the next kept word — natural rhythm). Silence cuts never clip kept words
  (`protect` ranges). Kept slivers `< cut.minKeep` are dropped.
- Persistence: project JSON in IndexedDB, autosave debounced 300 ms and flushed on `visibilitychange`/`pagehide`.
  PCM cached as a Blob so reopening doesn't re-decode. Source file must be re-linked (handle permission).
- localStorage keys: `carver:prefs`, `carver:llm`, `carver:carve`, `carver:pipeline`, `carver:export`,
  `carver:profanity` (last-used мат lists — new projects inherit them), `carver:modelsReady:<model>`, `carver:device`.
- Task system: one `S.task` at a time (`kind`, `frac`, `text`, `cancel`). Top bar shows it; `TaskInline`
  shows it next to the button that started it. Long operations must report progress and be cancellable.

## Feature notes (things that are easy to break)

- **Audio-only sources** (plain audio, no video): the source pickers accept MP3/M4A/M4B/AAC/WAV/FLAC/OGG/Opus
  (`MEDIA_ACCEPT`/`MEDIA_TYPES` in `ui/hub.ts`, `pickMedia`); `openMedia` allows a null video track and stores
  `MediaMeta.hasVideo = false` (`mediaHasVideo()` also derives it for older projects from `videoCodec`). Editing,
  transcription, the waveform, loudness and Реставрация are media-agnostic. The player paints a black 16:9 canvas
  (`Player.paintBlack`). Such a project never exports MP4: `runExportMp4`/`renderMp4` guard on `S.media.video`,
  the Export panel hides the MP4 and XML sections, «Сохранить всё» ignores the remembered video checkbox, and the
  batch `video` stage is marked skipped on add. The «Заставки» tab is hidden (they are a video feature). MP3
  export is the same sample-accurate renderer; sources above 48 kHz (96/192 kHz WAV/FLAC) are linearly resampled
  to 48 kHz because LAME rejects them — verified 96k/192k WAV exports are sample-aligned with the 48 kHz export
  (correlation 0.9999) and 8/11 kHz mono, 192 kHz, MP3, M4A, AAC, FLAC and OGG all export.
- **Transcription accuracy.** Whisper's segment timestamps can drift by seconds. `alignGroup` therefore starts
  3 s early, aligns with the next segment's text as context (context words dropped), detects "squeezed"
  alignments (>26 letters/s over 8 words, or 4+ zero-score words) and retries with a wider window or merged
  groups. Don't use `TimeMap.span` for segment extents (it squeezes segments that straddle removed silence).
- **Word edges**: wav2vec2 gives character spikes; `snapEdges` widens to real onsets/offsets on a 2 ms envelope,
  then overlaps between neighbours are split at the midpoint.
- **Fillers**: candidates only in gaps between Whisper words; a single consonant at an edge is tolerated
  (neighbour bleed); thresholds per sensitivity were tuned on the real video (23 / 50 / 60 found on 31 min).
- **Export sync**: MP4s written here have no edit list, so encoder priming would delay audio. `measureAacDelay`
  (Apple AAC = 2112 frames) and `measureMp3Delay` (≈1105) measure it with a tone burst; audio is fed that many
  frames early and padded at the end. Removing this reintroduces ~44 ms A/V offset.
- **Video frames** are taken at the middle of each output frame interval mapped to source time; verification
  tolerance is ±1 frame.
- **Mute** in preview = gain automation per segment; in export = envelope with `fadeMs` half-cosine ramps outside
  the region; `marginMs` widens the word. Subtitles can mask muted words (`и***`).
- **Hotkeys** (`Editor.tsx`): Space play/pause, Delete/Backspace/x cut-toggle, **`e.code === 'KeyM'`** mute-toggle
  (use `e.code`, not `e.key`: the user types on a Russian layout), ⌘Z/⇧⌘Z. With a word selection, ←/→ move by
  word and ↑/↓ move to the visual line above/below like a text caret (`hub.lineTarget` in `TranscriptView`:
  measures rendered word rects, keeps a sticky goal column; Shift extends); arrows never scroll the page then.
  Without a selection arrows scroll natively. e2e step: `linenav`.
- **Playhead while paused** (`Player.parked`): `seekSrc()` parks the playhead at an exact SOURCE time even
  inside a removed fragment, so «выделение следует за воспроизведением» (Opt+F) can select a cut word
  instead of being pushed out to the next kept frame. `play()` maps the parked time to the next kept frame
  and starts there; `seek(out)` clears it. Never "fix" a seek by snapping it in `seekSrc` — that brings the
  bug back.
- **Caret** (`TranscriptView`, `.caret`): a blinking 2 px bar at the moving end of the selection — after the focus
  word, or before it when the last move went backwards (`hub.caretBack`, set by ←/↑ and backward drags/shift-clicks).
  Positioned in a layout effect from the rendered word rect on every render; solid for 0.5 s after each move, then
  blinks; dimmed (`.idle`) while a waveform region owns the arrows. e2e step: `caret`.
- **LLM carving** asks the model to QUOTE text to remove, never to return indices; quotes are fuzzy-matched back
  to word ranges near the stated line. Suggestions carry `confidence`; per-strength minimum applies.
- **Texts tab**: every step has «✎ Редактировать» (enabled only once a text exists) → full-screen
  `ui/TextEditor.tsx` with a large textarea and a collapsible prompt. ⌘S/Ctrl+S saves the text and the prompt
  into the project (capture-phase handler; the page is never saved) and in a workspace forces a server push
  (`S.forceWorkspaceSave`, one retry after `409 STALE_REVISION`). Prompts are **project state**
  (`project.prompts`, applied via `projectSteps(loadSteps(), project.prompts)`), so editing one project's prompt
  never changes another's; «Сбросить запрос» falls back to the global/preset prompt. Test: `tests/text-editor.mjs`.
- **«Заметки редактора»** (`ui/ProjectNotes.tsx`, `project.notes`): a per-project note under the batch journal row,
  collapsed while empty and open when it has text (also opens when a note arrives from someone else). Saved with
  a 700 ms debounce, on blur and on unmount, into IndexedDB; in a workspace it is pushed as a **notes-only**
  `PATCH /projects/:id/notes`, so a stale full-project save cannot overwrite the rest of the project. The edit is
  possible without opening the project (the batch table is not an editor). Test: `tests/project-notes.mjs`.
- **Workspace sync is manifest-first**: the 5 s poll calls `GET /api/workspace/manifest` (~1 KB: id/revision/updatedAt
  per project, locks, tombstones) and downloads `GET /api/workspace/projects/:id` only when that revision was not
  applied yet. Applied revisions live in IndexedDB `kv` as `ws-revisions:<workspaceId>`, so a reload costs one
  manifest. Never poll the full `/api/workspace/` from the client: it is megabytes (it once pulled 5 MB every 5 s
  and made the app look offline). Test: `tests/workspace-poll.mjs`. nginx needs `gzip_proxied any` for these
  responses to be compressed.
- **Workspace leases vs deletion**: `DELETE /projects/:id` removes a project, `DELETE /projects/:id/lock` only
  releases the lease — the route requires the bare path (`parts.length === 4`). A regression once made every lock
  release delete the project (and leave a tombstone), so closing an editor or a queue item wiped it for everybody;
  `tests/workspace-concurrency.mjs` now covers both directions.
- **Workspace admin** (`server/workspace-server.mjs`, Basic Auth): `GET /admin` is a small page listing every stored
  workspace with project/lock counts, size and its login link, plus create / duplicate / delete. Duplicate
  (`POST /admin/workspaces/:id/duplicate`) gives the copy a new id and token and **new project ids** re-stamped with
  the new `workspaceId`, so edits in the copy never touch the original; locks and tombstones are not copied. Admin
  routes are checked before the workspace API and require the admin credentials. Tests: `tests/admin-workspaces.mjs`
  (API + auth + traversal), `tests/admin-ui.mjs` (buttons and stats in Chrome).
- **Folder relink** («📁 Папка с исходниками…» in the batch panel, `B.relinkFolder`, `src/lib/relink.ts`): restores
  the source of every queued project from one picked folder — like Premiere's relink. Matching requires the same
  byte size, then the name (case-insensitive), then `lastModified`, so renamed copies are found; ties are reported
  as ambiguous instead of guessed. A parent folder cannot be derived from a single picked file (no path in the web
  APIs), hence the directory picker. Tests: `tests/relink.test.ts`, `tests/relink-folder.mjs`.
- **Workspace isolation** (`src/lib/scope.ts`): a project is either local (`workspaceId` absent) or belongs to exactly
  one workspace. A tab opened with `?workspace=` shows **only** that workspace's projects (a loading card until the
  first sync, never the local list); a tab without the token shows **only** local projects. The batch queue is stored
  per scope (`batch-queue-v1:local` / `batch-queue-v1:ws:<id>`; the old single key is migrated by filtering its ids)
  so pruning one mode never deletes the other's queue. `S.saveNow` only pushes a project whose `workspaceId` matches
  the tab's workspace, so opening a local project inside a workspace tab never merges it into the workspace.
  Creating a project while the workspace is still loading is refused instead of silently going local.
  Test: `tests/workspace-scope.mjs`.
- **Thinking models**: reasoning streams in `reasoning_content` (DeepSeek) or `reasoning` (Ollama/OpenRouter) or
  inline `<think>`. The UI shows «модель размышляет · N симв.». The «Размышления модели» setting sends
  provider-specific params (`thinkingParams`). Ollama `/v1` ignores `think:false` and `reasoning_effort:'low'`;
  `reasoning_effort:'none'` works.
- **Fast track**: drop on the right half of the window (or the ⚡ card on Home). Steps persist in
  `project.fastTrack`; if the tab closes after transcription, it is marked as interrupted (cannot auto-resume).
  Strength default is `careful` — the user asked for "STRICT"; interpreted as conservative (not yet confirmed).
- **Waveform editing** (`Timeline.tsx`): click a red region → handles; drag (pixel-snapped), ←/→ nudge one
  pixel (Shift ×10), Tab switches handle, Esc deselects, double-click resets that region only. The key handler
  is a window *capture* listener so it pre-empts the editor's word-selection arrows while a region is selected;
  clicking in the transcript clears `S.cutSel`. Below 12 ms/px the canvas draws the actual samples from the
  16 kHz PCM (soft-log amplitude) instead of 10 ms levels; zoom goes down to 1 s across (~1 ms/px). Selecting a
  region parks the playhead 1.5 s before it — no auto-play (user's choice). Test hook: `window.__carverTimeline`.
- **Zoom / scroll input** (user spec): the app page never zooms. A Mac trackpad pinch arrives as `wheel` with
  `ctrlKey` — `main.tsx` cancels ctrl+wheel and ⌘=/⌘− globally (⌘0 is left to the browser to reset an old page
  zoom). Over the waveform: pinch → zoom around the cursor; any two-finger/mouse scroll → pan (never zoom).
  Elsewhere scrolling is native. Waveform zoom also via −/+ buttons and ⌘−/⌘= (around the playhead). The waveform
  wheel listener must be a native `{ passive: false }` listener — React's `onWheel` is passive and cannot stop
  Chrome's page zoom. `overscroll-behavior: none` disables swipe-back. e2e step: `zoom`.
- **Colours of edits** (user choice): hand/automatic cuts red; cuts made by the AI violet-blue (`--ai` #8c84ff;
  `.w.rm.llm`, pending suggestions `.w.sg`; waveform regions whose cut words are all `WS.Llm` via `regionKind` in
  `Timeline.tsx`); filler sounds orange; muted words dark grey.
- **Заставки** (composite timeline, `src/lib/composite.ts` + `src/lib/titles.ts`): short intro/outro/header
  videos from a user library, inserted at the playhead. A `TitleInsert = {assetId, anchor (main SOURCE time), a, b
  (asset trim points)}`. `buildComposite` splits the kept main segment at the anchor and interleaves title clips; it
  does not consume source time, but shifts everything after it in output. The waveform axis stays in SOURCE time, so a
  title renders as a fixed-width GREEN marker centered on its anchor (width ∝ trimmed fraction), not to scale. Selecting
  it shows handles that trim its own in/out points (left handle = `a`, right = `b`); Delete removes it, double-click
  resets to the whole asset. Insertion is only allowed while the playhead is inside a kept segment (anchors in removed
  gaps are skipped). Exports and the player decode each clip from its own source; title frames are scaled to the main
  size (`fit:'contain'`), title audio is decoded+resampled once (titles are short). Subtitles / timecoded text use
  `composite.srcToOut`. Test hook `#carver-title-input`; e2e step `titles`.
  A title is also a green ▶ chip in the transcript at its gap (`data-title`, gap = last word with `end ≤ anchor`); clicking a
  заставка inserts at the text caret (before/after the focused word via `hub.caretBack`, else at the playhead). e2e step `titletext`.
- **Заставки must be decodable** (`titles.ts`, `assertDecodable`): WebCodecs has no ProRes, so a ProRes `.mov`
  used to fail deep inside the export as "This video track cannot be decoded in this environment". The file is
  now rejected on add *and* on `openTitle` (preview/export) with a Russian message naming the codec, and
  «↻ Заменить файл» swaps the bytes behind an existing asset while keeping every insertion. Convert with
  `avconvert --preset Preset1920x1080 --source in.mov --output out.mp4` (macOS built-in, no ffmpeg needed).
- **Loudness (Аудио tab)** (`src/lib/loudness.ts`, `AudioPanel`): integrated LUFS via BS.1770-4, compared with
  the YouTube target (−14 LUFS ±1, true peak ≤ −1 dBTP). Measured on the 16 kHz mono PCM the app already has,
  so wide stereo can read 1–3 dB low and the true-peak estimate is a floor — both caveats are shown in the
  panel. Verified against pyloudnorm: −25.70 vs −25.70 LUFS on a 798 s file, −23.09 vs −23.08 on a 1 kHz sine.
- **Loudness processing is PROJECT STATE and LIVE** (`S.live` = `LiveMaster`, `src/lib/dsp.ts`, `src/audio/dsp.worker.ts`;
  persisted as `project.master`). Nothing renders the whole recording except the export. Pipeline:
  1. **Analysis, once per PCM, in the worker**: BS.1770 meter + K-weighted energy per 10 ms block + sample peak per
     20-sample sub-block (1.25 ms). 1.5 h ≈ 2 s. The RMS grid is the app's `levels`.
  2. **Block model, on the main thread, ~100 ms for 1.5 h**: phrase gains (only inside pauses, capped by the variant)
     → compressor envelope over sub-block peaks (`COMP_DUTY` 0.22) → look-ahead limiter model (60 ms hold) →
     modelled LUFS. `calibrate` solves the leveler trim (secant), then automatic make-up after the compressor (≤ 12 dB `MAX_MAKEUP_DB` with phrase leveling, ≤ 30 dB without)
     so the target is reached after the chain; `bias` = exact − model from the last exact measurement.
     Fitted against the exact chain on the 1.5 h test file: block error 0.13–0.52 dB mean, loudness 0.1–0.4 dB.
     The model is what the timeline draws when zoomed out (`S.levelsView`).
  3. **Exact, in the worker**: 60 s tiles of the visible range (1 s pre-roll) replace the model tile by tile;
     below 12 ms/px the Timeline renders the visible samples exactly on the main thread (`live.samples`).
  4. **Exact loudness after settle**: 400 ms after the last change the worker measures the whole processed programme
     (~3 s). The Аудио tab shows «≈» + «уточняю…» until then. If the exact value misses the target by > 0.1 LU (was 0.25),
     the model is re-aimed with the new bias (≤ 2 times).
  **Phrase leveling is a setting, OFF by default** (`prefs.phraseLeveler`, ⚙ «Звук» → «Выравнивание громкости по
  фразам», `S.setPhraseLeveler`; stored per project as `master.opt.leveler`). Off ⇒ flat 0 dB curve (`curve: []`),
  only compressor + make-up (≤ 30 dB, `MAX_MAKEUP_DB_COMP_ONLY`; was 24 — «Агрессивно» needs more); the Аудио tab has no variant section then (meter + compressor; a single
  «Включить обработку» button if processing is off). On ⇒ the four variants
  below. A project saved with the other setting is re-solved on open.
  **Aim / «Усиление звука»** (⚙ «Звук», `prefs.gainMode`, `GAIN_MODES` in store): Агрессивно = aim exactly at the
  target, compressor −10 dB 5:1; Средне (default) = target − 0.9, −5 dB 5:1; Мягко = target − 1.3, −4 dB 4:1.
  `aimLufs()` uses the OPEN project's mode (`master.mode`, persisted; old projects = 'medium'), else the app setting.
  The app setting is used by the next new project's automatic processing; opening a project never changes it (the
  Settings tab shows «В открытом проекте — …» + «Применить … здесь»). `S.setGainMode` in an open project changes only
  automatic parts: the make-up aim (if «авто») and the compressor unless `master.compManual` (set by any compressor
  slider; cleared by «Сбросить компрессор» = `S.resetCompressor`, which returns to the mode's preset + auto make-up).
  Test: `tests/gain-mode.mjs <video>`.
  **Make-up** (slider «Компенсация» 0…30 dB + «авто»): `master.makeupAuto === false` ⇒ `makeupDb` is fixed by the user
  (`S.setMakeup` / `setMakeupNow(null)` = auto), `calibrate(..., fixedMakeupDb)` skips the search and the target re-aim.
  **«Приглушение тишины»** (before the compressor; `master.duck` = depth/attack/release, default −5 dB / 30 / 30 ms): quiet
  stretches under the silence threshold (`S.duckRegions`, cached) get an envelope that starts AT the stretch start and
  is back to 0 dB AT its end (`duckPoints`); summed with the leveler curve into `master.full` — every consumer
  (model, tiles, player, export, exact) must use `full`, never `curve` (= leveler only, the persisted part).
  Timeline: bar HEIGHT = processed sound, grey «тишина» colour = RAW `S.levels` vs the threshold (user spec).
  The Аудио tab is usable as soon as the PCM exists — also DURING transcription (phrases from pauses until the
  transcript is complete, `S.phraseSource`).
  Variants («Сильно/Просто/Немного громче», «Не обрабатывать») apply on click; compressor sliders (порог, степень,
  атака, восстановление) are coalesced per animation frame. Measured: slider → redrawn waveform 115 ms median at any
  zoom. `autoMaster()` still runs before transcription (now ≈ 2 s instead of 122 s on 1.5 h). Player: `setMaster`
  + `refreshAudio()` crossfades (20 ms) into the new sound ~0.1 s after a change while playing. Export: the
  same curve + `{...comp, makeupDb}` + ceiling (`ExportPanel.masterOptions`); the limiter's 1.5 ms latency is
  trimmed at the start and flushed at the end. Measured: MP3 −14.53 LUFS vs meter −14.56, 0 samples above −1 dBFS.
  Old `pcmMaster`/`levelsMaster`/`BusyOverlay` are gone. Test bench: `tests/audio-dsp.mjs` (steps fresh, import,
  apply, accuracy, live, play, persist, export); unit test `tests/masterchain.test.ts`.
- **Реставрация** (`src/restore/*`, `S.restorer`, `project.restore` 0…100 step 20, Аудио tab): Sidon v0.1 ONNX
  (`soniqo/Sidon-ONNX` @ a6dce24: **fp16 predictor + fp32 vocoder** — the fp16 vocoder outputs near-silence on
  WebGPU; don't "optimise" it back). Rules from the user: the model is NOT loaded at 0 %; it never blocks — while
  `S.task` runs nothing downloads/renders (status + toast «включится, когда закончится текущая операция»), the
  export is the only exception; only tiles ahead of the playhead are rendered (60 s along the kept segments); the
  whole recording is rendered only by the export (`withRestore` in `ExportPanel`). Download: Hugging Face first,
  then `./models/soniqo/Sidon-ONNX/resolve/main/…` (mirror, `deploy/sync-models.mjs`), cached in Cache Storage
  `carver-sidon-v1`. The mix happens FIRST in the chain — before the gain curve (leveler + ducking) and the
  compressor, in `Player.processBuffer`/stretched path and in `streamAudioComposite` (user: never restore squashed
  sound). Tiles are loudness-matched to the dry signal (so the loudness model stays valid), the wet signal is
  read 7 ms later (Sidon's constant lag) and mixed with constant power (`restoreGains`: wet is phase-incoherent).
  Without a rendered tile the player plays dry and crossfades in when it arrives (`restoreRev`). Bench:
  `tests/restore.mjs` (steps open, gate, load, preview, play, export; `--block-hf` tests the mirror,
  `--clear-cache`). Test hooks: `S.restorer` (status, cached, stats), `__carverPlayer.restoredBuffers/dryBuffers`,
  `window.__carverRestoreEp = 'wasm'` forces the WASM backend.
- **The meter always describes the timeline**: `S.audio` is the exact measurement of what is on the timeline (the
  original, or the processed programme from the worker); between a change and the exact value the panel shows the
  model prediction with «≈». «Не обрабатывать» restores `S.audioBase`.
- **Completion chime** (`src/notify.ts`, `src/lib/chime.ts`): one synthesized jingle (Web Audio, system volume)
  when the whole queue is done — busy = `S.task` set or a fast track running; the chime plays after 2.5 s of
  continuous idle following ≥ 12 s of busy time, never between chained steps, never after «Стоп»; error variant if
  an error toast appeared. «🔔 Звук / 🔕 Без звука» in Settings (`prefs.sound`). The AudioContext is created on the
  first user gesture so it may play later from a background tab. Test hook `window.__carverChime` (`cfg`, `log`,
  `scheduleJingle`); e2e step `chime`, and `fasttrack` reports the chime count (expected: exactly 1).
- **Drop handling** is global in `DropOverlay.tsx` (window listeners). Don't add drop handlers to other components.
- **«Подсказки к приложению»** (⚙ «Интерфейс», the first Settings tab; `prefs.hints`, default **false**): every
  explanatory grey text carries the class `tip` and is hidden by `html:not(.tips-on) .tip` (styles.css);
  `savePrefs` toggles `tips-on` on `<html>`. Mark NEW instructional texts `hint tip` (or `dim tip`); keep status/data
  texts (export size, AI reasons, fast-track progress, GPU status, folder name) without `tip` — they must always show.
  The «Интерфейс» tab also holds the chime, scrub and «Выделение следует за воспроизведением» settings; the gear
  opens it (`S.openSettings('ui')`).
- **CPU fallback is visible, not silent** (user request 2026-10-28, after a new Mac started Whisper on the CPU with no
  sign of it): the worker's `load` returns `{ device, dtype, pref, why }` (`why` = «выбрано в настройках» / no adapter /
  «не удалось запустить модель на WebGPU: …»), `run.ts` keeps it as `lastAsr`, and `S.task.asr` carries it while a
  `transcribe` task runs. `TaskBar` then shows ⚠️ next to the progress bar (`[data-cpu-warning]`); hover/focus opens
  `.cpuwarn-pop` with the reason and «Изменить на WebGPU» (`S.switchToWebGPU()`): it writes `prefs.device='webgpu'`,
  and if a transcription is running it aborts it (`restartAsr` flag in `Store.transcribe`'s catch → restarts, resuming
  from the checkpoint) after `disposeSpeechRPC()` (a dead RPC now rejects immediately, and `ctcAlign` re-throws
  AbortError so an abort is never mistaken for an alignment failure). The button is **disabled, not hidden**, when
  `webgpuAvailable()` (`src/lib/gpu.ts`) says the page has no adapter. `gpuInfo()` re-asks for an adapter once after
  700 ms: on a fresh profile/machine the GPU process may still be starting, which is the likely cause of the reported
  bug. ⚙ «Распознавание речи» → «Диагностика видеокарты» (`<details data-gpu-diag>`) prints `gpuDiagnostics()`: UA,
  platform/arch, hardwareConcurrency/deviceMemory, WebGL renderer, and for BOTH the page and a real worker the
  adapter info/features/limits/requestDevice result — the worker matters because that is where Whisper runs. Test:
  `node tests/cpu-warning.mjs "<video>"` (real CPU run → ⚠️ → switch → GPU; then a stubbed `navigator.gpu` for the
  disabled state).

## Testing

Always: typecheck → unit tests → build → e2e against preview → numeric verification. Look at screenshots
(`$TMPDIR/carver-test-out/*.png`) with an image viewer tool; UI regressions are visible there.

`tests/e2e.mjs <video> --steps=a,b,c [--url=…] [--llm=model] [--sens=low|normal|high] [--matwords=…]`
Steps run **in file order**, not in the order given:

| Step | What it does |
|---|---|
| `firstrun` | Clears "models ready" flag, checks first-run model download UI. |
| `fasttrack` | Synthetic drag over left/right half, drop right, waits for the unattended run, checks model picker and inline AI status. Needs Ollama. |
| `llmstatus` | AI carving with thinking `auto` vs `off`, records status-text phases, runs the connection test. Needs Ollama. |
| `open` | Opens the video via the hidden `#carver-file-input`, waits for audio extraction. |
| `reopen` | Opens the saved project whose name matches the video file name, re-links the file. |
| `probe` | Prints level percentiles / silences (debug). |
| `transcribe` | Waits for transcription AND filler scan; prints first words. |
| `edit` | Selects words 5–9, Delete, undo, redo. |
| `seamless` | Plays 40 s where cuts are densest; reports fps / late frames. |
| `aligndebug` | Runs forced alignment on a range (`--range=a,b,firstWord,lastWord`). |
| `fillers` | Re-runs filler detection at `--sens`; dumps `fillers.json`. |
| `rate` | Plays at 2 / 0.75 / 1.5 / 1× and measures advance per wall second. |
| `play` | Short playback smoke test. |
| `export` | Exports MP4 into an OPFS file (via `__carverTestHandle`), downloads it, writes `segments.json`. |
| `ai` / `texts` | AI carving / text pipeline with local Ollama. |
| `subs` | Downloads SRT/JSON/timecoded text. |
| `mat` | мат tab: invalid regex reporting, «Почистить мат», hotkey M, per-hit treatment. |
| `titles` | Upload `glvrd-intro-clean.mp4` (passed as a `--steps` arg), insert at the playhead, trim, delete, time mapping, composite export; PSNR-checks the title frame and a post-title main frame. |
| `linenav` | ↑/↓ land on the adjacent visual line nearest the column, round trip through short lines returns to the start word, Shift+↓ extends, first line stays. |
| `caret` | Caret hidden without selection, after the word on click/→/↓, before it on ←, blinks after 0.5 s, dimmed while a waveform region is selected. |
| `chime` | Offline render of the jingle (length, level), then: one chime after a chain of steps (none in between), none for short operations, none after «Стоп», error variant, none with «Без звука». |
| `cutedit` | Waveform cut handles: wheel zoom to ~1 ms/px, click a region, drag a handle, ←/→/Tab nudges, cut off/on keeps custom edges, no-overlap clamp, double-click reset, undo, custom edge survives threshold/padding changes. Resets the project's edits first. Run `export` after it to verify cut points. |
| `saveall` | «Сохранить всё» into an OPFS dir; writes `mutes.json` at save time; downloads `all.mp4/mp3/srt`. |
| `persist` | Edit then instant reload — edit must survive. |
| `offline` | Service worker serves the app offline. |

Verification scripts (Python, numpy):
- `tests/verify_export.py source export.mp4 segments.json` — sampled frames match source at mapped time
  (±1 frame), audio lag ≈ 0 ms.
- `tests/verify_mute.py all.mp4 all.mp3 mutes.json` — same length, MP3 sample-locked to MP4 audio, muted
  regions silent in MP3 and audible in MP4 (for the `videoMute=false, audioMute=true` scenario).
- `tests/llm-timing.ts <baseUrl> <model> [key] [extraBodyJSON] [limitSec]` — phase timings of the real
  carving request (first byte / first reasoning / first content).

Helpers: `tests/dump-project.mjs "<name>" out.json` (export a saved project from the test profile),
`tests/list-projects.mjs`.

Test hooks in the app (keep them; tests depend on them): `window.__carver` (store), `window.__carverDebug`
(`getSpeechRPC`, `pcmSlice`, `srcToOut`), `window.__carverPlayer` (stats: drawn, late, maxGap),
`window.__carverTestHandle` (export file handle), `window.__carverTestDir` (save-all directory),
`window.__carverNoPicker`, `window.__carverTimeline` (view state: `v0`, `span`, `W`, `drawnRev`, `draws`),
`__carverDebug.exactLevels()` / `measureFile(file)` (audio-dsp bench), `__carverPlayer.refreshes`.

A 2.5-min clip for fast tests: `ffmpeg -ss 600 -t 150 -i "test video.mp4" -c copy "$TMPDIR/carver-clip.mp4"`.

## Pitfalls that actually happened in this project

1. Running e2e against `npm run dev`: HMR reload restarted the page mid-transcription. Use the preview build.
2. Verification data captured *before* the final edit produced a false failure (mute regions of a hit that was
   later switched to «вырезать»). Capture expected values at the moment of export.
3. Headless Chrome auto-dismisses `confirm()`; linking a different file triggers one. Tests accept dialogs or
   pick the matching project.
4. Node can import only leaf `.ts` modules from `src/` (app modules use extensionless imports). Unit tests target
   `profanity.ts`, `stretch.ts`, `masterchain.ts` and `restore/frontend.ts`; for others, test in Chrome. Node
   strips types only, so such leaf files must not use TS parameter properties (`constructor(private x…)`).
5. TypeScript 7 typed-array generics: `Float32Array<ArrayBufferLike>` is not assignable to
   `Float32Array<ArrayBuffer>` (WebAudio APIs) — annotate or cast at the boundary.
6. Disabling LLM thinking by default looks like a speed fix but makes small models cut whole meaningful sentences.
   Measured; keep `auto` as default and make waiting visible instead.
7. Alternating two Ollama models costs ~14 s per swap (model reload). Use one model in tests.
8. `file://` shows a blank page — it is not a build bug.
9. Users may run an old build from the service worker cache: hard reload (⌘⇧R) after deploying.
10. Filler detection originally rejected real «эээ» because wav2vec2 emitted a neighbouring word's consonant;
    only interior consonants veto a candidate now.
11. LLM parameter adaptation raced with parallel requests: the first 400 («temperature not supported», from a
    router that maps Claude models) set the shared compat flag, and the second in-flight request then
    failed instead of retrying. `chatComplete` now adapts based on what *that* request sent (bounded to 6
    adaptations). Test LLM changes with `parallel ≥ 2` and a multi-chunk transcript, not only the
    single-request connection test.
12. `page.evaluate(() => store.transcribe())` **awaits the returned promise** — the test then hangs until the whole
    transcription is done (it looked like a 27-min stall, 2026-10-28). Never return a long app call from a test;
    use `page.evaluate(() => { void store.transcribe(); })` and poll the store instead.
13. Piping a long e2e/bench run through `tail`/`grep` buffers everything until the process exits, so a stuck run
    shows nothing. Redirect to a file (`> $TMPDIR/run.log 2>&1`) and read it with `tail`. Same for `console.log`
    in a long Node script — `process.stdout.write` is safer for incremental output.
14. A hover-only popup must not hang off text whose width changes: the topbar status text grows/shrinks every tick
    («… 35% · осталось ≈ 3 мин»), which slid the ⚠️ sideways and closed its card under the pointer. `.tasktext`
    has a fixed width now. When adding a hover card, verify with `elementFromPoint` that its button is hit-testable.
15. A `navigator.gpu` stub for a test must be installed with `page.addInitScript` (survives `page.reload()`);
    `page.evaluate(() => Object.defineProperty(...))` is wiped by the reload and the stub silently does nothing.
16. A popup/`display:none`-until-hover element cannot be clicked by Playwright from cold: hover the anchor first
    (the actionability check runs before the mouse moves), and re-hover right before the click.

## Decisions you must not undo without asking the user

- Remove-only editing (no reordering, no multi-source).
- Identical cuts and identical length for every output; muting is the only per-output difference.
- Local-first: the video never leaves the machine; only transcript text goes to the user-configured LLM.
- Static hosting on generic virtual hosting (no Node/PHP on the server); relative `base: './'`.
- Russian UI and Russian alignment model (wav2vec2-large-xlsr-53-russian).
- Exports stream to disk (File System Access API); in-memory fallback only with a warning.
- Thinking default `auto`; fast-track strength `careful` (pending user confirmation of "STRICT").
- Loudness: measurement (LUFS/TP), automatic processing (compressor, make-up, silence ducking, look-ahead limiter,
  optional phrase leveling) with live manual controls, and Реставрация exist; EQ and other manual controls are
  still deferred.

## Project conventions and expectations

- The product owner writes in English or Russian; answer in the language of the message. UI copy is Russian.
- Wants concrete, verified results: measure (timings, frame/audio checks, screenshots) before claiming success,
  and report numbers.
- The app must work on generic static hosting. The primary target is Chrome on Apple Silicon / WebGPU GPUs;
  test on the built app, not only in a unit test.
- Typical recordings: ≤1.5 h, 1080p30 H.264, up to ~10 GB/h, Russian monologues, already denoised/compressed.
- For deployment, use placeholders in docs and environment variables for hosts/credentials. Never put a real
  server address, workspace link or password in the repository.
