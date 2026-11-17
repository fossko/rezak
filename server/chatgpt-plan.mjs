import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const auth = 'https://auth.openai.com';
const api = 'https://api.openai.com/v1';
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const planScope = 'chatgpt.tokens.use.direct';
const prefix = '/api/chatgpt-plan/';
const callback = '/auth/callback';
const random = () => randomBytes(32).toString('base64url');
const cookieName = 'rezak_chatgpt';

function result(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', ...headers });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw Object.assign(new Error(), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error(), { status: 400 }); }
}

async function responseText(response) {
  let buffer = '';
  let text = '';
  let completed = false;
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      const event = JSON.parse(payload);
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
      if (event.type === 'response.completed') completed = true;
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
        const code = event.response?.error?.code ?? event.code;
        const status = code === 'subscription_sharing_usage_limit_exceeded' ? 429
          : code === 'subscription_sharing_usage_unavailable' ? 403 : 502;
        throw Object.assign(new Error(), { status });
      }
    }
  }
  if (!completed) throw new Error('Incomplete stream');
  return text;
}

export function createChatGptPlan({ request = fetch } = {}) {
  const sessions = new Map();
  async function upstream(url, init = {}) {
    const timeout = AbortSignal.timeout(url === api + '/responses' ? 5 * 60_000 : 20_000);
    return request(url, { ...init, redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  }
  const form = (url, fields) => upstream(url, { method: 'POST', body: new URLSearchParams(fields) });

  async function identity(token, clientId, nonce) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) throw new Error('Invalid identity token');
    const [header, body, signature] = parts;
    const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url'));
    if (alg !== 'RS256' || typeof kid !== 'string') throw new Error('Invalid identity key');
    const metadata = await (await upstream(auth + '/.well-known/openid-configuration')).json();
    if (metadata.issuer !== auth || new URL(metadata.jwks_uri).origin !== auth) throw new Error('Invalid issuer');
    const { keys } = await (await upstream(metadata.jwks_uri)).json();
    const jwk = keys.find(key => key.kid === kid && key.kty === 'RSA');
    if (!jwk || !verify('RSA-SHA256', Buffer.from(header + '.' + body), createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(signature, 'base64url'))) throw new Error('Invalid identity signature');
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== auth || !audiences.includes(clientId) ||
      ((audiences.length > 1 || claims.azp) && claims.azp !== clientId) ||
      typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() ||
      claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid identity claims');
    return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : '' };
  }

  function applyTokens(session, tokens) {
    if (typeof tokens.scope !== 'string' || !tokens.scope.split(/\s+/).includes(planScope) ||
      typeof tokens.access_token !== 'string' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
      session.state = 'unavailable';
      session.access = session.refresh = '';
      return;
    }
    session.access = tokens.access_token;
    session.refresh = tokens.refresh_token || session.refresh;
    session.expires = Date.now() + tokens.expires_in * 1000;
    session.state = 'connected';
  }

  async function access(session) {
    if (session?.state !== 'connected') return '';
    if (session.expires > Date.now() + 30_000) return session.access;
    session.refreshing ??= (async () => {
      if (!session.refresh) { session.state = 'expired'; return; }
      const response = await form(auth + '/api/accounts/oauth/token', {
        grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refresh, resource: api,
      });
      if (response.status >= 500 || response.status === 429) throw Object.assign(new Error(), { status: 503 });
      if (!response.ok) { session.state = 'expired'; session.access = session.refresh = ''; return; }
      const tokens = await response.json();
      applyTokens(session, { ...tokens, scope: tokens.scope ?? scope });
    })().finally(() => { session.refreshing = null; });
    await session.refreshing;
    return session.state === 'connected' ? session.access : '';
  }

  return async function chatGptPlan(req, res, next) {
    const path = req.url.split('?')[0];
    if (!path.startsWith(prefix) && path !== callback) return next();
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    const isLoopback = value => value === '127.0.0.1' || value === '::ffff:127.0.0.1';
    if (!isLoopback(req.socket.localAddress) || !isLoopback(req.socket.remoteAddress) ||
        req.headers.host !== new URL(origin).host ||
        (path !== callback && (req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.method === 'POST' && req.headers.origin !== origin)))) return result(res, 403, { error: 'LOCAL_ONLY' });

    const id = req.headers.cookie?.match(/(?:^|;\s*)rezak_chatgpt=([\w-]{43})(?:;|$)/)?.[1];
    let session = sessions.get(id);
    try {
      if (path === prefix + 'start' && req.method === 'POST') {
        const body = await readJson(req);
        if (!/^urn:uuid:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body?.hostId ?? '')) {
          return result(res, 400, { error: 'HOST_INVALID' });
        }
        if (session?.state === 'connected' || session?.state === 'exchanging') {
          return result(res, 409, { error: 'SIGN_IN_ACTIVE' });
        }
        for (const [key, value] of sessions) {
          if (value.state !== 'connected' && value.deadline < Date.now()) sessions.delete(key);
        }
        if (sessions.size >= 16 && !sessions.has(id)) return result(res, 429, { error: 'TOO_MANY_SESSIONS' });
        const sessionId = id && sessions.has(id) ? id : random();
        for (const request of session?.requests ?? []) request.abort();
        session = { clientId: session?.hostId === body.hostId ? session.clientId : undefined,
          subject: session?.hostId === body.hostId ? session.subject : undefined, hostId: body.hostId, state: 'pending',
          attempt: random(), nonce: random(), verifier: random(), deadline: Date.now() + 10 * 60_000, requests: new Set() };
        sessions.set(sessionId, session);
        const url = new URL(auth + '/api/accounts/authorize');
        url.search = new URLSearchParams({
          client_id: session.clientId || 'dynamic_agent_client',
          ...(session.clientId ? {} : { agent_name_hint: 'Rezak' }),
          ext_agent_host_id: body.hostId, response_type: 'code', redirect_uri: origin + callback,
          scope, resource: api, state: session.attempt, nonce: session.nonce,
          code_challenge_method: 'S256', code_challenge: createHash('sha256').update(session.verifier).digest('base64url'),
        }).toString();
        return result(res, 200, { url: url.href }, {
          'Set-Cookie': `${cookieName}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`,
        });
      }
      if (path === callback && req.method === 'GET') {
        const query = new URL(req.url, origin).searchParams;
        if (session?.state !== 'pending' || session.deadline < Date.now() || query.get('state') !== session.attempt) {
          return result(res, 400, { error: 'AUTH_STATE_INVALID' });
        }
        const { nonce, verifier } = session;
        session.state = 'exchanging';
        delete session.verifier;
        delete session.nonce;
        delete session.attempt;
        try {
          if (query.get('error')) session.state = query.get('error') === 'access_denied' ? 'cancelled' : 'error';
          else {
            const clientId = query.get('client_id') || session.clientId;
            const code = query.get('code');
            if (!code || !/^oaiapp_[\w-]+$/.test(clientId ?? '') ||
                (session.clientId && clientId !== session.clientId)) throw new Error('Registration failed');
            const tokenResponse = await form(auth + '/api/accounts/oauth/token', {
              grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier,
              redirect_uri: origin + callback, resource: api,
            });
            if (!tokenResponse.ok) throw new Error('Exchange failed');
            const tokens = await tokenResponse.json();
            const { subject, email } = await identity(tokens.id_token, clientId, nonce);
            if (session.subject && session.subject !== subject) throw new Error('Account changed');
            session.clientId = clientId;
            session.subject = subject;
            session.email = email;
            applyTokens(session, tokens);
          }
        } catch { session.state = 'error'; }
        res.writeHead(303, { Location: '/?chatgpt-plan=return', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end();
      }
      if (path === prefix + 'status' && req.method === 'GET') {
        if (session?.state === 'pending' && session.deadline < Date.now()) session.state = 'expired';
        return result(res, 200, { state: session?.state ?? 'disconnected',
          ...(session?.state === 'connected' && session.email ? { account: session.email } : {}) });
      }
      if (path === prefix + 'stop' && req.method === 'POST') {
        if (session) {
          const old = session;
          if (old.state === 'exchanging') return result(res, 409, { error: 'SIGN_IN_FINISHING' });
          sessions.set(id, { clientId: old.clientId, subject: old.subject, hostId: old.hostId,
            state: 'disconnected', deadline: Date.now() + 10 * 60_000 });
          for (const request of old.requests ?? []) request.abort();
          if (old.refreshing) await old.refreshing.catch(() => {});
          let revoked = !old.refresh;
          if (old.refresh) {
            try {
              const metadata = await (await upstream(auth + '/.well-known/openid-configuration')).json();
              if (new URL(metadata.revocation_endpoint).origin === auth) {
                revoked = (await form(metadata.revocation_endpoint, { token: old.refresh,
                  token_type_hint: 'refresh_token', client_id: old.clientId })).ok;
              }
            } catch { /* the session was cleared locally */ }
          }
          return result(res, 200, { state: 'disconnected', revoked });
        }
        return result(res, 200, { state: 'disconnected', revoked: true });
      }
      if (path === prefix + 'models' && req.method === 'GET') {
        const token = await access(session);
        if (!token || sessions.get(id) !== session) return result(res, 401, { error: 'SIGN_IN_REQUIRED' });
        const response = await upstream(api + '/models', { headers: { Authorization: 'Bearer ' + token } });
        if (response.status === 401) session.state = 'expired';
        if (!response.ok) return result(res, response.status, { error: 'MODELS_UNAVAILABLE' });
        const { models } = await response.json();
        return result(res, 200, { models: models.filter(model => model.visibility === 'list' && typeof model.slug === 'string')
          .map(model => ({ id: model.slug, name: model.display_name || model.slug })) });
      }
      if (path === prefix + 'complete' && req.method === 'POST') {
        const body = await readJson(req);
        const roles = new Set(['system', 'user', 'assistant']);
        if (typeof body?.model !== 'string' || !body.model || !Array.isArray(body.messages) ||
            !body.messages.length || !body.messages.every(msg => roles.has(msg?.role) && typeof msg.content === 'string')) {
          return result(res, 400, { error: 'REQUEST_INVALID' });
        }
        const token = await access(session);
        if (!token || sessions.get(id) !== session) return result(res, 401, { error: 'SIGN_IN_REQUIRED' });
        const cancellation = new AbortController();
        res.on('close', () => cancellation.abort());
        if (res.destroyed) return;
        session.requests.add(cancellation);
        try {
          const response = await upstream(api + '/responses', { method: 'POST', signal: cancellation.signal,
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: body.model, store: false, stream: true,
              input: body.messages.map(({ role, content }) => ({ role: role === 'system' ? 'developer' : role, content })),
              ...(body.json ? { text: { format: { type: 'json_object' } } } : {}) }),
          });
          if (response.status === 401) session.state = 'expired';
          if (!response.ok) return result(res, response.status, { error: 'INFERENCE_UNAVAILABLE' });
          const text = await responseText(response);
          if (!res.destroyed) return sessions.get(id) === session
            ? result(res, 200, { text }) : result(res, 401, { error: 'SIGN_IN_REQUIRED' });
        } catch (error) {
          if (!res.destroyed && sessions.get(id) !== session) return result(res, 401, { error: 'SIGN_IN_REQUIRED' });
          throw error;
        } finally {
          session.requests.delete(cancellation);
        }
        return;
      }
      return result(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (!res.destroyed) return result(res, error.status || 502, { error: 'CHATGPT_PLAN_ERROR' });
    }
  };
}
