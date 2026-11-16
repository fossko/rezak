# Development

## Prerequisites

- **Node.js 20+** and npm. The project was developed on Node 24/26 with TypeScript 7 and Vite 8.
- **Python 3** for `npm test` (the 52 XML cases call a stdlib XML checker) and for
  `tests/verify_*.py`; the verification scripts also need `numpy`, and visual comparison helpers use
  `Pillow`.
- **ffmpeg / ffprobe** for export verification and clip preparation.
- **Google Chrome** for browser tests (the runner uses `channel: 'chrome'`, headless, with WebGPU
  flags). It does not download a Playwright browser.
- Optional: **Ollama** (or any OpenAI-compatible endpoint) for the `ai`, `texts`, `llmstatus` and
  `fasttrack` e2e steps.

## Install

```bash
npm ci
```

If npm fails with `EPERM` on a sandboxed home directory, point the cache elsewhere:

```bash
export npm_config_cache="$TMPDIR/carver-npm-cache"
npm ci
```

Never copy `node_modules/` between machines; native packages and optional ONNX binaries differ.

## Everyday commands

```bash
npm run dev            # Vite dev server, http://127.0.0.1:5199 (HMR)
npm run typecheck      # tsc --noEmit; no output means clean
npm test               # unit + service tests; no browser required
npm run build          # tsc -b && vite build -> dist/
npm run preview        # Vite preview of dist/ (default 4173; pass --port 5200)
node serve.mjs         # tiny static server for dist/, default 8123
```

Do **not** use `npm run dev` for long e2e runs: HMR reloads the page and silently kills the run.
Build, then serve the built app:

```bash
npm run build
npx vite preview --host 127.0.0.1 --port 5200 --strictPort
```

`node serve.mjs` is a zero-dependency alternative that sets the correct `.wasm` MIME type. Never open
`dist/index.html` via `file://`; module workers, WASM and `fetch` are blocked there.

## Test layers

### 1. Unit tests (Node, no browser)

`npm test` runs the unit and service suites:

- `profanity`, `stretch` (WSOLA), `masterchain` (limiter latency/ceiling), `xml` (52 XML cases),
  `gpu-probe`, `batch-state`, `workspace`, `scope`, `relink`, `device`, `timeline-view`, `vu`.
- Workspace service tests spawn the real `server/workspace-server.mjs` on a temporary directory:
  `admin-workspaces`, `workspace-concurrency`, `workspace-sessions`, `workspace-abort`.

Some individual files can be run directly, which is useful while iterating:

```bash
node tests/profanity.test.ts
node tests/stretch.test.ts
node tests/masterchain.test.ts
node tests/xml.test.ts
```

Node runs `.ts` directly by stripping types, but it can import only **leaf** modules from `src/`
(app modules use extensionless imports). Leaf test targets must not use TypeScript parameter
properties (`constructor(private x…)`).

### 2. Browser end-to-end tests

```bash
npm run build
npx vite preview --host 127.0.0.1 --port 5200 --strictPort

node tests/e2e.mjs /path/to/video.mp4 --url=http://127.0.0.1:5200/ --steps=open,transcribe,edit
```

