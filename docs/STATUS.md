# Status

Last updated: 2026-11-16. This is a source release of the current working tree; it is not a claim
that every feature has been validated on every platform.

## Implemented and tested

| Area | State |
|---|---|
| Media import | MP4/MOV (H.264/AAC) lazy decode; MP3/M4A/AAC/WAV/FLAC/OGG/Opus audio-only; 15 GB files open without reading the whole file. |
| Transcription | Whisper Large v3 Turbo / small / base on WebGPU, CPU fallback with a visible warning; wav2vec2 Russian forced alignment; 5-minute checkpoints. |
| Text editing | Word selection, cut/restore, undo/redo, pause chips, virtualized 15k-word transcript, keyboard navigation, caret. |
| Fillers and silences | Acoustic filler detection with wav2vec2 veto; adjustable silence threshold, minimum pause and padding. |
| Timeline | Waveform, cuts, words, playhead, overview; editable cut edges with pixel/keyboard nudging and no-overlap clamping. |
| Preview | Frame-accurate output preview, audio fades at joins, 0.75–2× pitch-preserving playback. |
| Sound | BS.1770 LUFS/true-peak meter, compressor, make-up, silence ducking, look-ahead limiter, optional phrase leveling, live waveform updates. |
| Restoration | Optional Sidon model on WebGPU, dry/wet mix, preview/export tile scheduling. |
| Export | MP4 H.264 + AAC streamed to disk; MP3; SRT/JSON/TXT/timecoded text; Final Cut Pro 7 XML; «Сохранить всё». |
| М cut/mute | Russian мат detector, custom wildcard/regex lists, mute (keep time) or cut, hotkey M, per-output mute choice. |
| AI | OpenAI-compatible client with streaming/retries/thinking models; AI carving with review; full text pipeline. |
| Batch | Sequential queue, per-stage state, GPU retries, stop/retry/resume, folder relink, result folder, live journal. |
| Workspaces | Optional Node service: manifests, revisions, leases, tombstones, admin create/duplicate/delete, session recovery. |
| Persistence | IndexedDB projects/PCM/handles, autosave, remembered file handles, service-worker offline shell. |

`npm test` (unit + service tests) and `npm run build` pass on the release tree. Browser e2e tests
exist for the editor, export, sound, mat, titles, batch and workspace flows; they require a local
Chrome, a test recording and (for some steps) an LLM server. See [DEVELOPMENT.md](DEVELOPMENT.md).

## Known limitations

- **Chrome/Edge only.** The app depends on WebCodecs, File System Access API, WebGPU (recommended)
  and service workers. Firefox/Safari are not supported.
- **WebGPU is strongly recommended.** CPU transcription works but is much slower; the UI warns and
  offers a switch. Hardware H.264 export depends on the platform encoder.
- **Russian speech only.** The alignment model and the profanity/filler tuning target Russian.
- **Remove-only editing.** There is no reordering, multi-source editing or arbitrary timeline
  composition. Заставки are the only inserted material.
- **VFR video is not supported.** Use constant-frame-rate sources; the XML exporter rejects
  fractional rates it cannot represent exactly.
- **16 kHz mono PCM for measurement.** Loudness may read 1–3 dB low on wide stereo, and true peak is
  a floor. Restoration quality depends on the source and the WebGPU backend.
- **Fast-track strictness is not confirmed by the product owner.** “STRICT” was implemented as the
  conservative «осторожно» preset.
- **Workspace service is optional and single-process.** It serializes writes per workspace but is
  not a horizontally scaled database. Back up its data directory.
- **Sidon restoration model size.** It is about 600 MB and is downloaded only when enabled.
- **No license has been chosen.** The repository is public source, not yet open source under a
  recognized license. Ask before reuse.

## Open questions / ideas

- Confirm the fast-track strictness and the production LLM provider/model.
- Loudness: EQ and other manual controls are still deferred. The current controls are compressor,
  make-up, silence ducking, limiter and optional phrase leveling.
- Automatic make-up can reach about +27 dB on very quiet material («Агрессивно»); consider a lower cap.
- Resuming an interrupted fast track after transcription.
- Restoration: the meter is computed on dry PCM, so with the compressor on a 100% export can be about
  1 dB louder than the meter (still within −14 ±1). Sidon may soften short non-speech sounds.
- Audio processing discussed but not built: mouth declicker, de-esser, noise gate. The decision was to
  extend the in-house TypeScript DSP rather than ship ffmpeg.wasm (size, GPL, single-threaded without
  COOP/COEP). Measured JS throughput: compressor+limiter ×390 real time, split-band de-esser+gate
  ×1100, STFT 1024/256 ×73.

## Release hygiene

- `main` is the published branch. Do not rewrite its history.
- Before tagging a release: `npm run check:secrets && npm run typecheck && npm test && npm run build`,
  then the relevant browser tests with a representative recording.
- The repository intentionally excludes recordings, model weights, `dist/`, screenshots and local
  tooling. A fresh clone needs `npm ci` and a first-run model download.
