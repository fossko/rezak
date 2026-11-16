// Optional collaboration service for Carver. Run beside the static site:
//   CARVER_ADMIN_SECRET=... CARVER_ADMIN_PASSWORD=... node server/workspace-server.mjs 8787
// It stores project JSON only; source video bytes are deliberately never accepted.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const port = Number(process.argv[2] || 8787);
const root = process.env.CARVER_WORKSPACE_DIR || join(process.cwd(), '.workspaces');
const adminSecret = process.env.CARVER_ADMIN_SECRET;
const adminUser = process.env.CARVER_ADMIN_USER || 'rezak';
const adminPassword = process.env.CARVER_ADMIN_PASSWORD;
// The public URL used to build workspace login links. Set CARVER_PUBLIC_ORIGIN in production;
// the localhost default keeps a fresh checkout usable without configuration.
const publicOrigin = (process.env.CARVER_PUBLIC_ORIGIN || `http://localhost:${port}`).replace(/\/+$/, '');
if (!adminSecret || !adminPassword) throw new Error('CARVER_ADMIN_SECRET and CARVER_ADMIN_PASSWORD are required');
const sessions = new Map();
// Sessions are written to disk so a service restart (a deploy) does not log every open tab out.
const sessionsPath = join(root, 'sessions.dat');
async function loadSessions() {
  try {
    const saved = JSON.parse(await readFile(sessionsPath, 'utf8'));
    for (const [token, id] of Object.entries(saved)) if (typeof token === 'string' && typeof id === 'string') sessions.set(token, id);
  } catch { /* first start */ }
}
async function saveSessions() {
  try {
    const entries = [...sessions.entries()].slice(-5000);   // bounded: oldest logins are forgotten first
    const tmp = `${sessionsPath}.tmp-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(entries)));
    await rename(tmp, sessionsPath);
  } catch { /* a missing session file only means another login */ }
}
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const json = (res, code, value, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(value)); };
const MAX_BODY = 20_000_000, BODY_TIMEOUT_MS = 20_000, JOB_TIMEOUT_MS = 45_000;
/** Read a JSON body, but never leave a Promise (and the workspace's write queue) pending forever when the
 *  client disconnects mid-upload or stalls. That used to wedge one workspace until a service restart. */
const readBody = req => new Promise((resolve, reject) => {
  let s = '', settled = false, timer;
  const cleanup = () => {
    clearTimeout(timer);
    req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onAbort); req.off('close', onClose);
  };
  const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
  const fail = (message, status) => { const e = new Error(message); e.status = status; finish(reject, e); };
  function onData(chunk) { s += chunk; if (s.length > MAX_BODY) { req.destroy(); fail('body too large', 413); } }
  function onEnd() {
    if (settled) return;
    let parsed;
    try { parsed = s ? JSON.parse(s) : {}; } catch { fail('invalid json', 400); return; }
    finish(resolve, parsed);
  }
  function onAbort() { fail('request aborted', 400); }
  function onClose() { if (!req.complete) fail('request aborted', 400); }
  req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', onAbort); req.on('close', onClose);
  timer = setTimeout(() => { req.destroy(); fail('request body timeout', 408); }, BODY_TIMEOUT_MS);
});
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error(message); e.status = 503; reject(e); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const workspacePath = id => join(root, `${id}.json`);

/** One promise chain per workspace id: every read-modify-write of a workspace file runs alone, so two
 *  participants saving at the same moment cannot interleave (that used to drop updates and, worse, let a
 *  read catch a half-written file and fail with a JSON syntax error). */
const queues = new Map();
function exclusive(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  // Start the job only after the previous one settles, and put a bound on the job itself so one stuck
  // upload cannot block every later request for this workspace forever.
  const guarded = () => withTimeout(Promise.resolve().then(job), JOB_TIMEOUT_MS, 'workspace operation timeout');
  const run = prev.then(guarded, guarded);
  queues.set(key, run.then(() => {}, () => {}));
  return run;
}
async function load(id) { return JSON.parse(await readFile(workspacePath(id), 'utf8')); }
/** Atomic write: a reader sees either the old file or the new one, never a partial one. */
async function save(ws) {
  ws.updatedAt = Date.now();
  const target = workspacePath(ws.id);
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(ws, null, 2));
  try { await rename(tmp, target); }
  catch (e) { await rm(tmp, { force: true }); throw e; }
  return ws;
}
function cookie(req) { return (req.headers.cookie || '').match(/carver_workspace=([^;]+)/)?.[1]; }
function auth(req, id) { const token = cookie(req); return token && sessions.get(token) === id ? token : null; }
function cleanLocks(ws) { const now = Date.now(); ws.locks = (ws.locks || []).filter(x => now - x.lastSeen < 60_000); }
function lock(ws, projectId, ownerId, kind, queueId) { cleanLocks(ws); const old = ws.locks.find(x => x.projectId === projectId); if (old && old.ownerId !== ownerId) { const e = new Error('PROJECT_LOCKED'); e.status = 409; throw e; } const item = { projectId, ownerId, kind, queueId, acquiredAt: old?.acquiredAt || Date.now(), lastSeen: Date.now() }; ws.locks = [...ws.locks.filter(x => x.projectId !== projectId), item]; }
function adminAuthorized(req) {
  const h = req.headers.authorization || '';
  if (h === `Bearer ${adminSecret}`) return true;
  if (!h.startsWith('Basic ')) return false;
  try { const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':'); return u === adminUser && p === adminPassword; } catch { return false; }
}
const linkFor = (ws) => `${publicOrigin}/?workspace=${ws.token}`;

/** Every stored workspace with the numbers the admin page shows. */
async function listWorkspaces() {
  const out = [];
  for (const name of await readdir(root)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!SAFE_ID.test(id)) continue;
    const st = await stat(workspacePath(id)).catch(() => null);
    if (!st) continue;
    try {
      const raw = await readFile(workspacePath(id), 'utf8');
      const ws = JSON.parse(raw);
      cleanLocks(ws);
      const projects = Array.isArray(ws.projects) ? ws.projects : [];
      out.push({
        id, name: ws.name || 'Рабочее пространство', token: ws.token,
        projects: projects.length,
        locks: (ws.locks || []).length,
        bytes: st.size,
        created: st.birthtimeMs || st.ctimeMs,
        updatedAt: ws.updatedAt || st.mtimeMs,
      });
    } catch {
      // A file that does not parse is shown, not hidden: it must be noticed and deleted by hand.
      out.push({ id, name: '(файл повреждён)', token: '', projects: 0, locks: 0, bytes: st.size, created: st.ctimeMs, updatedAt: st.mtimeMs, broken: true });
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
async function duplicateWorkspace(sourceId) {
  const src = await load(sourceId);
  const id = randomUUID();
  const now = Date.now();
  const projects = (src.projects || []).map((p) => {
    const newId = randomUUID();
    const data = p.data && typeof p.data === 'object'
      ? { ...structuredClone(p.data), id: newId, workspaceId: id }
      : p.data;
    return { ...p, id: newId, data, revision: 1, updatedAt: now };
  });
  const copy = { id, name: `${src.name || 'Рабочее пространство'} (копия)`, token: randomBytes(24).toString('base64url'), projects, locks: [], deleted: [], updatedAt: now };
  await save(copy);
  return copy;
}

const ADMIN_HTML = `<!doctype html><meta charset="utf-8"><title>Резак — рабочие пространства</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}body{font:15px/1.45 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;background:#15161a;color:#eee}
h1{font-size:22px;margin:0 0 6px}.sub{color:#9aa;margin-bottom:18px}
.card{background:#20222a;border:1px solid #2d3038;padding:16px;border-radius:12px;margin-bottom:16px}
input,button{font:inherit;padding:9px 11px;border-radius:7px;border:1px solid #444;background:#282b34;color:#fff}
input{box-sizing:border-box}label{display:block;color:#9aa;font-size:13px;margin-bottom:10px}label input{display:block;width:100%;margin-top:4px}
button{cursor:pointer}button.primary{background:#665cff;border-color:#665cff}button.danger{background:#3a2126;border-color:#633}button.ghost{background:transparent}
button:disabled{opacity:.5;cursor:default}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #2d3038;vertical-align:top}th{color:#9aa;font-weight:500;font-size:13px}
td.num{text-align:right;font-variant-numeric:tabular-nums}td.actions{white-space:nowrap}td.actions button{margin:0 6px 4px 0;padding:6px 9px;font-size:13px}
th,td{padding:10px 6px}
.link{display:flex;gap:6px;align-items:center}.link input{flex:1;font-size:12px;min-width:200px;font-family:ui-monospace,Menlo,monospace}
.wid{color:#889;font-size:11.5px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tablewrap{overflow-x:auto}
.stats{display:flex;gap:22px;flex-wrap:wrap;color:#cfd}.stats b{color:#fff;font-size:18px;display:block}
#msg{min-height:20px;color:#9ff;margin-top:10px;white-space:pre-wrap}#msg.err{color:#ff8f8f}
.name{font-weight:600}
</style>
<h1>Рабочие пространства</h1>
<div class="sub">Ссылка — это и адрес, и токен входа. Удаление убирает пространство и все его проекты у всех участников.</div>
<div class="card stats" id="stats"></div>
<div class="card">
  <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
    <label style="flex:1;min-width:220px;margin:0">Название<input id="name" value="Команда"></label>
    <button class="primary" id="create">+ Создать пространство</button>
    <button class="ghost" id="refresh">Обновить</button>
  </div>
  <div id="msg"></div>
</div>
<div class="card tablewrap" style="padding:6px 16px">
  <table><thead><tr><th>Пространство</th><th class="num">Проектов</th><th class="num">На экране</th><th>Обновлено</th><th>Ссылка</th><th>Действия</th></tr></thead>
  <tbody id="rows"><tr><td colspan="6" style="color:#9aa">Загружаю…</td></tr></tbody></table>
</div>
<script>
const $ = (id) => document.getElementById(id);
const msg = (text, bad) => { $('msg').textContent = text; $('msg').className = bad ? 'err' : ''; };
async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const text = await r.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch (e) { value = { error: text }; }
  if (!r.ok) throw new Error(value.error || ('HTTP ' + r.status));
  return value;
}
function fmtDate(ms) { if (!ms) return '—'; const d = new Date(ms); return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
function fmtFull(ms) { return ms ? new Date(ms).toLocaleString('ru-RU') : ''; }
function cell(text, cls) { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text; return td; }
function button(label, cls, onClick) { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = onClick; return b; }
async function copyLink(token, origin) {
  const link = origin + '/?workspace=' + token;
  try { await navigator.clipboard.writeText(link); msg('Ссылка скопирована: ' + link); }
  catch (e) { msg('Скопируйте вручную: ' + link); }
}
function render(data) {
  const totals = data.totals || { workspaces: 0, projects: 0, locks: 0 };
  $('stats').innerHTML = '';
  const size = data.totals.bytes >= 1048576 ? (data.totals.bytes / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(data.totals.bytes / 1024)) + ' КБ';
  [['Пространств', totals.workspaces], ['Проектов всего', totals.projects], ['Открыто сейчас', totals.locks], ['Занято на диске', size]].forEach(function (pair) {
    const div = document.createElement('div'); const b = document.createElement('b'); b.textContent = String(pair[1]);
    div.appendChild(b); div.appendChild(document.createTextNode(pair[0])); $('stats').appendChild(div);
  });
  const rows = $('rows'); rows.innerHTML = '';
  if (!data.workspaces.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 6; td.style.color = '#9aa'; td.textContent = 'Пока нет ни одного пространства.'; tr.appendChild(td); rows.appendChild(tr); return;
  }
  data.workspaces.forEach(function (w) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    const nameDiv = document.createElement('div'); nameDiv.className = 'name';
    if (w.broken) { nameDiv.style.color = '#ff8f8f'; nameDiv.textContent = '(файл повреждён) ' + w.id; } else nameDiv.textContent = w.name;
    const idDiv = document.createElement('div'); idDiv.className = 'wid'; idDiv.textContent = w.id; idDiv.title = w.id;
    nameTd.appendChild(nameDiv); nameTd.appendChild(idDiv); tr.appendChild(nameTd);
    tr.appendChild(cell(String(w.projects), 'num'));
    tr.appendChild(cell(String(w.locks), 'num'));
    const updatedTd = cell(fmtDate(w.updatedAt)); updatedTd.title = 'Последнее изменение: ' + fmtFull(w.updatedAt) + ' · создано: ' + fmtFull(w.created); tr.appendChild(updatedTd);
    const linkTd = document.createElement('td');
    const wrap = document.createElement('div'); wrap.className = 'link';
    if (w.broken) {
      const note = document.createElement('span'); note.style.color = '#ff8f8f'; note.textContent = 'не читается — только удалить';
      linkTd.appendChild(note); tr.appendChild(linkTd);
      const actTd = document.createElement('td'); actTd.className = 'actions';
      actTd.appendChild(button('Удалить', 'danger', async function () {
        if (!confirm('Удалить повреждённый файл ' + w.id + '?')) return;
        try { await api('/admin/workspaces/' + encodeURIComponent(w.id), { method: 'DELETE' }); await refresh(); }
        catch (e) { msg('Не удалось удалить: ' + e.message, true); }
      }));
      tr.appendChild(actTd); rows.appendChild(tr); return;
    }
    const input = document.createElement('input'); input.readOnly = true;
    // The token is what identifies the workspace; the full link appears on focus and is what «Копировать» copies.
    input.value = '?workspace=' + w.token; input.title = w.link;
    input.onfocus = function () { input.value = w.link; input.select(); };
    input.onblur = function () { input.value = '?workspace=' + w.token; };
    wrap.appendChild(input); wrap.appendChild(button('Копировать', '', function () { copyLink(w.token, data.origin); }));
    linkTd.appendChild(wrap); tr.appendChild(linkTd);
    const actTd = document.createElement('td'); actTd.className = 'actions';
    actTd.appendChild(button('Дублировать', '', async function () {
      if (!confirm('Создать копию «' + w.name + '» со всеми проектами? У копии будет своя новая ссылка.')) return;
      try { const made = await api('/admin/workspaces/' + encodeURIComponent(w.id) + '/duplicate', { method: 'POST' }); msg('Создана копия: ' + made.name + '\\n' + made.link); await refresh(); }
      catch (e) { msg('Не удалось дублировать: ' + e.message, true); }
    }));
    actTd.appendChild(button('Удалить', 'danger', async function () {
      if (!confirm('Удалить пространство «' + w.name + '» и все его проекты (' + w.projects + ')? Это необратимо и коснётся всех участников.')) return;
      try { await api('/admin/workspaces/' + encodeURIComponent(w.id), { method: 'DELETE' }); msg('Пространство «' + w.name + '» удалено.'); await refresh(); }
      catch (e) { msg('Не удалось удалить: ' + e.message, true); }
    }));
    tr.appendChild(actTd);
    rows.appendChild(tr);
  });
}
async function refresh() {
  try { render(await api('/admin/workspaces')); }
  catch (e) { msg('Не удалось получить список: ' + e.message, true); }
}
$('create').onclick = async function () {
  const buttonEl = $('create'); buttonEl.disabled = true; msg('Создаю…');
  try {
    const made = await api('/admin/workspaces', { method: 'POST', body: JSON.stringify({ name: $('name').value }) });
    msg('Пространство создано. Ссылка для входа:\\n' + made.link);
    await refresh();
  } catch (e) { msg('Не удалось создать: ' + e.message, true); }
  finally { buttonEl.disabled = false; }
};
$('refresh').onclick = refresh;
refresh();
</script>`;

await mkdir(root, { recursive: true });
await loadSessions();
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'); const parts = url.pathname.split('/').filter(Boolean);

    // ---------------------------------------------------------------- admin
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      if (!adminAuthorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Carver admin"' });
        return res.end('authentication required');
      }
      if (req.method === 'GET' && url.pathname === '/admin') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(ADMIN_HTML);
      }
      if (parts[1] === 'workspaces') {
        const id = parts[2] && SAFE_ID.test(parts[2]) ? parts[2] : null;
        if (req.method === 'GET' && parts.length === 2) {
          const workspaces = (await listWorkspaces()).map(w => ({ ...w, link: linkFor(w) }));
          const totals = {
            workspaces: workspaces.length,
            projects: workspaces.reduce((n, w) => n + w.projects, 0),
            locks: workspaces.reduce((n, w) => n + w.locks, 0),
            bytes: workspaces.reduce((n, w) => n + w.bytes, 0),
          };
          return json(res, 200, { origin: publicOrigin, totals, workspaces });
        }
        if (req.method === 'POST' && parts.length === 2) {
          const body = await readBody(req);
          const ws = { id: randomUUID(), name: String(body.name || 'Рабочее пространство').slice(0, 120), token: randomBytes(24).toString('base64url'), projects: [], locks: [], deleted: [], updatedAt: Date.now() };
          await save(ws);
          return json(res, 201, { id: ws.id, name: ws.name, link: linkFor(ws) });
        }
        if (id && parts[3] === 'duplicate' && req.method === 'POST') {
          let copy;
          try { copy = await exclusive(id, () => duplicateWorkspace(id)); }
          catch (e) { if (e.code === 'ENOENT') return json(res, 404, { error: 'workspace not found' }); throw e; }
          return json(res, 201, { id: copy.id, name: copy.name, projects: copy.projects.length, link: linkFor(copy) });
        }
        if (id && parts.length === 3 && req.method === 'DELETE') {
          const existed = await exclusive(id, async () => {
            const found = await stat(workspacePath(id)).then(() => true, () => false);
            if (found) await rm(workspacePath(id), { force: true });
            return found;
          });
          if (!existed) return json(res, 404, { error: 'workspace not found' });
          return json(res, 200, { ok: true, id });
        }
        if (id && parts.length === 3 && req.method === 'POST') {
          let src;
          try { src = await load(id); }
          catch (e) { if (e.code === 'ENOENT') return json(res, 404, { error: 'workspace not found' }); throw e; }
          return json(res, 200, { id: src.id, name: src.name, link: linkFor(src) });
        }
      }
      return json(res, 404, { error: 'not found' });
    }

    // ---------------------------------------------------------------- workspace API
    if (parts[0] !== 'api' || parts[1] !== 'workspace') return json(res, 404, { error: 'not found' });
    if (req.method === 'POST' && parts[2] === 'enter') {
      const body = await readBody(req); let found = null;
      for (const name of await readdir(root)) {
        if (!name.endsWith('.json')) continue;
        try { const candidate = JSON.parse(await readFile(join(root, name), 'utf8')); if (candidate.token === body.token) { found = candidate; break; } } catch { /* skip */ }
      }
      if (!found) return json(res, 404, { error: 'invalid workspace link' });
      const session = randomBytes(32).toString('base64url'); sessions.set(session, found.id);
      void saveSessions();
      return json(res, 204, null, { 'Set-Cookie': `carver_workspace=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000` });
    }
    const session = cookie(req); const id = session && sessions.get(session);
    // SESSION_EXPIRED tells the client to re-enter with its link token instead of showing a network error.
    if (!id) return json(res, 401, { error: session ? 'SESSION_EXPIRED' : 'unauthorized' });
    // Reads are served outside the per-workspace write queue: a slow/failed save must never stop every
    // tab from polling. Writes are atomic (tmp + rename), so a reader never sees a partial file.
    if (req.method === 'GET' && (parts.length === 2 || parts[2] === 'manifest' || (parts[2] === 'projects' && parts[3] && parts.length === 4))) {
      const ws = await load(id); cleanLocks(ws);
      if (parts.length === 2) return json(res, 200, ws);
      // Light poll: project list without the (large) project bodies. Clients fetch only what changed.
      if (parts[2] === 'manifest') {
        return json(res, 200, {
          id: ws.id, name: ws.name, updatedAt: ws.updatedAt,
          locks: ws.locks,
          deleted: ws.deleted || [],
          projects: ws.projects.map(p => ({ id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt })),
        });
      }
      // One project with its data, for clients that already know its revision.
      const one = ws.projects.find(x => x.id === decodeURIComponent(parts[3]));
      if (!one) return json(res, 404, { error: 'project not found' });
      return json(res, 200, one);
    }
    // Reads and writes of one workspace are serialised: no lost updates, no half-written files.
    await exclusive(id, async () => {
      const ws = await load(id); cleanLocks(ws);
      if (parts[2] === 'batch' && parts[3] === 'claim' && req.method === 'POST') { const b = await readBody(req); for (const projectId of b.projectIds || []) lock(ws, projectId, session, 'batch', b.queueId); await save(ws); return json(res, 204, null); }
      if (parts[2] === 'heartbeat' && req.method === 'POST') { const b = await readBody(req); const ids = new Set(b.projectIds || []); ws.locks = ws.locks.map(x => x.ownerId === session && ids.has(x.projectId) ? { ...x, lastSeen: Date.now() } : x); await save(ws); return json(res, 204, null); }
      if (parts[2] === 'projects' && parts[3]) {
        const projectId = decodeURIComponent(parts[3]); const p = ws.projects.find(x => x.id === projectId);
        ws.deleted = Array.isArray(ws.deleted) ? ws.deleted : [];
        // Project deletion only for the bare path: DELETE /projects/:id/lock releases the lease and must
        // never remove the project (that bug deleted a project every time an editor or the queue closed).
        if (req.method === 'DELETE' && parts.length === 4) {
          // Remove for every participant. Tombstones stop a stale client from re-uploading the project.
          ws.projects = ws.projects.filter(x => x.id !== projectId);
          ws.deleted = [{ id: projectId, at: Date.now() }, ...ws.deleted.filter(x => x.id !== projectId)].slice(0, 1000);
          ws.locks = (ws.locks || []).filter(x => x.projectId !== projectId);
          await save(ws); return json(res, 204, null);
        }
        if (req.method === 'PUT' && !p && ws.deleted.some(x => x.id === projectId)) return json(res, 410, { error: 'PROJECT_DELETED' });
        if (req.method === 'PUT') { const b = await readBody(req); if (!p) { const created = { id: projectId, name: String(b.data?.name || projectId), updatedAt: Date.now(), revision: 0, data: b.data }; ws.projects.push(created); await save(ws); return json(res, 200, created); } if (Number(b.revision) !== p.revision) return json(res, 409, { error: 'STALE_REVISION', project: p }); const bytes = JSON.stringify(b.data); if (bytes.includes('videoBytes') || bytes.includes('data:video')) return json(res, 400, { error: 'video bytes are not allowed' }); p.data = b.data; p.revision++; p.updatedAt = Date.now(); await save(ws); return json(res, 200, p); }
        if (parts[4] === 'notes' && req.method === 'PATCH') {
          // Notes are patched separately: a stale copy of the project must not overwrite everything else.
          if (!p) return json(res, 404, { error: 'project not found' });
          const body = await readBody(req);
          const notes = String(body.notes ?? '');
          p.data = p.data && typeof p.data === 'object' ? { ...p.data, notes } : { notes };
          if (!notes.trim()) delete p.data.notes;
          p.revision++; p.updatedAt = Date.now();
          await save(ws);
          return json(res, 200, p);
        }
        if (parts[4] === 'lock') { if (req.method === 'POST') { const b = await readBody(req); lock(ws, projectId, session, b.kind === 'batch' ? 'batch' : 'editor', b.queueId); await save(ws); return json(res, 204, null); } if (req.method === 'DELETE') { ws.locks = ws.locks.filter(x => !(x.projectId === projectId && x.ownerId === session)); await save(ws); return json(res, 204, null); } }
      }
      return json(res, 404, { error: 'not found' });
    });
  } catch (e) { json(res, e.status || 500, { error: e.message || 'server error' }); }
});
// Bound the whole request (including a slow upload) and headers; a stalled client must not hold a socket.
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.listen(port, () => console.log(`Workspace service → http://127.0.0.1:${port}`));
