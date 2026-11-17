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
    let apiModelRequests = 0;
    let planModelsExpired = false;
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
        await route.fulfill(planModelsExpired ? { status: 401, json: {} } : {
          json: { models: [{ id: 'plan-model', name: 'Модель подписки' }, { id: 'second-plan-model', name: 'Вторая модель' }] },
        });
      } else if (url.pathname === '/api/chatgpt-plan/complete') {
        planRequest = request.postDataJSON();
        await route.fulfill({ json: { text: 'готово' } });
      } else if (url.pathname === '/fixture/v1/models') {
        apiModelRequests++;
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
    const button = page.getByRole('button', { name: /^(Подключить подписку|Подписка ChatGPT · используется)$/ });
    const api = page.getByRole('button', { name: /^Подключение по API/ });
    const apiAddress = page.getByRole('textbox', { name: 'Адрес API', exact: true });
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await api.getAttribute('aria-expanded'), 'true');
    assert.ok(await apiAddress.isVisible());

    await button.press('Enter');
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.equal(await apiAddress.isVisible(), false);
    assert.ok(await page.getByRole('heading', { name: 'ChatGPT в Rezak' }).isVisible());
    assert.equal(await page.getByRole('link', { name: 'Открыть настройки использования ChatGPT' }).getAttribute('href'),
      'https://chatgpt.com/settings/usage');
    assert.ok(await page.getByRole('link', { name: 'Инструкция OpenAI' }).isVisible());
    assert.equal(await page.getByText('codex login --device-auth', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'auth.openai.com/codex/device', exact: true }).count(), 0);

    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
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
    assert.equal(await button.innerText(), 'Подписка ChatGPT · используется');
    assert.equal(await api.getAttribute('aria-expanded'), 'false');
    await page.getByRole('button', { name: 'Проверить подключение', exact: true }).click();
    await page.getByText(/Подключение работает: ответ «готово»/).waitFor();
    assert.equal(planRequest.model, 'plan-model');
    assert.equal(planRequest.messages[0].role, 'user');
    await page.getByRole('button', { name: '✕', exact: true }).click();
    await page.evaluate(async () => {
      const project = {
        id: 'subscription-project', name: 'Проверка модели', createdAt: 1, updatedAt: 1, version: 1,
        media: { name: 'fixture.mp4', size: 1, lastModified: 1, duration: 3, width: 640, height: 480, fps: 30,
          videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoBitrate: 0 },
        words: [{ text: 'привет', start: 0.1, end: 0.5 }], wordState: [0],
        silence: { enabled: false, thresholdDb: -42, minDuration: 1, padBefore: 0.15, padAfter: 0.12 },
        cut: { wordMargin: 0.03, fade: 0.012, minKeep: 0.06 },
        keptSilences: [], rangeCuts: [], suggestions: [], pipeline: [],
      };
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('carver', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('projects', 'readwrite');
          transaction.objectStore('projects').put(project, project.id);
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => { db.close(); reject(transaction.error); };
        };
      });
      await window.__carver.openProject(project.id);
    });
    await page.getByRole('button', { name: 'ИИ-монтаж', exact: true }).click();
    const previousApiModels = apiModelRequests;
    await page.getByRole('button', { name: /^plan-model\b/ }).click();
    const search = page.getByPlaceholder('Поиск модели подписки…');
    await search.fill('несуществующая');
    await page.getByText('Ничего не найдено', { exact: true }).waitFor();
    assert.equal(await page.getByText(/Использовать «несуществующая»/).count(), 0);
    await search.clear();
    await page.getByText('second-plan-model', { exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('carver:llm')).chatGptModel), 'second-plan-model');
    planModelsExpired = true;
    await page.getByRole('button', { name: /^second-plan-model\b/ }).click();
    await page.getByText('Войдите в ChatGPT заново в настройках ИИ.', { exact: true }).waitFor();
    assert.equal(apiModelRequests, previousApiModels);
    planModelsExpired = false;

    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('button', { name: 'ИИ (LLM)', exact: true }).click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.equal(await api.getAttribute('aria-expanded'), 'false');
    await api.click();
    assert.ok(await apiAddress.isVisible());
    assert.equal(await button.innerText(), 'Подписка ChatGPT · используется');
    await button.click();
    await page.getByRole('button', { name: 'Проверить подключение', exact: true }).click();
    await page.getByText(/Подключение работает: ответ «готово»/).waitFor();
    assert.equal(planRequest.model, 'second-plan-model');
    await page.getByRole('button', { name: 'Использовать настройки API' }).click();
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await api.getAttribute('aria-expanded'), 'true');
    assert.ok(await apiAddress.isVisible());
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