The runner keeps a Chrome profile in `$TMPDIR/carver-test-profile` and screenshots in
`$TMPDIR/carver-test-out/`. The first run downloads the speech models (about 2.2 GB); later runs reuse
them. Steps execute in file order, not in the order given on the command line. The full step table is
in [AGENTS.md](../AGENTS.md#testing); the most useful ones are:

| Step | Purpose |
|---|---|
| `open` | Open a file, extract audio, check media metadata. |
| `transcribe` | Full Whisper + wav2vec2 + filler pass. |
| `edit` | Select words 5–9, cut, undo, redo. |
| `export` | Export MP4 to OPFS, download it, write `segments.json`. |
| `saveall` | «Сохранить всё» into a directory and verify the files. |
| `mat` | Profanity tab, custom patterns, mute hotkey. |
| `titles` | Insert/trim/delete a заставка and verify the composite export. |
| `cutedit` | Waveform handle dragging, keyboard nudges, undo, clamping. |
| `persist` | Edit, reload, confirm the edit survived. |
| `offline` | Service worker serves the app offline. |

Tests that need a model server (`ai`, `texts`, `llmstatus`, `fasttrack`) require Ollama running at
`http://localhost:11434` or a configured compatible endpoint. Do not alternate two Ollama models in
one test: a model swap costs about 14 seconds.

### 3. Numeric verification

```bash
python3 tests/verify_export.py source.mp4 "$TMPDIR/carver-test-out/export.mp4" \
  "$TMPDIR/carver-test-out/segments.json"
python3 tests/verify_mute.py all.mp4 all.mp3 mutes.json
python3 tests/verify_xml.py ...
```

`verify_export.py` samples output frames, maps them back to source time and checks audio lag.
`verify_mute.py` checks that MP4 and MP3 have the same length and sample-locked audio, with silence
exactly where the MP3 is muted. Do not trust a visual check alone for A/V sync.

## Test fixtures

Recordings, model weights and screenshots are not committed (they are large and may be private).
Bring your own:

- A short Russian monologue (1–3 minutes) for `open` / `transcribe` / `edit`.
- A 20–40 minute recording for performance and long-file work.
- A short intro clip for the `titles` step.
- A synthetic clip for audio-only and fast tests:

```bash
ffmpeg -ss 600 -t 150 -i input.mp4 -c copy "$TMPDIR/carver-clip.mp4"
ffmpeg -f lavfi -i testsrc=size=640x360:rate=30 -f lavfi -i sine=frequency=440 \
  -t 3 -c:v libx264 -pix_fmt yuv420p -c:a aac "$TMPDIR/synthetic.mp4"
```

The browser tests accept `--url`, `--llm`, `--sens`, `--matwords` and `--range` where relevant. See
the usage banner at the top of `tests/e2e.mjs`.

## Test hooks

The tests depend on these globals; keep them working when refactoring:

- `window.__carver` — the store singleton.
- `window.__carverDebug` — `getSpeechRPC`, `pcmSlice`, `srcToOut`, `exactLevels`, `measureFile`.
- `window.__carverPlayer` — playback stats (`drawn`, `late`, `maxGap`, `refreshes`).
- `window.__carverTestHandle` / `__carverTestDir` / `__carverNoPicker` — file picker and export targets.
- `window.__carverTimeline` — view state (`v0`, `span`, `W`, `drawnRev`, `draws`).
- `window.__carverChime` — chime config/log.
- `window.__carverRestoreEp` — force `wasm` restoration in tests.

## Code style

- UI copy is **Russian**; code, comments, identifiers and docs are **English**.
- TypeScript strict mode is on. Do not introduce `any` to silence a real type mismatch; annotate at
  the WebAudio/WebCodecs boundary instead.
- Keep state mutations in the store and call `S.changed()` (edit) or `S.bump()` (UI only).
  Call `S.checkpoint()` before an undoable edit.
- All times are source seconds unless the name says `out`. Use the mapping helpers, never ad-hoc
  arithmetic across cut boundaries.
- When adding a new per-word/project edit field, add it to undo snapshots and to any word-index
  remapping (filler merge).
- No global drop handlers outside `DropOverlay.tsx`. No COOP/COEP headers.
- Keep `base: './'` in `vite.config.ts`.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes and pull requests:

1. `npm ci`
2. `npm run check:secrets`
3. `npm run typecheck`
4. `npm test`
5. `npm run build`

Browser e2e tests are not run in CI because they need a GPU/Chrome and large model downloads; run
them locally before a release that touches the editor, export or audio paths.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Blank page from `dist/index.html` | `file://` is unsupported. Serve over HTTP with `node serve.mjs`. |
| e2e reloads or hangs mid-run | You are on `npm run dev` (HMR). Use the preview build. |
| `npm ci` fails with `EPERM` | Set `npm_config_cache` to a writable directory. |
| Models fail to download | Check Hugging Face access and that COOP/COEP headers are **absent**; use the optional `/models/` mirror. |
| Browser test cannot find Chrome | Install Google Chrome or set `CARVER_CHROME_PATH`. |
| Transcription is very slow | WebGPU is unavailable and the app fell back to CPU; the UI shows a warning and a switch. |
| Old build keeps loading | The service worker is serving a cached shell. Hard reload (⌘⇧R) after a deploy. |
| Audio/video drift in export | Re-check AAC/MP3 priming compensation; run `verify_export.py`. |
| Workspace saves fail with 401 | The service restarted and sessions were lost; the client should re-exchange the magic link once. Check `sessions.dat` and restart behavior. |
| Workspace saves fail with 504/503 | A body read or job is stuck; check the request body timeout and job watchdog in `server/workspace-server.mjs`. |

## Adding a feature

1. Read [AGENTS.md](../AGENTS.md) and the relevant section of [ARCHITECTURE.md](ARCHITECTURE.md).
2. Make the smallest change that fits the invariants.
3. Add or extend a unit test for pure logic and an e2e step for UI/export behavior.
4. Run: `npm run check:secrets && npm run typecheck && npm test && npm run build`.
5. For media/DSP changes, run the relevant browser test and a numeric verification.
6. Update docs if behavior, a public command or an invariant changed.
