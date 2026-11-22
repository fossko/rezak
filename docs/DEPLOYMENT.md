# Развёртывание

Редактор — статическое одностраничное приложение. Его можно разместить на любом хостинге с HTTPS. Сервис совместной работы запускается отдельным процессом Node.js по необходимости.

Храните адреса инфраструктуры, токены, пароли и ссылки рабочих пространств в локальном окружении, хранилище секретов хостинга или файле окружения сервера. Исключайте эти данные из Git.

## 1. Сборка

```bash
npm ci
npm run build
```

Загрузите **содержимое** `dist/`, включая скрытые файлы.

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

Для запуска редактора на хостинге достаточно файлов сборки. `node_modules/`, `models/`, исходные записи и `tests/` в сборку не входят.

## 2. Статический хостинг

| Настройка | Зачем |
|---|---|
| HTTPS | Service worker, File System Access API и постоянное хранилище требуют защищённого контекста. |
| `.wasm` → `application/wasm` | ONNX загружает бинарный файл WASM с этим MIME-типом. |
| Без `Cross-Origin-Opener-Policy` и `Cross-Origin-Embedder-Policy` | Эти заголовки блокируют загрузку моделей с Hugging Face. |
| `index.html` и `sw.js` → `no-cache` | Service worker должен проверять актуальность оболочки после публикации. |
| `/assets/*` → длительное кеширование с `immutable` | Имена файлов включают хеш содержимого. |
| Подстановка `index.html` для маршрутов SPA | Маршрутизация выполняется в браузере. |

Настройка `base: './'` позволяет разместить приложение в подпапке.

### nginx

Скопируйте `deploy/nginx.conf.example` в `/etc/nginx/sites-available/rezak`, подставьте домен вместо `<DOMAIN>` и добавьте символическую ссылку в `sites-enabled/`. В примерах замените заполнители перед запуском команд.

```bash
nginx -t && systemctl reload nginx
certbot --nginx -d <DOMAIN>      # или подключите свой сертификат
```

### Apache

Vite копирует `public/.htaccess` в `dist/`. Файл задаёт MIME-тип WASM и заголовки кэширования. Проверьте, что включены `mod_headers` и `mod_deflate`.

### Другой статический хостинг

Настройте MIME-тип, заголовки кэширования и подстановку `index.html` в панели управления. Если пользовательские заголовки недоступны, отключите кэширование как минимум для `index.html`. Файлы с хешами в имени можно кэшировать.

## 3. Зеркало моделей

Приложение сначала обращается к Hugging Face. При недоступности оно может загрузить модель из `<base>/models/<model-id>/resolve/main/<file>`. Зеркало пригодится в сети с ограниченным доступом.

```bash
node deploy/sync-models.mjs                 # все поддерживаемые модели
node deploy/sync-models.mjs --list           # список моделей для загрузки
node deploy/sync-models.mjs --only=whisper-large-v3-turbo,wav2vec2
```

Зеркало занимает несколько ГБ и исключено из Git. Переносите `models/` на сервер отдельно.

```bash
rsync -a models/ <user>@<host>:/srv/rezak/current/models/
```

В `deploy/nginx.conf.example` есть блок `/models/` с нужными MIME-типами и неизменяемым кэшем.

## 4. Сервис рабочих пространств

Сервис хранит **JSON проектов**. Исходные медиа остаются на компьютерах пользователей. Запустите сервис рядом со статическим сайтом и проксируйте `/api/` и `/admin` на том же источнике HTTPS.

```bash
CARVER_ADMIN_SECRET='<long-random-secret>' \
CARVER_ADMIN_USER='rezak' \
CARVER_ADMIN_PASSWORD='<long-random-password>' \
CARVER_WORKSPACE_DIR=/var/lib/rezak/workspaces \
CARVER_PUBLIC_ORIGIN='https://<DOMAIN>' \
node server/workspace-server.mjs 8787
```

