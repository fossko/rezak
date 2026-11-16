# Documentation

Start with the root [README](../README.md) for the product, and [AGENTS.md](../AGENTS.md) for the
working rules and invariants.

| File | Read it when |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | You need the system map, data flow, modules, persistence or concurrency model. |
| [DEVELOPMENT.md](DEVELOPMENT.md) | You are setting up the project, running tests, or debugging the toolchain. |
| [DEPLOYMENT.md](DEPLOYMENT.md) | You are publishing the static app or running the optional workspace service. |
| [STATUS.md](STATUS.md) | You need the implemented scope, known limitations and open questions. |
| [HISTORY.md](HISTORY.md) | You want to know why a feature exists, what was measured, or what was rejected. |
| [BATCH.md](BATCH.md) | You are working on the batch queue, relinking, notes or downloaded results. |
| [WORKSPACES.md](WORKSPACES.md) | You are working on shared workspaces or the admin API. |
| [XML-EXPORT.md](XML-EXPORT.md) | You are working on the Final Cut Pro 7 XML timeline export. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | You are preparing a change or a pull request. |
| [../SECURITY.md](../SECURITY.md) | You found a vulnerability or a leaked secret. |

## Documentation rules

- UI copy is Russian; documentation and code comments are English.
- Use `<your-domain>` / `<server-host>` in examples. Never commit real infrastructure details,
  tokens, passwords or workspace links.
- If you change a public command, an invariant or a deployment requirement, update the relevant doc
  in the same change.
- Keep the history factual: record what was requested, what was built, what was measured, and what
  was deliberately not done.
