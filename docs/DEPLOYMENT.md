# Deployment

The editor is a static single-page app. You can deploy it to any host that serves files over HTTPS.
The optional collaboration service is a separate Node process; the editor works without it.

**Never commit deployment secrets to this repository.** Hosts, domains, passwords, tokens and
workspace links belong in your local environment, your host's secret store, or the server's
environment file — not in git.

## 1. Build

```bash
npm ci
npm run build
```

`dist/` contains the application. Upload its **contents**, including hidden files:

```
dist/
  index.html
  sw.js
  .htaccess
  assets/index-<hash>.js
  assets/index-<hash>.css
  assets/*.worker-<hash>.js
  assets/ort-wasm-*.wasm
```

Do not upload `node_modules/`, `models/`, recordings or `tests/`. The build is static; there is no
Node runtime on the web host for the editor.

## 2. Static hosting rules

| Requirement | Why |
|---|---|
| HTTPS | Service worker, File System Access API and persistent storage require a secure context. |
| `.wasm` → `application/wasm` | The ONNX runtime loads a large WASM binary; a wrong MIME type breaks it. |
| No `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` | They block model downloads from Hugging Face. The app does not need cross-origin isolation. |
| `index.html` and `sw.js` → `no-cache` | Otherwise the service worker can serve an old shell after a deploy. |
| `/assets/*` → immutable long cache | Filenames are content-hashed. |
| SPA fallback to `index.html` | There is no server-side routing. |

`base: './'` is deliberate: the app also works under a subpath.

### nginx

Copy `deploy/nginx.conf.example` to `/etc/nginx/sites-available/rezak`, replace `<DOMAIN>`, symlink
it into `sites-enabled/`, then:

```bash
nginx -t && systemctl reload nginx
certbot --nginx -d <DOMAIN>      # or your own certificate
```

### Apache

`public/.htaccess` is copied into `dist/` by Vite. It sets the WASM MIME type and cache headers for
shared hosting. Confirm that `mod_headers` and `mod_deflate` are enabled.

### Generic static host

Configure the MIME type, cache headers and SPA fallback in the host's control panel. If the host does
not support custom headers, at minimum avoid caching `index.html`; hashed assets are safe.

## 3. Optional model mirror

The app fetches models from Hugging Face first. If Hugging Face is unreachable, it can fall back to
`<base>/models/<model-id>/resolve/main/<file>`. This is useful for offline or restricted networks.

```bash
node deploy/sync-models.mjs                 # all supported models
node deploy/sync-models.mjs --list           # show what would be downloaded
node deploy/sync-models.mjs --only=whisper-large-v3-turbo,wav2vec2
```

The mirror is several GB and is gitignored. Sync `models/` to the server separately:

```bash
rsync -a models/ <user>@<host>:/srv/rezak/current/models/
```

`deploy/nginx.conf.example` has a `/models/` location with the right MIME types and immutable cache.

## 4. Optional collaboration service

The workspace service stores **project JSON only**. It never accepts video bytes. Start it beside the
static site and proxy `/api/` and `/admin` to it under the same HTTPS origin.

```bash
CARVER_ADMIN_SECRET='<long-random-secret>' \
CARVER_ADMIN_USER='rezak' \
CARVER_ADMIN_PASSWORD='<long-random-password>' \
CARVER_WORKSPACE_DIR=/var/lib/rezak/workspaces \
CARVER_PUBLIC_ORIGIN='https://<DOMAIN>' \
node server/workspace-server.mjs 8787
```

| Variable | Required | Meaning |
|---|---|---|
| `CARVER_ADMIN_SECRET` | yes | Bearer secret for API scripts (`Authorization: Bearer …`). |
| `CARVER_ADMIN_PASSWORD` | yes | Password for the `/admin` Basic Auth page and admin API. |
| `CARVER_ADMIN_USER` | no | Admin username (default `rezak`). |
| `CARVER_WORKSPACE_DIR` | no | Storage directory (default `./.workspaces`). Must be writable and persistent. |
| `CARVER_PUBLIC_ORIGIN` | in production | Public origin used to build workspace login links. Defaults to `http://localhost:<port>`; set it to your HTTPS origin. |

Use long random values. The server refuses to start without the secret and password. Do not put
these values in the repository or in client-side code.

### systemd example

```ini
[Unit]
Description=Rezak workspace service
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/rezak/current
EnvironmentFile=/etc/rezak/workspace.env
ExecStart=/usr/bin/node server/workspace-server.mjs 8787
Restart=on-failure
User=rezak
Group=rezak
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/rezak/workspace.env` (mode `0600`, owned by the service user):

```bash
CARVER_ADMIN_SECRET=...
CARVER_ADMIN_USER=rezak
CARVER_ADMIN_PASSWORD=...
CARVER_WORKSPACE_DIR=/var/lib/rezak/workspaces
CARVER_PUBLIC_ORIGIN=https://<DOMAIN>
```

### nginx proxy

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_read_timeout 60s;
    client_max_body_size 25m;   # project JSON, not media
    gzip_proxied any;
}

location /admin {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
}
```

The client polls a small manifest every 5 s; gzip matters for full-project responses.

### Backups

Back up `CARVER_WORKSPACE_DIR` like any data directory. It contains project JSON, `sessions.dat` and
tombstones. A backup of the static `dist/` is not enough to restore user projects.

## 5. Deployment checklist

Before uploading:

- [ ] `npm run check:secrets` passes.
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass.
- [ ] No real host, domain, token or password is in the diff.
- [ ] `dist/` contains `.htaccess`, `sw.js` and the WASM asset.
- [ ] The `index-*.js` hash in `dist/index.html` matches the uploaded asset.

After uploading:

```bash
curl -sI https://<DOMAIN>/ | head -1                                      # 200
curl -sI https://<DOMAIN>/sw.js | grep -i cache-control                   # no-cache
curl -sI https://<DOMAIN>/ | grep -iE 'cross-origin-(opener|embedder)'    # empty
curl -sI "https://<DOMAIN>/assets/<wasm-file>" | grep -i content-type     # application/wasm
```

Then open the site in Chrome, hard-reload once (⌘⇧R) to drop the old service worker, open a short
recording and confirm transcription starts.

## 6. Rollback

Static deploy:

1. Keep the previous `dist/` (or a timestamped copy / release directory).
2. Re-upload it, or switch the symlink/root back.
3. Hard-reload in the browser so the service worker picks up the old shell.

Workspace service:

1. Keep the previous `server/workspace-server.mjs` and a timestamped copy of the data directory.
2. Stop the service, restore the file and data, start it again.
3. Existing sessions are valid only if `sessions.dat` was preserved; otherwise users re-enter through
   their workspace link.

## 7. Using `deploy/ship.sh`

```bash
CARVER_HOST=user@host.example deploy/ship.sh
CARVER_HOST=user@host.example CARVER_KEY=~/.ssh/deploy_key deploy/ship.sh
CARVER_HOST=user@host.example deploy/ship.sh --models
```

Optional variables: `CARVER_DEST` (default `/srv/rezak/current`), `CARVER_SSH` (default `ssh`),
`CARVER_KEY`. The script builds locally and uses `rsync -a --delete` for `dist/`; it never touches
the server's workspace data.

`deploy/post-receive.example` is an alternative: a bare git repository on the server checks out
`main` and builds there. It requires Node and `node_modules` on the server, so it is usually not worth
it for a static app.