| Переменная | Обязательна | Назначение |
|---|---|---|
| `CARVER_ADMIN_SECRET` | Да | Секрет для скриптов API (`Authorization: Bearer …`). |
| `CARVER_ADMIN_PASSWORD` | Да | Пароль Basic Auth для `/admin` и административного API. |
| `CARVER_ADMIN_USER` | Нет | Имя администратора, по умолчанию `rezak`. |
| `CARVER_WORKSPACE_DIR` | Нет | Постоянный каталог с правом записи, по умолчанию `./.workspaces`. |
| `CARVER_PUBLIC_ORIGIN` | В рабочей среде | Публичный источник HTTPS для формирования ссылок входа. По умолчанию `http://localhost:<port>`. |

Используйте длинные случайные значения секрета и пароля. Они нужны для запуска сервиса и хранятся вне репозитория и клиентского кода.

### Пример systemd

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

Для `/etc/rezak/workspace.env` установите права `0600` и назначьте владельцем пользователя сервиса.

```bash
CARVER_ADMIN_SECRET=...
CARVER_ADMIN_USER=rezak
CARVER_ADMIN_PASSWORD=...
CARVER_WORKSPACE_DIR=/var/lib/rezak/workspaces
CARVER_PUBLIC_ORIGIN=https://<DOMAIN>
```

### Прокси nginx

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_read_timeout 60s;
    client_max_body_size 25m;   # JSON проекта
    gzip_proxied any;
}

location /admin {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
}
```

Клиент запрашивает небольшой манифест каждые 5 секунд. gzip сокращает объём полных ответов с проектами.

### Резервное копирование

Копируйте каталог `CARVER_WORKSPACE_DIR`. В нём хранятся JSON проектов, `sessions.dat` и записи об удалениях. Проекты восстанавливаются из резервной копии этого каталога.

## 5. Проверка публикации

Перед загрузкой:

- [ ] Успешно прошли `npm run check:secrets`, `npm run typecheck`, `npm test` и `npm run build`.
- [ ] Diff свободен от реальных адресов, доменов, токенов и паролей.
- [ ] В `dist/` есть `.htaccess`, `sw.js` и WASM.
- [ ] Хеш `index-*.js` в `dist/index.html` совпадает с загружаемым файлом.

После загрузки проверьте ответы:

```bash
curl -sI https://<DOMAIN>/ | head -1                                      # 200
curl -sI https://<DOMAIN>/sw.js | grep -i cache-control                   # no-cache
curl -sI https://<DOMAIN>/ | grep -iE 'cross-origin-(opener|embedder)'    # пусто
curl -sI "https://<DOMAIN>/assets/<wasm-file>" | grep -i content-type     # application/wasm
```

Откройте сайт в Chrome, обновите страницу без кэша (⌘⇧R), откройте короткую запись и проверьте запуск расшифровки.

## 6. Откат

Для статического сайта:

1. Сохраните прежний каталог `dist/` или отдельную папку выпуска.
2. Загрузите предыдущую сборку или верните прежнюю ссылку или корневой каталог.
3. Обновите страницу без кэша, чтобы service worker подхватил предыдущую оболочку.

Для сервиса рабочих пространств:

1. Сохраните прежний `server/workspace-server.mjs` и копию каталога данных с меткой времени.
2. Остановите сервис, восстановите файл и данные, запустите сервис.
3. Если `sessions.dat` не сохранился, участникам нужно снова открыть ссылку рабочего пространства.

## 7. Скрипт `deploy/ship.sh`

```bash
CARVER_HOST=user@host.example deploy/ship.sh
CARVER_HOST=user@host.example CARVER_KEY=~/.ssh/deploy_key deploy/ship.sh
CARVER_HOST=user@host.example deploy/ship.sh --models
```

Дополнительные переменные — `CARVER_DEST` (по умолчанию `/srv/rezak/current`), `CARVER_SSH` (по умолчанию `ssh`) и `CARVER_KEY`. Скрипт собирает приложение локально и копирует `dist/` через `rsync -a --delete`. Данные рабочих пространств хранятся отдельно.

Пример `deploy/post-receive.example` показывает сборку на сервере из ветки `main` пустого Git-репозитория без рабочей копии. Для этого варианта Node.js и зависимости нужны на сервере.
