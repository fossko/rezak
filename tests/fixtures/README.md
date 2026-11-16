# Test fixtures

Test recordings are intentionally **not** committed: they are large, may contain private speech and
are not needed to build the app.

Several browser tests accept an explicit video path; `tests/batch.mjs` and
`tests/batch-results.mjs` fall back to `tests/fixtures/synthetic.mp4`. Create it locally:

```bash
ffmpeg -f lavfi -i testsrc=size=640x360:rate=30 \
       -f lavfi -i sine=frequency=440:sample_rate=48000 \
       -t 3 -c:v libx264 -pix_fmt yuv420p -c:a aac \
       tests/fixtures/synthetic.mp4
```

For real transcription and export checks, use a short Russian monologue instead
(1–3 minutes is enough for the smoke tests). Put it anywhere outside the repository; `*.mp4` is
gitignored, but keeping private recordings out of the working tree is safer.

The `titles` step also needs a short intro clip. Pass it as the step argument described in
[AGENTS.md](../AGENTS.md#testing).

`tests/e2e.mjs` stores its Chrome profile and screenshots under `$TMPDIR`:

- `$TMPDIR/carver-test-profile` — models and browser storage (about 2.2 GB after the first run)
- `$TMPDIR/carver-test-out` — screenshots, exported media and JSON
