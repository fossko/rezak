# Sequential batch processing

The Home screen is a four-column project table: filename/actions; source → output duration
and reduction; colored processing-stage icons; result download. Queue processing keeps this
table visible and uses exactly one active Store project at a time. It does not open each editor.

## Restoring lost sources («Папка с исходниками…»)

The browser never gives the app a file's path, and a `FileSystemFileHandle` cannot reveal its parent
directory, so the app cannot infer a folder from one picked file. Instead, the queue asks for the
**folder**: «📁 Папка с исходниками…» opens the directory picker, scans it recursively (up to 4
levels, 5000 files) and gives every project in this queue back its source.

Matching (`src/lib/relink.ts`, `planRelink`): the size must match exactly, then the file name
(case-insensitive), then the modification time — so a renamed copy is still recognised. If two files
fit one project equally well, nothing is guessed: the project is reported as ambiguous and can be
linked by hand with «Выбрать исходник». A file with a different size is never attached. Handles are
stored, so the queue runs later without asking again. Test: `tests/relink.test.ts` (matching) and
`tests/relink-folder.mjs` (scan, verify, persist).

## Notes per project («Заметки редактора»)

Under the project's journal row there is a notes block: collapsed while empty («Показать заметки»), open when the
project already has a note. Typing saves into the project (debounced 700 ms, also on blur and when the block is
removed); in a workspace the note is shared with everyone and sent as `PATCH /api/workspace/projects/:id/notes`,
which touches only the notes field. Editing notes never opens the project, so it does not take the editor lock.

## Defaults and use

1. Open «Настройки» beside the queue controls, if necessary.
2. Select multiple videos with «Добавить видео». The current settings are copied into each new
   project, and the choice is remembered in this browser for the next session.
3. Click «Запустить очередь» and keep the tab open, the computer powered and awake.
4. Review projects, then use «Скачать результаты» / «Скачать все результаты» to select a folder.

The settings are shared by the whole queue. While the queue is idle, changing a stage checkbox,
strength or loudness target also updates every queued file that has not finished yet: a switched-off
stage becomes `skipped`, a switched-on stage becomes `pending`, and completed stages keep their
results. This is what makes disabling «Тексты» authoritative even when individual text steps were
checked earlier or when the files were added before the switch was turned off. The queue is not
reconfigured while it is running, so a change always applies at a safe boundary. Running a file
that already started keeps the settings it started with.

Defaults:

- Required extraction, silence threshold and automatic loudness preparation; target **−14.9 LUFS**,
  the existing recommended lower boundary with a 0.1 LU margin. Existing automatic processing
  only applies gain when the source needs it; it is not an unconditional loudness replacement.
- Transcription using the configured Whisper model. Queue always tries automatic GPU selection,
  even if the interactive app's last device preference was CPU.
- Existing acoustic filler detection/removal. This is the existing «эээ/ммм» detector, not a
  blanket deletion dictionary for meaningful words such as «ну» or «вот».
- Conservative («строго» / careful) AI carving; obvious unwanted material only.
- Text generation: spelling, structured text, chapters with output timecodes. Other configured
  text steps can be enabled. Model prompts are copied with the selection.
- **No automatic video export.** Its icon stays pending until an actual user-requested successful
  MP4 export (standalone or explicit Save All with video). XML/text downloads never mark it done.

Dependent stages require transcription. Requests to the LLM are also sequential for a queue;
provider credentials stay in memory/local settings, not in project JSON. Each chat request has
an upper bound of 15 minutes including retries/streaming, preventing an abandoned connection
from holding the queue forever. Provider rate-limit/network retry handling remains enabled.

## State and recovery

- Every file becomes a separately saved project before processing starts.
- `Project.batch` holds copied stage settings, per-stage status/timestamps/error, text-step
  statuses, and GPU warnings. `Project.transcription` keeps the unedited transcription result.
- PCM is cached by project in IndexedDB; existing project fields keep audio processing,
  transcript, cuts, suggestions and each finished LLM text. Output duration is saved for the table.
- Each stage is awaited and explicitly saved before the next starts. Intermediate successful
  text steps are saved separately. A failed project does not prevent later files from running.
- «Повторить» requeues failed/interrupted stages, leaving completed stages/results alone. The
  current shared settings still win: a stage switched off while the project was failed stays skipped.
  «Стоп» cancels the current work and prevents the next file from starting; it does not delete
  previous results. Starting again continues unfinished work.
- Reload does not automatically start processing. Running stages are recovered as interrupted.
  For files whose PCM was already saved, later stages can resume without rereading the video.
  Otherwise a persisted file handle needs read permission, or the user must reselect the source.
- Large original videos are not copied into IndexedDB just to enqueue them. File references
  are kept in memory for this session and filesystem handles are remembered when available.
  PCM costs roughly 115 MB per hour of source audio, in addition to model caches and projects.
- Saving failures are reported; processing must not report a stage complete if its durable save
  failed. Browser storage limits still apply. An exported project JSON does not embed the PCM.

## GPU probing and background limits

