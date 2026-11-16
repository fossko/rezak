# Резак (Rezak)

Резак is a browser-based, local-first editor for long recorded monologues. It only **removes**
things: pauses, false starts, repetitions, slips, filler words and unwanted phrases. You edit the
**transcript** and the video follows, like carving a statue out of a block of stone.

The app runs entirely in Chrome/Edge on your machine. Video and audio are never uploaded. Only the
transcript text is sent to an LLM, and only when you explicitly use AI carving or the text pipeline.
The internal package name and the on-disk project format are `carver`; the user-facing name is
**Резак**.

> **For AI agents and contributors:** read [AGENTS.md](AGENTS.md) first. It is the working guide:
> invariants, architecture, commands, tests and pitfalls. The full request/decision history is in
> [docs/HISTORY.md](docs/HISTORY.md); the documentation index is [docs/README.md](docs/README.md).

## What it does

- **Opens huge files lazily** — MP4/MOV (H.264/AAC) through [mediabunny](https://mediabunny.dev);
  only the bytes that are needed are read. A 15 GB file opens instantly.
- **Plain audio** — MP3, M4A/AAC, WAV, FLAC, OGG/Opus. The preview is a black frame and the export
  is MP3-only; transcription, editing, loudness and restoration still work.
- **Word-accurate Russian transcript** — Whisper (Transformers.js on WebGPU) plus wav2vec2 forced
  alignment, with word edges snapped to the waveform. Sounds Whisper dropped are recovered from
  wav2vec2 and shown as `‹grey tokens›`. Progress is checkpointed every five minutes.
- **Text editing** — a virtualized editor that stays fast at 1.5 h / 15k words. Select words and
  press <kbd>Delete</kbd> to cut them (again to restore); click a pause chip to cut or keep it;
  undo/redo; removed text remains visible, struck through.
- **Filler sounds** — «эээ», «ааа», «ммм», «эммм» are found acoustically in pauses, checked with
  wav2vec2, and can be cut automatically. Sensitivity: strict / normal / sensitive.
- **Silence removal** like Recut — adjustable noise floor, minimum pause, padding before/after
  speech. Kept words are never clipped.
- **Preview** — seamless, frame-accurate output preview with audio fades at every join, plus
  pitch-preserving playback at 0.75–2× (preview only; export is always 1×).
- **Timeline** — level waveform, cuts, words, playhead, and a whole-file overview. Cut boundaries
  can be dragged and nudged by hand.
- **Sound** — ITU-R BS.1770 loudness meter (LUFS / true peak) against the YouTube target; live
  compressor, make-up gain, silence ducking, look-ahead limiter and optional phrase leveling.
- **Restoration** — optional Sidon speech restoration on WebGPU (dry/wet 0–100%). The model is
  downloaded only when switched on.
- **Export** — MP4 with the hardware H.264 encoder (WebCodecs) streamed straight to disk, AAC audio
  with sample-accurate cuts and fades; MP3 as well. SRT, JSON, plain/timecoded text, and a Final Cut
  Pro 7 XML timeline are available. «Сохранить всё» writes a project folder in one action.
- **Мат** — Russian profanity detection with custom word lists (`*` wildcards and `/regex/`).
  Muted words keep their time and are silenced; cut words are removed. Video and MP3 can have
  different mute settings while their cuts and length stay identical.
- **AI carving** — any OpenAI-compatible API. The model quotes unwanted text; quotes are matched
  back to words. Cuts can be applied immediately or reviewed one by one.
- **Text pipeline** — spelling → structured text → chapters with output timecodes → theses →
  summary → YouTube title/description/tags → social post → Shorts/Reels moments. Steps and prompts
  are editable; custom steps can be added.
- **Batch queue** — transcribe, clean and generate texts for many files unattended, with per-file
  state, retry, stop/resume and downloaded results.
- **Shared workspaces** — optional; a small Node service stores project JSON so a team can work on
  the same projects. Video and PCM stay on each participant's machine.
- **Local-first** — projects autosave to IndexedDB, source file handles are remembered, and a
  service worker makes the app work offline after the first visit.

## Measured performance

On an Apple M4 Max with Chrome and a 31.6-minute, 1.04 GB, 1080p30 test video:

| Step | Time |
|---|---|
| Open + audio extraction (16 kHz) | 7 s |
| Transcription (Large v3 Turbo + wav2vec2 alignment, WebGPU) | 3.5 min (≈9× real time) |
| Export of the 27.6-minute result (H.264 1080p + AAC, to disk) | ≈1.8 min (≈15× real time) |
| AI carving with a local Ollama model | ≈5 min |
| Preview across 11 joins in 40 s | 29.7 fps, 0 late frames |

Export verification (`tests/verify_export.py`) checks that sampled output frames match the source at
the mapped time (within one frame) and that audio stays in sync to ±0.1 ms. The AAC encoder priming
delay is measured at export time and compensated for.

## Requirements

- Chrome or Edge 113+ with a GPU (Apple Silicon or any WebGPU-capable GPU). The app works without
  WebGPU, but transcription is much slower; the UI shows a warning with a one-click switch to WebGPU.
- Node.js 20+ and npm (developed on Node 24/26).
- Python 3 for `npm test` (the XML verification uses the standard library only).
- Optional for browser/export tests: Google Chrome, `ffmpeg`/`ffprobe`, and Python 3 with `numpy`
  and `Pillow`.
- Optional for local LLM work: [Ollama](https://ollama.com/) or any OpenAI-compatible endpoint.

The first run downloads and caches the speech models (about 1.6 GB for Large v3 Turbo). The optional
restoration model is about 600 MB.

## Quick start

```bash
npm ci                 # install the exact locked dependencies
npm run dev            # http://127.0.0.1:5199  (UI work; HMR)
npm run typecheck      # tsc --noEmit; prints nothing when clean
npm test               # unit and service tests (no browser required)
npm run build          # -> dist/
node serve.mjs         # http://127.0.0.1:8123 serves dist/ with the right .wasm MIME
```

Do **not** open `dist/index.html` via `file://`: module workers, WASM and `fetch` are blocked there.
Use `node serve.mjs` or any static server.

For browser end-to-end tests, build first and serve the built app:

```bash
npm run build
npx vite preview --host 127.0.0.1 --port 5200 --strictPort
node tests/e2e.mjs /path/to/video.mp4 --url=http://127.0.0.1:5200/ --steps=open,transcribe,edit
```

The e2e runner drives the installed Google Chrome (headless, WebGPU flags) and keeps its profile in
`$TMPDIR/carver-test-profile`, so models are downloaded only once. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full test matrix.

## Hosting

The editor is a static single-page app. `npm run build` writes `dist/`; upload its **contents**
(including the hidden `.htaccess` and `sw.js`) to any static host.

Rules that matter:

- Serve `.wasm` as `application/wasm`.
- Do **not** add `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`. They block model
  downloads from Hugging Face and the app does not need cross-origin isolation.
- Cache `/assets/*` immutably (hashed names) but always revalidate `index.html` and `sw.js`.
- HTTPS is required for the service worker, remembered file handles and the save-to-disk dialog.

`deploy/nginx.conf.example` contains a complete nginx server block. The app uses a relative
`base: './'`, so it can also live in a subfolder. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers the
optional collaboration service, the model mirror and a deployment checklist.

### Local LLMs from a hosted site

Ollama only accepts browser requests from allowed origins:

```bash
OLLAMA_ORIGINS="https://your-site.example" ollama serve
```

For LM Studio, enable CORS. Chrome may ask permission for an HTTPS page to reach `localhost`.

## Privacy and secrets

- **No API keys or credentials are committed to this repository.** LLM keys are entered in the
  app's settings and stored only in that browser's `localStorage`.
- The video, audio and derived PCM never leave the machine. The only outbound requests are to the
  LLM endpoint configured by the user, Hugging Face (model download), and the optional workspace
  service.
- The collaboration service is configured entirely through environment variables; see
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Never commit `.env` files, tokens, passwords, server
  addresses or workspace magic links.
- `npm run check:secrets` scans tracked files for common credential patterns before a commit.
- To report a vulnerability or a leaked secret, follow [SECURITY.md](SECURITY.md).

## Project layout

```
src/
  lib/          data model, IndexedDB, media, PCM, EDL/cuts, DSP, loudness, GPU helpers
  transcribe/   Whisper + wav2vec2 worker, windows/alignment, filler detection
  player/       canvas + WebAudio preview, WSOLA stretch
  audio/        live loudness processing (LiveMaster + DSP worker)
  restore/      Sidon speech restoration (front-end, ONNX worker, tile engine)
  export/       MP4/MP3 render, text/subtitle/XML outputs, save-all
  llm/          OpenAI-compatible client, AI carving, text pipeline
  ui/           React components
server/         optional collaboration service (project JSON only)
deploy/         nginx/Apache examples, ship script, model mirror downloader
tests/          unit, service and browser end-to-end tests
docs/           architecture, development, deployment, feature and decision docs
```

The repository root **is** the app. `dist/`, `node_modules/`, model weights, recordings and local
tooling are gitignored.

## Documentation

| File | What it is |
|---|---|
| [AGENTS.md](AGENTS.md) | The working guide for AI agents and contributors: invariants, module map, feature notes, tests, pitfalls. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, data flow, persistence and concurrency model. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup, commands, test strategy, fixtures and troubleshooting. |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Static hosting, optional workspace service, model mirror, security checklist. |
| [docs/STATUS.md](docs/STATUS.md) | Implemented features, known limitations and open questions. |
| [docs/HISTORY.md](docs/HISTORY.md) | Chronological record of requests, decisions and measurements. |
| [docs/BATCH.md](docs/BATCH.md) | The batch queue, relinking, notes and downloaded results. |
| [docs/WORKSPACES.md](docs/WORKSPACES.md) | Shared workspaces and the admin API. |
| [docs/XML-EXPORT.md](docs/XML-EXPORT.md) | The Final Cut Pro 7 XML timeline export. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution workflow, code style and review expectations. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: keep the UI Russian and the code/comments/docs
English, typecheck, run the relevant tests, build the app, and never commit secrets.

## License

No open-source license has been declared for this repository yet. Until one is added, copyright
remains with the authors and reuse requires permission. If you intend to reuse the code, open an
issue to discuss licensing.

## Repository history

This public repository starts from a single initial commit. The pre-public development history is
not included; deployment-specific hosts, credentials, workspace links and private paths were
removed before publication. The engineering decisions and measurements worth keeping are in
[docs/HISTORY.md](docs/HISTORY.md).
