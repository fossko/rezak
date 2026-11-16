# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Contact the repository owner privately
(for example through the GitHub profile linked to this repository) with:

- a description of the issue and its impact;
- steps to reproduce, or a minimal proof of concept;
- affected version/commit and browser/platform;
- whether any real data or credentials may have been exposed.

You will get an acknowledgement as soon as possible. Please give reasonable time for a fix before
public disclosure.

## Reporting a leaked secret

If you find a credential, token, password, private key or live workspace link in this repository:

1. **Do not use it.** Do not paste it into an issue or a pull request.
2. Contact the owner privately with the file and commit (or the approximate location).
3. The owner must rotate/revoke the secret first, then remove it from history. Deleting the line in
   a new commit is not sufficient: the old commit still contains it.

`npm run check:secrets` scans tracked files for common patterns before commit. It is a safety net,
not a guarantee; review the diff as well.

## What this project stores

| Data | Where | Leaves the machine? |
|---|---|---|
| Source video/audio | User's disk; only a file handle is remembered | No |
| PCM and levels | IndexedDB (browser) | No |
| Project JSON, transcript, texts | IndexedDB; optionally the workspace service | Only if a shared workspace is used |
| LLM API key and settings | Browser `localStorage` (`carver:llm`) | Only to the LLM endpoint the user configures |
| Workspace session cookie | Browser cookie (`carver_workspace`, HttpOnly) | To the workspace origin |
| Models | Browser cache / optional server mirror | Downloads from Hugging Face or the mirror |

The workspace service deliberately accepts **project JSON only**, not media bytes. It uses
environment variables for credentials and writes data under `CARVER_WORKSPACE_DIR`.

## Deployment security

- Serve the app over HTTPS. The service worker, persistent storage and file handles require a secure
  context.
- Set `CARVER_ADMIN_SECRET` and `CARVER_ADMIN_PASSWORD` to long random values. The service refuses
  to start without them.
- Keep the environment file (`/etc/rezak/workspace.env` or equivalent) at mode `0600`, owned by the
  service user, outside the web root and outside git.
- Put the workspace service behind the same origin and HTTPS terminator as the app; restrict
  `/admin` if it does not need to be public.
- Back up `CARVER_WORKSPACE_DIR` and protect the backups. They contain project text and sessions.
- Do not add COOP/COEP headers; they are not a security feature here and they break model downloads.
- Review third-party dependencies with `npm audit` and keep the lockfile committed.

## Known boundaries

- The app is a client-side application: a user with control of the browser can read that browser's
  `localStorage`, IndexedDB and decrypted media. This is expected for a local-first editor.
- A workspace link is a bearer token. Anyone with the link can join that workspace; share it only
  with the intended team and rotate it by creating a new workspace if it leaks.
- The model downloads come from Hugging Face (or the operator's mirror). Treat the mirror as part of
  your supply chain and keep it under your control.
- The XML/text exports contain the transcript and edit decisions. Handle exported files accordingly.

## Supported versions

This is a single-branch source project; security fixes land on `main`. There are no maintained
release branches unless the owner states otherwise.