The speech worker tests the actual worker WebGPU context before loading ASR: up to three
adapter/device attempts, 4-second per-operation timeouts, 700 ms between failed attempts.
Late device results are destroyed. Each transcription probes afresh; CTC reuses that load's
verdict. Hardware probing timeouts do not interrupt multi-GB model downloads. Unavailable
WebGPU or failed model initialization leads to CPU fallback in Auto, with a visible warning.
Explicit interactive WebGPU selection still reports failure rather than silently falling back.

A screen wake lock is requested while the queue runs and reacquired when the page becomes
visible. The browser/OS can refuse/release it. This is NOT a service that survives a closed tab,
computer sleep, or browser termination. Keep the page open and prevent sleep for long runs.
Restoration remains the existing preview/export-on-demand behavior, not a batch rendering step.

## Downloaded results

One chosen folder, then a distinct safe subfolder per project (name + ID, including long-name
collision protection). Files include project JSON/status manifest, original transcript,
processed text/timecodes/SRT/JSON, available LLM Markdown, and timeline XML when source/title
metadata and PCM permit rebuilding its actual cut timeline. Titles are included for archived
projects too. Missing data/errors are explicit in the manifest, never silently fabricated.

A previously manually rendered MP4 is copied when its saved output handle is still accessible.
Otherwise it remains where the user exported it; the manifest reports that it could not be
copied. Downloading results does not start expensive video rendering. All media processing
stays local; only text goes to the configured LLM service.

## Live verbose report

Every project row has a read-only scrolling report immediately underneath it. Reports
are scoped by project ID and kept in IndexedDB `kv:batch-log:<id>`, separately from Project JSON.
They autosave about every two seconds and flush at stage boundaries. Reload can still lose the
last unflushed events if the browser is killed; a storage failure is visible and the in-memory
report remains downloadable until the tab closes. Deleting a project deletes its journal too.

The report is deliberately a liveness aid, not an archive: only the newest **300 lines** are kept
(in memory, in IndexedDB, in Copy/Download and in `processing.log.txt`). Older lines are discarded,
so a long file's early events are not available later. A 120,000-character safety cap also bounds
pathological single-line streams. Downloading the report therefore exports the retained tail.

Recorded events include queue/retry/cancellation and persistence, audio extraction metadata,
DSP loudness results, progress/device selection/model downloads, speech-worker requests/results,
Whisper text deltas, VAD/window/alignment details/checkpoints and word timestamps, filler results,
LLM prompts, HTTP attempts/statuses/retries/compatibility adaptations, provider-supplied reasoning
and answer deltas, final responses/usage, applied edit suggestions, text-step outputs and downloads.
Binary audio/tensor buffers are represented by type and size, not millions of raw samples.
The report describes instrumented app/worker events, not hidden browser/GPU-driver internals or
reasoning the provider does not send. No global console interception is installed.

The elapsed-last-event counter is separate from the local tab clock: time ticking is not claimed
as model progress. After 15 seconds without an event the report explicitly says it is awaiting
the current operation. Live rendering is limited to four updates per second, only when journal
content changes. Scroll-up stops following the bottom; «Не прокручивать» pins scrolling.

Each journal is collapsible. By default only the file currently being processed by the queue or
opened for editing is expanded; every other file — and all files when the queue is idle — starts
collapsed. A manual toggle applies to that file until its activity changes again, after which the
default takes over. Collapsed headers still show whether processing is active and how long ago the
last real event arrived, which is enough to check liveness without rendering the full body.

Known API keys/custom-header values and sensitive structured fields are redacted; auth headers
are never emitted by LLM diagnostics and endpoint credentials/query strings are omitted. Reports
DO contain transcript text, prompts and model outputs: treat them as private source material.
No log upload service or background worker is introduced.

## Verification

- `npm test`: existing suites plus GPU-probe and pure queue-state/sequence tests.
- `tests/batch.mjs`: real Chrome + real synthetic audio extraction, mocked ASR/filler outputs
  and mocked HTTP LLM responses. Checks default stages, strict sequentiality, saved/reloaded
  results, four-column table, folder exports, failed-file continuation/retry, and stop/resume.
- `tests/batch-results.mjs`: real WebCodecs MP4 render (software codec selection injected for the
  headless VPS), cancelled-picker/no-false-completion check, durable manual-video marker, archived
  title XML/timecodes/duration, copying an existing MP4, four columns and desktop overflow assertions.
  The rendered regression artifact is saved under `$TMPDIR/carver-test-out/batch-manual.mp4`.
- `CARVER_FIXTURE=<video> node tests/batch-log.mjs http://127.0.0.1:5200/`: real slow SSE mock
  with reasoning and answer deltas, unterminated final line, live report while queue is running,
  escaping/redaction, concurrent logger load/flush, full-log download and reload persistence.
- GPU tests simulate delayed/unavailable/hanging adapter/device calls; this VPS has no hardware
  GPU. The mock batch test does not measure real transcription speed or prove all-night uptime.

No server/backend worker or parallel-file mode is introduced.
