# CLAUDE.md

@AGENTS.md

## Claude-specific notes

- The full guide is in `AGENTS.md` (imported above). Read it before planning a change; the
  architecture overview is `docs/ARCHITECTURE.md`, setup/tests are `docs/DEVELOPMENT.md`, and the
  request history with measured numbers is `docs/HISTORY.md`.
- This is a **public** repository. Never add real hosts, tokens, passwords, workspace links or `.env`
  files. Run `npm run check:secrets` before committing.
- Use the image viewer on `$TMPDIR/carver-test-out/*.png` after e2e runs: several regressions in this
  project were only visible in screenshots (overlapping controls, wrong styles).
- Long-running commands (transcription of a 31-min video ≈ 3.5 min, full export ≈ 2 min, local LLM
  runs of several minutes) should run in the background; don't pipe them through `tail`/`grep` when you
  need intermediate output (pipes buffer until the end). Redirect to `$TMPDIR/<name>.log` and tail the file.
- Keep edits minimal and typechecked (`./node_modules/.bin/tsc -p .` prints nothing when clean), then
  `npm run build` so `dist/` matches the source — the app is deployed as static files.
