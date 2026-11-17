import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createChatGptPlan } from '../server/chatgpt-plan.mjs';

const issuer = 'https://auth.openai.com';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture' };
const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
const clientId = 'oaiapp_fixture';
const scope = 'openid chatgpt.tokens.use.direct';
let attempt;
let mode = 'success';
let calls = 0;
let revoked = false;
let renewals = 0;
const beganInference = Promise.withResolvers();

const handler = createChatGptPlan({ request: async (url, init) => {
  if (url === issuer + '/.well-known/openid-configuration') {
    return Response.json({ issuer, jwks_uri: issuer + '/fixture-keys', revocation_endpoint: issuer + '/fixture-revoke' });
  }
  if (url === issuer + '/fixture-keys') return Response.json({ keys: [key] });
  if (url === issuer + '/fixture-revoke') {
    assert.equal(init.body.get('token'), 'fixture-renewal');
    revoked = true;
    return new Response();
  }
  if (url === issuer + '/api/accounts/oauth/token') {
    if (init.body.get('grant_type') === 'refresh_token') {
      renewals++;
      assert.equal(init.body.get('refresh_token'), 'fixture-renewal');
      assert.equal(init.body.get('client_id'), clientId);
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-renewal', expires_in: 3600 });
    }
    calls++;
    assert.equal(init.body.get('client_id'), clientId);
    assert.equal(init.body.get('redirect_uri'), origin + '/auth/callback');
    const header = encode({ alg: 'RS256', kid: key.kid });
    const claims = encode({ iss: issuer, aud: clientId, sub: 'local-fixture', exp: Math.floor(Date.now() / 1000) + 600,
      nonce: mode === 'wrong-nonce' ? 'wrong' : attempt.searchParams.get('nonce') });
    const signature = sign('RSA-SHA256', Buffer.from(header + '.' + claims), privateKey).toString('base64url');
    return Response.json({ id_token: [header, claims, signature].join('.'),
      access_token: 'fixture-access', refresh_token: 'fixture-renewal', expires_in: 1,
      scope: mode === 'missing-scope' ? 'openid' : scope });
  }
  assert.equal(init.headers.Authorization, 'Bearer fixture-access');
  if (url === 'https://api.openai.com/v1/models') {
    return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Модель', visibility: 'list' },
      { slug: 'hidden', visibility: 'hidden' }] });
  }
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(JSON.parse(init.body), {
    model: 'fixture-model', store: false, stream: true,
    input: [{ role: 'developer', content: 'Инструкция' }, { role: 'user', content: 'Задача' }],
    text: { format: { type: 'json_object' } },
  });
  if (mode === 'wait') {
    beganInference.resolve();
    await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }
  const event = value => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(event({ type: 'response.output_text.delta', delta: '{"ok":true}' }) +
    (mode === 'limit' ? event({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })
      : mode === 'interrupted' ? '' : event({ type: 'response.completed' })));
} });
const server = createServer((req, res) => handler(req, res, () => res.writeHead(404).end()));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
let cookie = '';
const post = (path, data, source = origin) => fetch(origin + '/api/chatgpt-plan/' + path, {
  method: 'POST', headers: { Origin: source, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
const hostId = 'urn:uuid:00000000-0000-4000-8000-000000000001';
const state = async () => {
  const response = await fetch(origin + '/api/chatgpt-plan/status', { headers: { Cookie: cookie } });
  return response.json();
};
const finish = (state, code = 'fixture-code') => fetch(origin + '/auth/callback?' +
  new URLSearchParams({ state, code, client_id: clientId }), { headers: { Cookie: cookie }, redirect: 'manual' });
async function start() {
  const result = await post('start', { hostId });
  assert.equal(result.status, 200);
  const savedCookie = result.headers.get('set-cookie');
  assert.match(savedCookie, /HttpOnly; SameSite=Lax/);
  cookie = savedCookie.split(';')[0];
  attempt = new URL((await result.json()).url);
  assert.equal(attempt.origin, issuer);
  assert.equal(attempt.searchParams.get('redirect_uri'), origin + '/auth/callback');
  assert.equal(attempt.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(attempt.searchParams.get('code_challenge_method'), 'S256');
  return attempt.searchParams.get('state');
}
try {
  assert.equal((await post('start', { hostId }, 'https://other.example')).status, 403);
  let current = await start();
  assert.equal(attempt.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal((await finish('wrong')).status, 400);
  assert.equal(calls, 0);
  const denied = await fetch(origin + '/auth/callback?' + new URLSearchParams({ state: current, error: 'access_denied' }),
    { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(denied.status, 303);
  assert.deepEqual(await state(), { state: 'cancelled' });
  current = await start();
  const anonymous = await fetch(origin + '/auth/callback?' + new URLSearchParams({ state: current, code: 'fixture' }));
  assert.equal(anonymous.status, 400);
  mode = 'wrong-nonce';
  assert.equal((await finish(current)).status, 303);
  assert.deepEqual(await state(), { state: 'error' });
  mode = 'missing-scope';
  current = await start();
  assert.equal((await finish(current)).status, 303);
  assert.deepEqual(await state(), { state: 'unavailable' });
  mode = 'success';
  current = await start();
  assert.equal(attempt.searchParams.get('client_id'), clientId);
  assert.equal((await finish(current)).status, 303);
  assert.equal((await finish(current)).status, 400);
  assert.deepEqual(await state(), { state: 'connected' });
  const models = await Promise.all([1, 2].map(() => fetch(origin + '/api/chatgpt-plan/models', { headers: { Cookie: cookie } })));
  for (const response of models) assert.deepEqual(await response.json(), { models: [{ id: 'fixture-model', name: 'Модель' }] });
  assert.equal(renewals, 1);
  const input = { model: 'fixture-model', messages: [
    { role: 'system', content: 'Инструкция' }, { role: 'user', content: 'Задача' },
  ], json: true };
  assert.deepEqual(await (await post('complete', input)).json(), { text: '{"ok":true}' });
  mode = 'interrupted';
  assert.equal((await post('complete', input)).status, 502);
  mode = 'limit';
  assert.equal((await post('complete', input)).status, 429);
  mode = 'wait';
  const running = post('complete', input);
  await beganInference.promise;
  assert.deepEqual(await (await post('stop', {})).json(), { state: 'disconnected', revoked: true });
  assert.equal((await running).status, 401);
  assert.ok(revoked);
  assert.equal((await post('complete', input)).status, 401);
  console.log('chatgpt plan: ok');
} finally {
  await new Promise(resolve => server.close(resolve));
}
