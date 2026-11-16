# Contributing

Thanks for taking a look. This is a small, browser-only application with a strong local-first
constraint; the fastest way to get a change accepted is to respect the invariants and verify it.

## Before you start

1. Read [AGENTS.md](AGENTS.md) (working guide and invariants) and
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (system map).
2. Check [docs/STATUS.md](docs/STATUS.md) for known limitations and open questions.
3. For a large behavior change, open an issue first. Remove-only editing, local-first processing and
   identical cuts/length across outputs are product decisions, not accidents.

## Setup

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Requirements and test details are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## What a good change looks like

- **Small and focused.** One behavior change per pull request, with the reason in the description.
- **Typechecked.** `npm run typecheck` must print nothing. Do not use `any` to hide a real mismatch.
- **Tested.** Add or extend a unit test for pure logic. For UI, export, audio or workspace behavior,
  add or run the relevant browser test and report the result.
- **Measured where it matters.** A/V sync, loudness, frame accuracy and performance claims need
  numbers from a real run, not an assumption.
- **Documented.** Update README/docs when a command, invariant or deployment step changes.
- **Secret-free.** Run `npm run check:secrets` and inspect the diff. Never commit `.env` files,
  tokens, passwords, server addresses or workspace magic links.

## Code conventions

- UI strings are Russian. Code, comments, identifiers and docs are English.
- All times are source seconds unless the name says `out`; use `srcToOut` / `outToSrc` / `segAt`.
- Mutate state in the store, then call `S.changed()` (edit) or `S.bump()` (UI only). Call
  `S.checkpoint()` before an undoable edit.
- Any new per-word or per-project edit state must be added to undo snapshots and to word-index
  remapping.
- Do not add COOP/COEP headers; do not change `base: './'`.
- Keep the test hooks (`window.__carver*`) working.

## Tests to run

Minimum before a pull request:

```bash
npm run check:secrets
npm run typecheck
npm test
npm run build
```

For changes touching media, export, audio, the timeline or the workspace UI, also run the relevant
browser tests against the built app (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).

## Commits and pull requests

- Write a clear, imperative commit subject. Explain the why in the body if it is not obvious.
- Do not rewrite published history.
- In the pull request, state what changed, what you ran, and what you could not verify. Screenshots
  are welcome for UI changes; keep them out of the repository unless they are deliberately small
  documentation assets.
- By contributing, you agree that your contribution can be distributed with the project. The project
  does not currently declare an open-source license; discuss licensing in an issue before relying on
  reuse rights.

## Reporting bugs

Include:

- Browser and OS version, GPU/WebGPU availability.
- Whether the app was built locally or served from a deployment.
- Steps to reproduce, expected vs actual behavior.
- Console errors and, for export/audio issues, the relevant `ffprobe` output.
- Do **not** attach private recordings or transcripts unless you have the rights and intend to share
  them. A synthetic reproduction is better.

Security issues go through [SECURITY.md](SECURITY.md), not the public issue tracker.
