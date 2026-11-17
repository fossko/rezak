// Run against the production build: node tests/subscription-instructions.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
try {
  const browser = await chromium.launch({
    channel: 'chrome', executablePath: process.env.CARVER_CHROME_PATH || undefined, headless: true,
  });
  try {
    const { port } = server.httpServer.address();
    const origin = `http://127.0.0.1:${port}`;
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const apiSettings = { provider: 'custom', url: origin + '/fixture/v1', key: 'fixture', model: 'fixture-model' };
    await page.addInitScript((settings) => localStorage.setItem('carver:llm', JSON.stringify(settings)), apiSettings);
    const errors = [];
    const externalRequests = [];
    const apiRequests = [];
    let planState = 'disconnected';
    let planRequest;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        externalRequests.push(url.origin);
        await route.abort();
      } else if (url.pathname === '/api/chatgpt-plan/status') {
        await route.fulfill({ json: { state: planState } });
      } else if (url.pathname === '/api/chatgpt-plan/start') {
        assert.match(request.postDataJSON().hostId, /^urn:uuid:/);
        planState = 'pending';
        await route.fulfill({ json: { url: 'https://auth.openai.com/api/accounts/authorize?state=fixture' } });
      } else if (url.pathname === '/api/chatgpt-plan/models') {
        await route.fulfill({ json: { models: [{ id: 'plan-model', name: 'Модель подписки' }] } });
      } else if (url.pathname === '/api/chatgpt-plan/complete') {
        planRequest = request.postDataJSON();
        await route.fulfill({ json: { text: 'готово' } });
      } else if (url.pathname === '/fixture/v1/models') {
        await route.fulfill({ json: { data: [{ id: 'fixture-model' }] } });
      } else if (url.pathname.startsWith('/fixture/')) {
        apiRequests.push(url.pathname);
        await route.abort();
      } else {
        await route.continue();
      }
    });

    await page.goto(origin);
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'ИИ (LLM)', exact: true }).click();
    const button = page.getByRole('button', { name: 'Подключить подписку', exact: true });
    const codex = page.getByRole('heading', { name: 'Codex (ChatGPT)', exact: true });
    const claude = page.getByRole('heading', { name: 'Claude Code', exact: true });
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await codex.isVisible(), false);

    await button.press('Enter');
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.ok(await codex.isVisible());
    assert.ok(await claude.isVisible());
    assert.ok(await page.getByText('codex login --device-auth', { exact: true }).isVisible());
    assert.ok(await page.getByText('claude auth login', { exact: true }).isVisible());
    assert.equal(await page.getByRole('link', { name: 'auth.openai.com/codex/device', exact: true }).getAttribute('href'),
      'https://auth.openai.com/codex/device');
    assert.equal(await page.getByRole('link', { name: 'Справка по входу в Codex' }).getAttribute('href'),
      'https://learn.chatgpt.com/docs/auth#login-on-headless-devices');
    assert.equal(await page.getByRole('link', { name: 'Справка по входу в Claude Code' }).getAttribute('href'),
      'https://code.claude.com/docs/en/authentication');

    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await codex.isVisible(), false);
    assert.equal(await claude.isVisible(), false);
    assert.ok(await page.getByRole('button', { name: 'Проверить подключение', exact: true }).isVisible());
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('carver:llm')));
    assert.deepEqual(saved, apiSettings);
    await button.click();
    await page.getByRole('button', { name: 'Продолжить с ChatGPT' }).click();
    const authorization = page.getByRole('link', { name: 'Открыть страницу входа ChatGPT' });
    await authorization.waitFor();
    assert.match(await authorization.getAttribute('href'), /^https:\/\/auth\.openai\.com\//);
    planState = 'connected';
    const models = page.getByLabel('Модель подписки ChatGPT');
    await models.selectOption('plan-model');
    await page.getByRole('button', { name: 'Проверить подключение', exact: true }).click();
    await page.getByText(/Подключение работает: ответ «готово»/).waitFor();
    assert.equal(planRequest.model, 'plan-model');
    assert.equal(planRequest.messages[0].role, 'user');
    await page.getByRole('button', { name: 'Использовать настройки API' }).click();
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('carver:llm')));
    assert.equal(after.chatGptPlan, false);
    assert.equal(after.key, apiSettings.key);
    assert.equal(after.url, apiSettings.url);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(apiRequests, []);
    assert.deepEqual(errors, []);
    console.log('subscription instructions: ok');
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
