# Carver — history of requests, decisions and measurements

Chronological record of what the user asked for, what was built, and what was measured, so later
agents understand *why* the code is the way it is. Dates are 2026-10-22/23 (Europe/Moscow).

## 1. MVP (initial request)

Request: browser-based local-first editor for long recorded Russian monologues; remove-only editing
("carving a statue from stone"); text editor as the main UI with a small preview in the corner;
silence removal (> 1 s, adjustable noise floor and padding, like Recut); Chrome only; GPU/Apple
Silicon; hosted as a website for the crew; reuse `whisper-web` (word-accurate STT); all models
downloaded and cached on first run. Phase 2: LLM auto-carving of false starts/slips.

User answers to clarifying questions: Russian speech only; Russian UI; export = rendered MP4 via
WebCodecs **plus** SRT/JSON, and reuse whisper-web's LLM pipeline (chapters, timecodes, structured text,
promo texts) in one pipeline; runtime < 1.5 h but files up to ~10 GB/h → lazy decoding + virtualized
editor from the start; any OpenAI-compatible LLM; autosave projects locally; `node_modules` inside the
workspace (Nextcloud); deployment to plain virtual hosting (not a VPS).

Built: everything in the module map of `AGENTS.md`. Measured on the 31.6-min test video (M4 Max):
open + audio 7 s; transcription 3.5 min (≈ 9× real time, 3818 words); export of a 27.6-min result
≈ 1.8 min (≈ 15×); preview 29.7 fps with 0 late frames across joins; exported frames match the source
(±1 frame) and audio is in sync to ±0.1 ms after AAC priming compensation (2112 frames).

## 2. Playback speed

Request: 0.75 / 1 / 1.25 / 1.5 / 2× for preview only, not export.
Built: WSOLA time stretch (pitch preserved). Measured: exact output lengths, pitch unchanged (180 Hz
tone), 93× real-time processing; in Chrome 1.98× / 1.49× / 0.74× advance per wall second.

## 3. Filler sounds («ааа, эээ, ммм, эммм»)

Built: acoustic detection in gaps between Whisper words + wav2vec2 veto; orange ‹эээ› tokens; auto-cut
option; sensitivity. Found on the real video: 23 / 50 / 60 (строго / обычно / чувствительно), ≈ 5 s.
Side fix (important): Whisper segment timestamp drift squeezed words into too little audio (e.g. ~80
words in 29 s while real speech ran 17 s longer around 28:00). Alignment now uses next-segment context,
an earlier start and "squeezed" retries; false pauses of 17.7 / 15.8 / 11.2 s disappeared.

## 4. Мат tab, mute, MP3, «Сохранить всё»

Request (in Russian): port whisper-web's profanity muting into a tab «Мат» after «Монтаж»; two modes —
cut or mute; hotkey **M** mutes a word in the transcript, muted words look dark grey; base word list,
custom words comma-separated (regexp-checked), «Заглушить / вырезать», «Почистить мат». Also export
video **and** MP3 at once, with a separate "mute or not" choice for each — the user's scenario: video
WITH мат, audio WITHOUT; cuts identical so lengths are identical. Chrome asks for folder access for
bulk saving; «save everything» (video, audio, subtitles, all text results).
Measured: MP3 vs MP4 audio lag 0.0 ms; muted word −32 dBFS in video vs −180 dBFS in MP3; lengths
102.80 s (video) / 102.82 s (MP3).

## 5. Deployment questions

`file://` shows a blank page (expected; added `serve.mjs`). Generic virtual hosting works: HTTPS, `.wasm`
MIME (handled by `.htaccess` on Apache), no COOP/COEP.

## 6. Fast track and UI polish

Request: dragging a file splits the screen 50/50 — left = open as usual, right = fast track
(transcribe → mute мат → LLM edit with STRICT setting) so the user can grab a coffee and review later;
visible spinner + status near the AI button; model dropdown that fetches models from the provider when
clicked or when endpoint/key are pasted; «Вырезано: N%» in the top-right; gear icon instead of «Настройки».
Decision: "STRICT" interpreted as «осторожно» (conservative); user has not confirmed.
Measured: fast track on the 2.5-min clip finished unattended in 54 s (7 fillers cut, 1 мат muted, 11 AI cuts).

## 7. LLM time-to-first-token

Report: TTFT > 30 s in Carver while the same model responds in < 1 s in another harness.
Finding: the server streams from 0.13 s, but "thinking" models first emit reasoning tokens
(gemma4: ~7 000 chars ≈ 32 s) which Carver discarded; plus ~14 s Ollama model swap on a cold start.
Thinking off → first answer token in 0.1–2.9 s, but gemma4's cuts degraded badly (whole meaningful
sentences marked as filler). Built: live phases («ожидание ответа сервера», «модель размышляет · N симв.»,
«пишет ответ», retries), «Размышления модели» setting (auto / поменьше / выключить) with provider-specific
params, timing breakdown in «Проверить подключение», `tests/llm-timing.ts`. Default stays `auto`.
Open question: which provider/model the user runs in production (likely DeepSeek); untested without a key.

## 8. Editable cut regions (waveform handles)

Request: red regions in the waveform become clickable; two draggable handles at pixel precision of the current
zoom; custom edges override automatic ones, stay tied to the transcript element (word, filler, silence) — cutting
it off disables the region, cutting again restores the custom edges; double-click resets. User decisions:
~1 ms/px deep zoom; regions must never overlap/merge; listening on demand only (no auto-play); keyboard nudging
required; custom edges are never affected by automatic settings; double-click resets only that region (no
global reset button).
Measured: zoom reaches 0.9 ms/px; a 25 px drag moved the edge 23.2 ms (expected 23.6 ± 0.9); ←×3 = −2.7 ms;
Shift+→ = +9.4 ms; no-overlap clamp left 61 ms (min 60) to the neighbour; custom pause edge unchanged after
threshold −6 dB and padding 0.3 s; export kept segments end/start exactly at the custom edges; 0/20 frame
mismatches.

## 9. Заставки (intros/outros/headers)

Request: a «Заставки» tab; short intro/outro/header videos from disk, inserted at the playhead as a single fragment
with adjustable edges, green on the timeline; delete removes it; insert/remove shifts later segments; many supported;
`glvrd-intro-clean.mp4` as the example.
Built: composite timeline (main + titles interleaved), library in IndexedDB (bytes stored, titles are short), insert at
playhead (anchor = source time), green markers with trim handles (left=in, right=out), Delete removes, double-click
resets trim, player and MP4/MP3 export decode per source (title frames scaled to main size, title audio resampled once),
subtitles and timecoded text use the composite mapping. The waveform stays in source time, so a title is a green marker
at its anchor.
Measured: inserting a 3.75 s intro made the result 107.45 s (= 103.70 s main + 3.75 s); `srcToOut(anchor±0.5 s)` differ by
exactly 1.0 s of main plus the title; the exported title frame matches the source intro at 71.4 dB and a post-title main
frame at 65.4 dB; regressions all pass (export 0/24, mute/save-all OK, seamless 30 fps, navigation, zoom, rate, unit
tests). Bugs fixed along the way: the composite video export sampled frames at their start instead of their middle
(half-frame offset), and the main audio sink was left null so main content exported as silence.

## 10. Repository notes

The project later moved between folders. The current feature state and open decisions are in
[STATUS.md](STATUS.md); setup and test instructions are in [DEVELOPMENT.md](DEVELOPMENT.md).

## 11. App rename to «Резак» + playback-start audio gap

Rename: user-facing name changed from "Carver" to **«Резак»** (browser tab title, top-left brand text,
in-app prose, fast-track notification, export filename suffix `(резак)`); the top-left logo SVG was
removed. Internal `carver` kept: package name, `carver:` localStorage keys, `.carver.json` format +
`{app:'carver'}` marker, HTML ids (`#carver-*`), test hooks (`window.__carver*`), SW cache names, code
comments/docs.

Bug (user-reported): starting preview playback gave seconds of silence before the audio came in, then it
was in sync. It grew with the playback position and got much worse at playback speeds other than 1×. The
backup build (`carver_backup4`) does not have it.

Root cause (composite/заставки refactor): `audioLoop` starts at `tl.clips[0]` and iterates **every** clip,
decoding each clip's audio with `asink.buffers(a, b0)` even when the clip ends before the seek point. The
late-trim (`if (lateBy > 0) { if (lateBy >= dur2) continue; … }`) then discards every buffer of those
already-past clips — but the decode happened. So seeking to position X first decoded O(X) of audio and
threw it away; at `rate !== 1` each clip additionally runs through the WSOLA stretcher, which is ~93×
real-time, making it far worse. The previous `primeAudio` fix only warmed the first buffer and did not
address the O(X) pre-seek decode (hence "didn't help").

Fix: `if (clipEnd(clip) <= from) continue;` at the top of the `audioLoop` body (the `videoLoop` already
did this with `if (end <= o) continue`). `primeAudio` is kept as a cheap cold-decoder warm-up.

Measured on the real 31.6-min video (headless Chrome, time from `play()` to first scheduled audio):
before → rate 1: 55 ms @5 min, 1494 ms @15 min, 2559 ms @25 min, >20 s @30 min; rate 2: 4.1 s / 12.2 s /
20.6 s; rate 0.75: 10 s / >20 s / >20 s. after → every position and every rate ≈ 50–60 ms; `open`/`play`/
`rate` regression passes.

## 12. Pause jumped the playhead forward

Bug (user-reported): pressing Space to pause while playing moved the playhead 5–10 words forward, so
resuming did not continue from where playback stopped. Root cause: `pause()` did `outPos = current` and
*then* called `stopAll()`, which also does `outPos = current`. Because `acStart` was unchanged, the second
`current` was `outPos + elapsed` — the already-saved position plus the elapsed playback time again — so
the elapsed time was counted twice (jump = how long playback had been running). Fix: drop the redundant
`outPos = current` in `pause()`; `stopAll()` saves it exactly once. Verified: before the fix, playing 4 s
then pausing moved the position from 63.91 s to 67.82 s (+3.91 s ≈ the elapsed time); after the fix,
playing 1 / 4 / 10 / 20 s then pausing gives a jump of 0.000 s in every case. `open`/`play`/`rate` pass.

## 13. Word scrubbing (audible selection)

Request: selecting a word should play the first few ms of its audio to make stepping through the
transcript feel responsive; moving to the next word must cut the previous snippet and play the new one.
Enable/disable in Settings with an adjustable snippet size (20–200 ms; the first pass capped at 60 ms, then
the user asked for up to 200 ms "to have more to play with").

Built: `Player.scrub(at, ms)` decodes the first audio packets at the word's **source** start and schedules
them on the shared `master` gain (respects volume, does not move the playhead). It is interruptible — every
call runs `stopScrub()` first, which bumps a token and stops any still-playing snippet; in-flight decodes
from the previous call are ignored via the token. Scrub is skipped while normal playback is running, and
`startAll()`/`destroy()` stop it. `hub.scrubWord(i)` gates on `prefs.scrub` and uses `prefs.scrubMs`.
Triggers: mouse click and drag in the transcript, and ←/→/↑/↓ keyboard moves (when paused).
Settings: «Скраб: короткий звук при выборе слова» — Вкл/Выкл + a 20–200 ms slider (default 40 ms).

Measured (headless Chrome, counting scheduled AudioBufferSource durations): a word click schedules 3
packets ≈ 0.040 s; the size slider at 20 / 100 / 200 ms schedules 0.020 / 0.100 / 0.200 s; turning scrub
off schedules 0 sources; rapidly scrubbing a second word stops the first snippet's still-playing sources
(3 of 4 stopped after 30 ms). No effect on normal playback.

## 14. «Selection follows playhead» toggle

Request: an explicit setting — when on, playback automatically selects the current word and pausing leaves
the selection on the word under the playhead; when off, selection stays wherever the user clicked (the old
behaviour). Toggle in Settings, plus Opt+F.

Built: new pref `selFollow` (default **off**, so nothing changes unless enabled). In `TranscriptView`'s
`onTime` handler, when `prefs.selFollow` is on and the playhead word differs from the focused word, it calls
`S.setSelection({a: word, b: word})` (using the last word whose start ≤ playhead, so a pause in a gap keeps
the selection on the preceding word). This covers playing, seeking and pausing because `pause()` also emits
`time`. Settings gets a Вкл/Выкл row labelled «Выделение следует за воспроизведением» with an Opt+F hint;
`Editor.tsx` toggles it on `Alt+F` (with a toast). The pre-existing «следовать» checkbox in the text panel
is unchanged and still means *scroll* the transcript with playback — the new setting is about selection, and
the hint says so.

Measured (Chrome, with the service worker bypassed): follow off — click word 20, play 2 s, pause: selection
stays `{20,20}`. Follow on via Opt+F — seek to 20 s while paused selects word 59 (the word there); play 2.5 s
moves the selection to word 63; pause leaves the playhead word 63 and selection `{63,63}` (PASS). Opt+F again
turns it off. Note: the test initially appeared broken because the service worker served a stale cached
bundle after the local server had died — not a code bug; hard-reload (⌘⇧R) after deploying.

## 15. Local model mirror as a Hugging Face fallback

Request: Hugging Face may block the country, so the transcription models should live locally and only be
served when the client cannot reach HF.

Built: `deploy/sync-models.mjs` mirrors the exact dtype variants the app can request into `models/`, using
HF's own layout (`models/<model-id>/resolve/main/<file>`): whisper-large-v3-turbo (encoder fp32 + its
external `encoder_model.onnx_data`, fp16/q4/q8; decoder q4/q8), wav2vec2-large-xlsr-53-russian (fp16/q4/q8),
whisper-small and whisper-base (encoder fp32/q8, decoder q4/q8), plus each repo's config/tokenizer JSONs —
**~8 GB**. `models/` is gitignored and
synced to the server separately (the deploy hook leaves it untouched). In `speech.worker.ts` `env.fetch` is
wrapped: try HF first (20 s timeout); on a network error, non-200 or timeout, retry the same path against
`<app-base>models/`. transformers.js still caches the response under the HF URL, so the mirror is only hit
on a cache miss while HF is unreachable. Serving: `serve.mjs` and the Vite dev/preview plugin map `/models/`
to the folder; nginx gets a `/models/` alias with immutable caching (`deploy/nginx.conf.example`).
Follow-up: production nginx logs showed a client falling back to the **fp32** encoder and getting 404 on
`encoder_model.onnx` + `encoder_model.onnx_data`; both were added to the mirror and re-synced (2.55 GB).

Tradeoffs discussed with the user: mirror traffic now comes from the VPS instead of HF's CDN; ~5.4 GB of
disk; and the dtype/file-tree trap (`q8` → `_quantized`, `fp16` → `_fp16`, `q4` → `_q4`, `fp32` → no
suffix) — a missing variant only fails for the device that asks for it.

Measured: with `huggingface.co` mapped to a dead IP at the DNS level (Chrome `--host-resolver-rules`, so Web
Worker fetches are affected too) and a fresh browser profile, the worker logged «Hugging Face unavailable —
serving models from the local mirror», loaded the models in ~50 s and transcribed the 2.5-min clip to 264
words. With HF reachable, a plain page/worker fetch returns 200 and the mirror is not touched; the one mixed
case seen in testing was cache revalidation in a long-lived test profile (the proxy answered 206, which
transformers.js rejects anyway). Regression `open`/`play`/`rate` passes.

## 16. Hide the model card on Home once models are cached

Request: once the speech models are downloaded and cached, hide «Модели распознавания речи» on the Home
screen for a cleaner look.

Built: the card in `Home.tsx` renders only when `!modelsReady()`. The ready flag is per model
(`carver:modelsReady:<model>`), so switching to an uncached model brings the card back with its
«Загрузить» button/progress; Settings still has «Проверить / загрузить снова» for a forced re-download.

Measured: with the ready flag set, Home shows only «Проекты» (`home-ready.png`); with a fresh profile the
card is present and shows download progress (`home-notready.png`).

## 17. Playhead может стоять внутри вырезанного фрагмента

Request: при включённом «Выделение следует за воспроизведением» (Opt+F) невозможно выделить вырезанное
слово: playhead не даёт встать в удалённую область и выдавливает выделение. Нужно разрешить playhead
стоять где угодно, а вырезанное пропускать только при запросе на воспроизведение.

Built: у `Player` появилась `parked` — SOURCE-позиция на паузе. `seekSrc()` на паузе паркует ровно в
запрошенную точку (в том числе внутри выреза) и отдаёт её в `time`; `currentSrc` возвращает `parked`;
`play()` переводит парковку в ближайший сохранённый кадр и только там начинает воспроизведение;
`seek(out)` парковку сбрасывает. Output-таймлайн не менялся, поэтому экспорт и склейки не затронуты.

Measured: на проде (сборка до фикса) клик в середину вырезанных слов 40–44 давал `src` 18.05 и выделение
уезжало на слово 45. После фикса `src` 17.33 — ровно начало слова 42, выделение остаётся 42; Play уводит
playhead на сохранённое слово 52. Файл `short file passes.mp4`, 1822 слова.

## 18. Заставка в ProRes ломала экспорт

Request: «Ошибка экспорта: This video track cannot be decoded in this environment. Make sure to check
decodability before using a track» — предположительно из-за вставленной заставки.

Причина: заставка была Apple ProRes 422 HQ (`apch`, .mov). WebCodecs в Chrome этот кодек не декодирует
вообще, а проверки не было — ошибка вылетала из mediabunny уже в середине экспорта, английским текстом.

Built: `assertDecodable()` в `lib/titles.ts` проверяет `canDecode()` видео и звука — при добавлении в
библиотеку и при открытии (`openTitle`, то есть и превью, и экспорт). Сообщение русское: называет кодек и
объясняет, как перекодировать (QuickTime → «Экспортировать» → 1080p либо `avconvert --preset
Preset1920x1080`). Добавлены `replaceTitleFile()` / `Store.replaceTitle()` и кнопка «↻ Заменить файл»:
файл подменяется, id и все вставки сохраняются, трим подрезается под новую длительность.

Measured: ProRes отклоняется при добавлении (библиотека не меняется, тост с текстом), H.264 принимается;
для проекта с уже вставленной ProRes-заставкой после замены файла: `videoCodec` prores → avc, вставка
осталась (1), композит пересобрался (49 клипов), экспорт пошёл 1% → 49% без ошибок.

## 19. Вкладка «Аудио»: LUFS и сравнение с рекомендациями YouTube

Request: подключить модуль анализа LUFS, добавить вкладку «Аудио», показывать громкость в LUFS и сравнивать
её с рекомендациями YouTube.

Built: `src/lib/loudness.ts` — измеритель ITU-R BS.1770-4: K-взвешивание с коэффициентами, пересчитанными
под фактическую частоту дискретизации (как в libebur128/pyloudnorm), блоки 400 мс с шагом 100 мс, гейты
−70 LUFS и −10 LU, плюс short-term 3 с, LRA по EBU Tech 3342 и оценка true peak (4× интерполяция
Catmull-Rom по громким локальным максимумам). Всё считается одним потоковым проходом, без копий PCM.
`Store.analyzeAudio()` — отменяемая задача с прогрессом и кэшем по проекту; `AudioPanel` показывает
интегрированную громкость, вердикт относительно цели −14 LUFS (±1 LU), шкалу с зоной допуска, true peak
против потолка −1 dBTP, пик сэмплов, максимум за 3 с, LRA и число блоков; вкладка открывается в
существующей полосе (пришлось разрешить перенос вкладок — седьмая больше не обрезается).

Measured: файл 798 с — приложение считает −25.70 LUFS за 203 мс, pyloudnorm на том же PCM даёт −25.70;
синус 1 кГц с пиком −20 dBFS — −23.09 против −23.08 у pyloudnorm; true peak −1.55 dBTP при пике сэмплов
−1.61 dBFS. Оговорки выведены в интерфейс: замер идёт по моно-PCM 16 кГц (для широкого стерео возможна
разница 1–3 dB), true peak поэтому может быть занижен.

## 20. Выравнивание громкости: leveler по фразам + мастер-цепочка

Request: автоматически приводить весь трек к target LUFS, не портя звук: медленный leveler по фразам,
изменение усиления только в паузах, на мастере мягкий компрессор (порог −7,5 dB, 5:1) и жёсткий лимитер
−0,1 dB для безопасности; три силы leveler'а 50/75/100%, цель — в настройках.

Built: `src/lib/leveler.ts` — фразы режутся по паузам ≥ 0,35 с, громкость фразы меряется как в метре
(K-взвешивание + гейтированные блоки 400 мс), усиление = strength × (target − LUFS фразы), переходы
усиления живут внутри паузы (ramp 20–150 мс по её середине). Усиление калибруется прогоном той же
мастер-цепочки (иначе компрессор отнимал 2 дБ и «100%» не попадал в цель). `src/lib/masterchain.ts` —
компрессор с мягким коленом (−7,5 dB, 5:1, attack 8 мс, release 120 мс, без makeup) и brickwall-лимитер
−0,1 dBFS. Всё встроено в существующий потоковый рендер (`streamAudioComposite`), поэтому одинаково
работает и для MP4, и для MP3. Настройки — вкладка «Аудио»: цель LUFS, сила 50/75/100%, «Выравнивать при
экспорте» (в `prefs`, `carver:prefs`).

Measured (файл 798 с, 1822 слова, 169 фраз), после подстройки потолков — leveler не более +11 dB, компрессор
−5 dB, лимитер −1 dBFS: 100% — **−15.68 LUFS**, TP −0.14 dBTP, пик сэмплов −0.11 dBFS после AAC; компрессор
забирает 4,7 dB (было 17,3 до подстройки). Цель −14 не достигается намеренно: этой записи нужно ~+16 dB
усиления, а потолок 11 dB выбран, чтобы не пережать. Все 169 фраз упираются в потолок, то есть на таком
материале leveler вырождается в постоянные +11 dB; на нормально записанной речи он работает как задумано.
Внутри слов усиление не меняется: 0 слов из 1822 с изменением между началом и концом.

До подстройки (потолок 24 dB, компрессор −7,5 dB, лимитер −0,1 dBFS) замеры были: выключено −25.69 LUFS /
−1.57 dBTP, 50% −19.04 / +0.03, 100% −14.19 при цели −14.0 / +0.16 dBTP; компрессор забирал до 17,3 dB.

## 21. Предпросмотр результата обработки до экспорта

Request: отрендерить обработанное аудио прямо в окне до экспорта и пересчитывать при смене настроек —
чтобы проверять громкость, не выгружая файл.

Built: `measureProcessed()` в `leveler.ts` считает программу ПОСЛЕ leveler'а и мастер-цепочки одним потоковым
проходом (LUFS, true peak, пик сэмплов, максимальное усиление фразы и максимальная компрессия) — без записи
файла. `Store.renderAudioPreview()` кеширует leveler по проекту и настройкам, `AudioPanel` показывает блок
«После обработки» сразу под исходными числами и пересчитывает его при смене цели, силы и включателя
(debounce 60 мс, чтобы успел отрисоваться статус «считаю…»). Плюс прослушивание 12 секунд от плейхеда:
`▶ 12 с: до` (исходник) и `▶ 12 с: после` (через `renderSegment`, тот же leveler и та же цепочка).

Measured: при 100% предпросмотр даёт −15.70 LUFS / TP −0.56 dBTP / пик −1.00 dBFS при +11.0 dB усиления и
4.7 dB компрессии — совпадает с реальным экспортом (−15.68 LUFS, −0.14 dBTP после AAC, пик −0.11). После
переключения на 50% пересчёт автоматически дал −20.29 LUFS, усиление +5.5 dB, компрессия 1.7 dB.
Ошибок в консоли при прослушивании нет.

## 22. Обработка звука как состояние проекта (волна, плеер, экспорт)

Request: обработанный звук должен отражаться на волне и на всём проекте, чтобы монтировать уже с чистовым
звуком; на вкладке «Аудио» сначала замер LUFS, затем варианты выравнивания по дельте к цели, подтверждение
и кнопка «Обработать звук»; «Вернуть исходный звук» возвращает исходник; в экспорт идёт то, что осталось на
таймлайне; в быстром режиме обработка применяется сама, с возможностью откатить.

Built: `Store.applyMaster(option)` собирает leveler (или статическое усиление), прогоняет ВЕСЬ PCM через него
и мастер-цепочку в новый 16-кГц PCM (`pcmMaster`), пересчитывает уровни (`levelsMaster`) и запоминает
`master` (вариант + измеренные LUFS/TP/усиление/компрессия). Таймлайн рисует `pcmView`/`levelsView` — то есть
обработанную волну; плеер через `Player.setMaster()` прогоняет каждый декодированный буфер через тот же
leveler и ту же цепочку (мониторинг чистового звука); экспорт строит цепочку из `S.master`, поэтому файл
всегда соответствует тому, что на таймлайне. `revertMaster()` всё это сбрасывает. Панель предлагает
варианты по дельте (усиление — если хватает запаса по TP, leveler — иначе, «не обрабатывать»), показывает
для каждого прогноз LUFS/TP, а «Быстрый режим» (`prefs.autoMaster`) применяет рекомендацию сразу после замера.

Measured (798 с): исходник −25.7 LUFS / −1.55 dBTP; вариант «усиление» недоступен (+11.7 dB дал бы +10 dBTP),
рекомендован leveler 100% → применено −15.7 LUFS / −0.56 dBTP, усиление фраз до +11 dB, компрессия 4.7 dB;
пик уровней на волне вырос с −8.2 до −3.7 dB (волна визуально изменилась). Экспорт с обработанным звуком дал
−15.68 LUFS, после «Вернуть исходный звук» — снова −25.69 LUFS; `pcmMaster`/`levelsMaster` очищаются.
Проигрывание с мониторингом идёт без ошибок в консоли. Быстрый режим без нажатия кнопки применил leveler
(−15.70 LUFS).

## 23. Обработанный звук в проигрывателе + индикация занятости

Request: воспроизведение всё ещё играет исходный звук; обработка подвешивает приложение — нужен спиннер и
приглушение интерфейса.

Built: `Player.setMaster()` получает leveler и настройки цепочки, и каждый декодированный буфер перед
планированием проходит через `processBuffer()` (leveler только для основного материала, затем компрессор и
лимитер); счётчик `masterBuffers` показывает, что буферы действительно обрабатываются. Обработка проекта
стала асинхронной и нарезанной на куски по 262k сэмплов с `setTimeout(0)` между ними, прогресс пишется в
`S.masterProgress` (не чаще раза в 120 мс — иначе редактор перерисовывался на каждый кусок и это стоило
секунды). `BusyOverlay` в `App` показывает затемнение с блюром, спиннер и процент; он же перехватывает клики.
Усиление теперь вычисляется раз в 64 сэмпла (кривая меняется только в паузах), это убрало 10^x на каждый
сэмпл. Попутно исправлено: замер не запускался, если PCM догружался уже после открытия вкладки — в
зависимостях эффекта теперь готовность PCM.

Measured: после «Обработать звук» у плеера `mLeveler` — функция, `mChainCfg` задан, за 3 секунды
воспроизведения через цепочку прошло **194 буфера** (до фикса — 0). Оверлей виден всё время обработки,
процент растёт (0.0 → 0.3 → 0.5 → 0.7 …), клики сквозь него не проходят (тест не смог нажать кнопку под
оверлеем). Обработка 13-минутного файла занимает 6.2 с (калибровка + рендер + замер); ошибок в консоли нет.

## 24. Обработанный звук на скорости ≠ 1 и фазы обработки в оверлее

Request: плеер по-прежнему играет необработанный звук; при первой обработке приложение unresponsive — нужно
сообщать о процессе.

Причина нашлась в пути «со скоростью ≠ 1»: `stretchedSegment` (WSOLA) планировал сжатые буферы напрямую, минуя
`processBuffer`, поэтому при 0.75–2× звук был исходным даже с применённой обработкой. Теперь этот путь тоже
прогоняет плоскости через leveler и цепочку (leveler — только для основного материала).

Проверка «что реально уходит в аудиовыход»: подменяли сеттер `AudioBufferSourceNode.buffer` и считали RMS
запланированных буферов. 1× до обработки — медиана −35.1 dB, максимум −18.8; после — −24.2 / −8.2 (+10.9 dB);
2× после — −22.9 / −8.4 dB. Прямой вызов `processBuffer` на синусе: −29 dB → −18 dB.

Оверлей: перед тяжёлой частью теперь гарантированный кадр (двойной requestAnimationFrame + 60 мс), поэтому
затемнение со спиннером точно нарисовано до подвисания; добавлены фазы — «Калибрую усиление…» → «Обрабатываю
волну… N%» → «Считаю результат…».

## 25. Вкладка «Аудио» до расшифровки

Request: пока идёт расшифровка, операции с аудио недоступны, но интерфейс настроек виден и выглядит сломанным.
Нужно вместо него писать «Настройка звука появится после расшифровки», а после расшифровки автоматически
делать замер LUFS и показывать интерфейс обработки.

Built: `AudioPanel` сначала проверяет наличие слов в проекте (`p.words.length`). Без слов показывается только
заголовок «Настройка звука появится после расшифровки» и подсказка; если идёт расшифровка — ещё спиннер, текст
текущей задачи и процент. Эффекты замера LUFS и предпросмотра теперь зависят от `hasWords`, поэтому замер
запускается сам ровно в момент, когда появляются слова, и сразу за ним строится предпросмотр с вариантами.

Measured: во время реальной расшифровки на вкладке видно «Настройка звука появится после расшифровки» и
«Идёт расшифровка — как только она закончится, я автоматически измерю громкость (LUFS)…» с прогрессом
(«Подготовка моделей…»); после завершения без единого клика появились 1822 слова, `audio = −25.7 LUFS`,
блок «LUFS сейчас» и «Как выровнять» с рекомендацией leveler (−15.7 LUFS / −0.6 dBTP).

## 26. Понятное состояние «Аудио» до готовности

Request: во время загрузки моделей вкладка показывала «Громкость ещё не измерена» и неактивную кнопку — выглядело
сломанным. Нужно показать «Настройка звука появится после расшифровки» и объяснить, что именно происходит.

Built: общий блок `Pending` в `AudioPanel` с причиной из текущей задачи: «Идёт скачивание моделей», «Идёт
расшифровка», «Идёт извлечение звука», «Читаю файл», «Ищу звуки-паразиты», иначе «Запись ещё не расшифрована»;
плюс спиннер с текстом задачи и процентом и пояснение, что замер запустится сам. Кнопка «Измерить громкость»
теперь появляется только когда действительно ничего не выполняется (и она активна); пока идёт замер — «Измеряю
громкость… N%» без кнопки.

Measured: со словами в проекте и задачей `models` вкладка показывает «Настройка звука появится после расшифровки /
Идёт скачивание моделей / Загрузка моделей: 1328 из 1611 МБ / 82%», кнопок нет; при `transcribe` — «Идёт
расшифровка». В покое (слов меньше нет, ничего не выполняется) — «Громкость ещё не измерена.» и кнопка
«Измерить громкость» в состоянии enabled.

## 27. Вкладка «Аудио»: четыре варианта и честный замер после обработки

Request: навести порядок на готовой вкладке — наверху замер LUFS; раздел «Как выровнять» с четырьмя вариантами
(«Сильно громче» +15 дБ, «Просто громче» +11 дБ, «Немного громче» +8 дБ, «Не обрабатывать»), предложенный
выбирается по дельте LUFS; «Цель» переезжает в глобальные настройки (⚙); «Сила leveler» и «Быстрый режим»
убираются; предпросмотр звука убирается; после обработки LUFS пересчитывается по ИЗМЕНЁННОМУ аудио.

Built: `LevelerOptions`/`MasterOption` больше не знают про «силу» — вариант задаёт потолок усиления фразы
(`maxGainDb` 15 / 11 / 8), калибровка по-прежнему подтягивает итог к цели. `prefs.leveler` и `prefs.autoMaster`
удалены, вся ветка предпросмотра (`preview`, `levelerForPreview`, `renderAudioPreview`, `audition*`) удалена.
Цель переехала в настройки, новая вкладка «Звук» (`openSettings('audio')`). `applyMaster` теперь СНАЧАЛА
измеряет обработанный PCM, потом публикует состояние, поэтому под метр никогда не попадает старое значение;
`S.audio` описывает то, что на таймлайне, `S.audioBase` — исходник (для рекомендации), «Вернуть исходный звук»
возвращает исходный замер. Вариант и результат разделены: `master.opt` (выбор) и `master.lufs/tp/maxGainDb`
(что получилось) — раньше `maxGainDb` перезаписывался измеренным значением и экспорт мог взять не тот потолок.

Measured (798 с, цель −14): рекомендация по дельте 11.7 LU — «Просто громче»; выбран «Сильно громче» (+15) →
метр −25.7 → **−14.15 LUFS**, true peak −0.43 dBTP, «было −25.7», вердикт «В норме для YouTube»; экспорт с этим
же вариантом дал **−14.12 LUFS** (совпадает с таймлайном); после «Вернуть исходный звук» снова −25.7.

Замечание: экспортированный файл показал true peak **0.0 dBTP** при лимитере −1 dBFS — перегруз при AAC-кодировании
(сигнал плотнее, чем при +11 дБ). Стоит опустить потолок лимитера до −1.5…−2 dBFS или сделать настоящий
true-peak лимитер.

## 28. Потолок лимитера −3 dBFS

Request: разрешено опустить потолок до −3 dBFS, чтобы файл не упирался в 0 dBTP из-за перегруза AAC.

Built: `DEFAULT_CEILING_DB` = −3 (было −1). Цепочка одна для таймлайна и экспорта, поэтому калибровка leveler
сама подстроилась (компрессия выросла с 4.7 до 6.5 дБ, усиление фраз осталось +15).

Measured (798 с, вариант «Сильно громче», экспорт): проект −14.22 LUFS / −1.51 dBTP; файл −14.20 LUFS,
TP по моно-основе **−1.12 dBTP** (было 0.0 dBTP при потолке −1), сэмпловый пик стерео **−0.42 dBFS**, p99.9 −2.93,
p99 −3.02 — то есть основная масса сигнала теперь на −3 dBFS, а выше −1 dBFS остались **11 сэмплов из 35 млн**
в пяти точках (звон AAC на транзиентах — у лимитера нет look-ahead, а рампы усиления дают резкие скачки).
Громкость осталась в цели (−14.2 при цели −14).

Вывод: запас реально вырос (~1.1 дБ по замеру и ~2.5 дБ по основной массе), цена — 0.07 LU громкости.
Для строгой гарантии −1 dBTP на стерео нужен либо потолок −4 dBFS, либо true-peak лимитер с look-ahead.

## 29. Обработка звука — шаг конвейера перед расшифровкой

Request: спрятать задержку обработки внутрь начального этапа. После извлечения звука измерить LUFS, посчитать
дельту к цели, САМОМУ обработать звук подходящим пресетом (не спрашивая), сохранить оригинал для отката и
только потом начинать расшифровку. В полном авторежиме — тот же порядок, а после расшифровки идут остальные шаги.

Built: `Store.autoMaster()` — замер → выбор пресета по дельте → `applyMaster`. Вызывается из `prepareAudio()`
сразу после извлечения PCM и до `transcribe()`, поэтому работает и для обычного открытия, и для быстрого пути
(он идёт через тот же `prepareAudio`). До расшифровки слов ещё нет, поэтому фразы для leveler строятся по тишине:
`speechWords()` пересобирает тишины с гранулярностью 0.35 с (как `PHRASE_GAP` в leveler) и отдаёт
непрерывные речевые участки. Пресет выбирается как минимальный, который может покрыть дельту
(`≤8 → +8`, `≤11 → +11`, иначе `+15`) — иначе все фразы упираются в потолок и результат не доходит до цели.
Кривая усиления теперь сохраняется в `S.master.curve`, а экспорт воспроизводит именно её (`levelerFromPoints`),
поэтому файл совпадает с таймлайном даже когда кривая посчитана до появления слов.

Measured (798 с, цель −14): извлечение 0.2→5.7 с, замер 5.7 с, обработка 5.9→11.0 с, расшифровка начинается
в 11.0 с и идёт до 151 с. Автоматически выбран +15 (дельта 11.7), результат **−14.18 LUFS** (было −25.70),
true peak −1.12 dBTP, кривая 210 точек (105 фраз). Экспорт: **−14.14 LUFS** — совпадает с таймлайном.
Итого +5.1 с перед расшифровкой вместо интерактивной паузы.

## 30. Живая обработка звука (форк audio-dsp)

Request: обработка тормозит, потому что «печатается» весь звук целиком (1.5 ч), и волна рисуется из него.
Нужно как в Final Cut: волна перерисовывается сразу при изменении настроек компрессора (< 300 мс), волна
считается по требованию только для видимой части, грубо по текущему масштабу; полный расчёт — только при
экспорте. Сделать шаги 1–4, тестировать на `2026-10-25 16-47-05.mp4` (5825 с, есть громкие и тихие места).

1. **Замер старого пути** (1.5 ч): извлечение 36.9 с; обработка 122.4 с при открытии и 217.6 с на расшифрованном
   проекте (11063 слова). Из них **калибровка 110–207 с** (3 полных прогона `simulateLoudness`), сам рендер только
   4.2 с, замер 1.8 + 3.5 с. То есть тормозил не рендер, а калибровка через полный прогон цепочки.
2. **Волна по требованию**: блочная модель (10 мс; пики компрессора по под-блокам 1.25 мс) рисует обработанную
   волну всего файла за ~100 мс; воркер досчитывает точные 60-секундные тайлы видимого участка (весь файл ≈ 3.2 с,
   5 мин ≈ 0.19 с, 20 с ≈ 0.04 с); ниже 12 мс/px точные сэмплы видимого участка считаются сразу. `pcmMaster` удалён.
3. **Воркер**: анализ (LUFS + K-энергия + пики) один проход ≈ 2 с; точный LUFS всей обработанной программы
   через 400 мс после последнего изменения, ≈ 3 с; до этого в панели «≈ модель · уточняю…». Фразы кэшируются.
4. **Ползунки компрессора** (порог, степень, атака, восстановление) + автоматическая компенсация после
   компрессора (≤ 12 дБ), чтобы цель достигалась при любых настройках. Ползунок → перерисованная волна:
   **115 мс медиана, 120 мс максимум** на любом масштабе (весь файл / 5 мин / 20 с / 2 с). Во время проигрывания
   изменение слышно через ~0.1 с (перекрёстное затухание 20 мс, без остановки). Настройки сохраняются в проекте.

Точность модели против точной цепочки (весь файл, 4 настройки от мягкой до −20 дБ 10:1 2 мс): средняя ошибка
блока 0.16–0.52 дБ, p95 0.6–1.7 дБ; громкость модели −13.7…−15.3 при точной −14.0…−15.0 (сходится по bias).

Лимитер: был жёсткий клиппер −3 dBFS → MP3 давал 626 сэмплов выше −1 dBFS и пик 0 dBFS. Теперь look-ahead
1.5 мс (задержка компенсирована в экспорте, плеере, тайлах): MP3 1 ч 2 мин **−14.53 LUFS при −14.56 на шкале,
true peak −1.95 dBTP, 0 сэмплов выше −1 dBFS**. Экспорт MP3 835 с (единственный полный расчёт).

Итог «Сильно громче» на этом файле: −29.7 → **−14.06 LUFS** (точный замер), раньше −16.38 (упиралось в потолок).
Цена: компенсация 9.5 дБ уходит в лимитер. Тест: `tests/audio-dsp.mjs`, `tests/masterchain.test.ts`.

## 31. Выравнивание по фразам — отдельная настройка, выключено

Request: временно отключить регулирование громкости по фразам (не делать ничего, никак не влиять на громкость),
вынести как отдельную функцию в настройках, по умолчанию выключено; работать только с компрессором.

Built: `prefs.phraseLeveler` (false), галочка в ⚙ → «Звук». Выключено: кривая пустая (усиление 1.0), только
компрессор + компенсация (до +24 дБ); на вкладке «Аудио» — «Обработать» / «Не обрабатывать». Переключение
пересчитывает обработку сразу. Measured (1.5 ч): выкл — кривая 0 точек, компенсация 24 дБ, −14.11 LUFS; вкл —
2708 точек, +15.9 дБ фразы + 9.7 дБ компенсации, −14.02; снова выкл — как в первый раз. Ползунок → волна 99 мс.
Note: при пороге −5 дБ компрессор на этом тихом файле почти не работает (сжатие 0.2 дБ) — порог стоит ДО
компенсации, его надо опускать к −20…−30 дБ.

## 32. Настройка звука доступна во время расшифровки

Request: раз быстродействие больше не проблема, не блокировать настройку звука на время расшифровки —
показывать её сразу после извлечения звука, замера и обработки.

Built: вкладка «Аудио» ждёт только PCM (раньше — слов). Пока идёт расшифровка, фразы для выравнивания берутся по
паузам (`S.phraseSource()`: слова используются только когда расшифровка завершена — частичные слова покрывают
лишь начало файла). Measured (1.5 ч, свежее открытие): обработка готова через 1.3 с после извлечения, расшифровка
идёт, слов 0 — панель показывает ≈−14.0 LUFS, 4 ползунка, «Обработать/Не обрабатывать»; ползунок порога работает
(пересчёт модели 89–131 мс, кадры 17 мс — расшифровка на WebGPU не мешает).

## 33. Ползунок «Компенсация» (make-up компрессора)

Request: добавить параметр makeup — то, что в интерфейсе называлось «компенсация до цели».

Built: ползунок «Компенсация» 0…+24 дБ + галочка «авто — до цели». Авто (по умолчанию) — как раньше, make-up
подбирается моделью до цели. Движение ползунка фиксирует make-up (`master.makeupAuto = false`, `setMakeup`,
кадр-коалесцирование); тогда нет подстройки к цели, а измеритель показывает получившуюся громкость. При включённом
выравнивании по фразам фразы целятся в (цель − make-up). Сохраняется в проекте; «Сбросить компрессор» возвращает авто.
Measured (1.5 ч): ползунок → волна 101 мс медиана, 110 макс; +6 дБ → модель −23.79 / точно −23.80 LUFS;
+9 дБ → −21.14 / −21.15; после перезагрузки +9 дБ и ручной режим сохранились; обратно в авто → +23.3 дБ, −14.25.

## 34. Убран раздел «Как выровнять»

Request: убрать с вкладки «Аудио» раздел «Как выровнять» с двумя вариантами — больше не нужен.

Built: без выравнивания по фразам раздела нет: измеритель + компрессор. Если обработка не применена (старый проект,
откат) — одна кнопка «Включить обработку». С включённым выравниванием (⚙ «Звук») четыре варианта остаются —
там они задают потолок усиления фраз. Measured: обработка вкл. — раздела нет, 5 ползунков, −14.1 LUFS; после отката —
кнопка, −29.7; кнопка → ≈−14.0 и ползунки; выравнивание вкл. — снова 4 варианта.

## 35. «Приглушение тишины» (вдохи)

Request: раздел перед компрессором — плавно приглушать участки под порогом тишины, которые не вырезаны (вдохи).
Атака 1–200 мс, степень 0…−20 дБ, восстановление 1–200 мс; атака начинается В НАЧАЛЕ участка, восстановление
заканчивается ДО его конца (lookahead на длину восстановления).

Built: `duckPoints` (dsp.ts) строит огибающую по границам тихих участков (`detectSilences` по порогу вкладки
«Тишина», ≥ 20 мс, кэш по порогу): 0 дБ в начале → глубина через атаку … глубина → 0 дБ ровно в конце. Границы
известны заранее, так что lookahead бесплатный. Короткий участок (< атака + восстановление): рампы сохраняют скорость
и встречаются — глубина частичная. Огибающая складывается с кривой выравнивания (`addCurves`) → `master.full`, её
используют модель, точные тайлы, плеер, экспорт. В проекте хранятся только настройки (`master.duck`); точки
(~40 тыс.) пересобираются. Шаг усиления в плеере/точном расчёте 64 → 16 сэмплов (рампа может быть 1 мс).
Порог тишины меняется → участки пересчитываются. По умолчанию степень 0 дБ (выключено).
Measured (1.5 ч, −12 дБ, 40/60 мс): 9903 участка; ползунок → волна 120 мс медиана; огибающая: начало 0, +20 мс −6,
+40 мс −12, середина −12, конец−30 мс −6, конец 0; участок 80 мс → −9.6 дБ (ожидалось −9.6); точный рендер по всему
файлу: блоки вне участков 0.00 дБ (p5…p95 = 0), внутри −12 дБ медиана; после перезагрузки настройки и 9903 участка на месте.

## 36. Серая «тишина» на волне — по сырому звуку

Request: при поднятии компенсации вдохи на волне пробивали порог и становились яркими, хотя на слух приглушение
работало. Окраска тишины должна считаться по сырому звуку.

Built: в обзорном виде высота столбика — обработанный звук, а серый/яркий цвет — по `S.levels` (оригинал) против
порога. Measured (пиксели холста, 60 с окно, порог −43, приглушение −10 дБ): компенсация 0 → 441 громких столбцов, 0
серых; компенсация +24 → 49 столбцов, где обработанный звук выше порога, а сырой ниже — все 49 серые; громкие — 0 серых.

## 37. Цель — нижняя граница, новые значения по умолчанию

Request: звук слишком «горячий» — по умолчанию целиться в нижнюю границу рекомендованного окна (−14 → −14.9);
компрессор −4 дБ, 4:1, 8 мс, 120 мс; «авто» компенсации — тоже до −14.9; приглушение тишины 30 мс / −5 дБ / 30 мс.

Built: `aimLufs()` = `prefs.targetLufs − 0.9` (store) для автокомпенсации, вариантов и autoMaster; допуск повторного
прицеливания 0.25 → 0.1 LU (иначе точный замер уходил на −15.10, за окно). `DEFAULT_COMPRESSOR` и `DEFAULT_DUCK`
обновлены; приглушение по умолчанию включено (−5 дБ). Measured (1.5 ч): точный −14.95 LUFS, компенсация +20.5 дБ
(было +24 при −14.11); «авто» после ручных +3 дБ → −14.94.

## 38. Реставрация (Sidon)

Request: найти библиотеку «студийного голоса» (Premiere/CapCut) и новее; проверить синхрон (у Adobe клипы уезжали);
добавить на вкладку «Аудио» раздел «Реставрация»: ползунок dry/wet 0…100 шагом 20; считать в фоне и по требованию,
целиком — только при экспорте; модель грузить только при > 0; внешний источник + запасной; не блокировать работу;
если идёт другая операция — сказать, что модель скачается и запустится после неё. Реставрация — до компрессора
(до или после приглушения тишины): не восстанавливать то, что уже сжато.

Built: Sidon v0.1 (sarulab-speech, MIT) в ONNX (`soniqo/Sidon-ONNX`, закреплённый коммит): fp16-предиктор
w2v-BERT 2.0 + fp32-вокодер DAC на WebGPU (WASM — запасной вариант). Фронтенд (Kaldi fbank, 80 мел, stride 2)
портирован в `src/restore/frontend.ts`. Воркер `src/restore/restore.worker.ts` качает модель с Hugging Face, при
ошибке — с зеркала `./models/` (`deploy/sync-models.mjs`), хранит в Cache Storage. `src/restore/engine.ts`
(`S.restorer`): тайлы по 10 с (+1 с контекста, стык 0.2 с косинусом), на минуту вперёд от курсора по оставленным
кускам; экспорт рендерит все тайлы по порядку. Смешивание — в плеере и экспорте до кривой усиления (выравнивание
+ приглушение тишины) и компрессора. `project.restore` (0…100).
Findings: fp16-вокодер на WebGPU выдаёт тишину (−75 dBFS: weight-norm переполняется в fp16) — fp32-вокодер
совпадает с WASM (корреляция 0.9999999). Восстановленный звук некогерентен по фазе с исходным выше 200 Гц
(когерентность 0.01), поэтому линейная смесь 60/40 была на 2.6 дБ тише — смесь сделана постоянной мощности.
Выход Sidon запаздывает на 7 мс (огибающая, во всех 20-секундных окнах, без дрейфа) — компенсировано.
Measured (3-мин клип, M1 Ultra): загрузка с HF 597 МБ за 27.5 с, с зеркала (HF заблокирован) — 2.4 с, запуск
WebGPU ~1 с; тайл 10 с ≈ 0.6–0.7 с (≈ 14× реального времени; 1.5 ч экспорта ≈ +6 мин); первая минута вперёд
готова за 4.7 с, всего 10 из 19 тайлов (по требованию). При 0 % — ноль запросов к модели; при включении во время
операции — 0 запросов, тост и статус, старт через 2 мс после её окончания. Громкость MP3 без обработки: 0 % −33.64,
40 % −33.95, 100 % −33.67 LUFS (подгонка громкости тайлов). С компрессором: 0 % −15.03, 60 % −14.42, 100 % −13.85.
Синхрон: огибающая 100 % против 0 % — 0 мс (±1 мс) во всех окнах; MP4 против MP3 — 0 мс; длина совпадает до сэмпла.

## 39. «Усиление звука» — Агрессивно / Средне / Мягко

Request: в ⚙ «Звук» селектор «Усиление звука»: Агрессивно — автокомпенсация ровно в цель, компрессор −10 дБ 5:1;
Средне — цель − 0.9, −5 дБ 5:1; Мягко — цель − 1.3, −4 дБ 4:1. Хранится в приложении, действует на следующий проект с
автообработкой; внутри проекта меняет только автоматическую обработку, не ручные настройки.

Built: `prefs.gainMode` + `GAIN_MODES`; режим сохраняется в проекте (`master.mode`), ручная правка компрессора —
`master.compManual`. Смена режима в открытом проекте: автокомпенсация перецеливается, нетронутый компрессор
меняется на пресет; ручные компрессор/компенсация остаются. Открытие проекта режим не меняет (в настройках —
подсказка и кнопка «Применить … здесь»). Потолок автокомпенсации без выравнивания по фразам 24 → 30 дБ: на тихой
записи (−33.6 LUFS) «Агрессивно» упиралось в 24 дБ и давало −14.76.
Measured (3-мин клип 20:00–23:00, точный замер): Агрессивно −14.04 (цель −14.0, компенсация +27.4), Средне −14.93
(−14.9), Мягко −15.32 (−15.3). В проекте: Мягко → Агрессивно −14.02; ручной компрессор −7 дБ → Средне: компрессор
остался −7, −14.81; ручная компенсация +3 → Мягко: осталась +3; «Сбросить компрессор» → пресет Мягко, −15.32.
Режим проекта пережил перезагрузку; приложение в режиме «Агрессивно» открыло проект «Мягко» без изменений.

## 40. Вкладка «Интерфейс» и «Подсказки к приложению»

Request: в настройках раздел «Интерфейс» первым, туда перенести «Сигнал, когда вся работа закончена», «Скраб:
короткий звук при выборе слова» и «Выделение следует за воспроизведением». Там же переключатель «Подсказки к
приложению»: разрешать или запрещать серые поясняющие тексты по всему интерфейсу — цель чище интерфейс для опытных.
Подсказки по умолчанию скрыты и включаются только явным действием пользователя.

Built: вкладка «Интерфейс» (`prefs.hints`, по умолчанию **false**) первой в ⚙, её же открывает шестерёнка
(`S.openSettings('ui')`). Поясняющие тексты помечены классом `tip` и скрыты правилом `html:not(.tips-on) .tip`;
`savePrefs` переключает класс `tips-on` на `<html>`, так что настройка переживает перезагрузку. Помечены 34 текста
(все панели, главная, карточка быстрого пути, строка подсказок в редакторе). Тексты-данные под `tip` не попали и
видны всегда: размер и разрешение экспорта, причина предложения ИИ, ход и итог быстрого пути, статус видеокарты и
прогресс загрузки моделей, имя папки экспорта, «Вставится в 12:34», «используется 3 с», источник в «Текстах».
Checked в Chrome (свежий профиль, сборка): по умолчанию 4/4 текста на главной скрыты, вкладка открывается первой;
после «Вкл» — 8 текстов в настройках и 4 на главной, после перезагрузки остаются, вкладка «Звук» показывает 3; после
«Выкл» — 0.

## 41. ⚠️ «Расшифровка идёт на процессоре» и диагностика видеокарты

Request: на новом Mac (M4 Pro) при первом запуске расшифровка пошла на процессоре, и это было незаметно. Нужно:
(1) ⚠️ рядом с полосой прогресса, если считается на процессоре; (2) по наведению — подсказка, что это медленно, и
кнопка «Изменить на WebGPU»; (3) если WebGPU недоступен, кнопка есть, но выключена; (4) в ⚙ «Распознавание речи» —
сворачиваемое поле с диагностикой железа, чтобы видеть, как браузер видит видеокарту.

Built: воркер возвращает `{ device, dtype, pref, why }` (`why` — «выбрано в настройках» / «браузер не дал адаптер
WebGPU (requestAdapter → null)» / «не удалось запустить модель на WebGPU: …»), `run.ts` хранит это как `lastAsr`,
`S.task.asr` несёт это во время расшифровки, `TaskBar` показывает ⚠️ (`[data-cpu-warning]`) с карточкой
`.cpuwarn-pop`. «Изменить на WebGPU» (`S.switchToWebGPU`) пишет `prefs.device='webgpu'` и, если расшифровка идёт,
прерывает её (`restartAsr` → перезапуск с чекпоинта; мёртвый RPC теперь сразу отклоняет вызовы, а `ctcAlign`
пробрасывает AbortError, чтобы прерывание не выглядело как сбой выравнивания). Кнопка не скрывается, а выключается,
когда `webgpuAvailable()` не получил адаптер. `gpuInfo()` перезапрашивает адаптер ещё раз через 700 мс — на свежем
профиле GPU-процесс может ещё стартовать; вероятная причина исходного бага. Диагностика (`gpuDiagnostics`) печатает
UA, платформу/арх, ядра, память, WebGL-рендерер и — отдельно для страницы и для настоящего воркера — adapter info,
features, limits и результат requestDevice.
Checked (Chrome, реальный прогон на «short file passes.mp4», Whisper Base): диагностика видит WebGPU и на странице,
и в воркере (Apple M1 Ultra, metal-3, shader-f16); расшифровка на процессоре даёт ⚠️ и карточку с рабочей кнопкой
(проверено hit-test: кнопка не перекрыта); переключение на WebGPU перезапускает расшифровку с чекпоинта, ⚠️ исчезает,
тост «Переключаю…», без тоста «остановлена» и без «Ошибка расшифровки». С заглушённым `navigator.gpu` кнопка на месте,
но выключена, и карточка объясняет, что WebGPU недоступен, показывая причину из воркера.

## 2026-11-02 — XML timeline export

Request: export the already-cut timeline for Premiere Pro / DaVinci Resolve, no removed material or
empty gaps, including inserted titles; audio processing need not transfer.

Built: «Экспортировать XML» on the Export panel, FCP 7 `xmeml` v5 from the composite timeline.
Whole retained source frames only; integer packed output boundaries; source-rate title trims and
NTSC rates; linked original audio channels. Original filenames come from stored File/handle metadata,
including old title entries, for manual NLE relinking. Always-visible notices explain offline media,
unprocessed/unmuted audio and inward frame snapping. No rendering, model loading, or deployment.

Verification: 52 XML unit/structural cases (Python stdlib parser), core unit suites, typecheck, build;
Chrome button/download test with a cut and trimmed title, reload/persisted names, busy/all-cut disabling,
and missing-filename error. Independent OpenTimelineIO import: 25/30 fps mixed-rate example, exactly
5 seconds on video + two audio tracks. Actual Premiere/Resolve import is not verified on this VPS.
See `XML-EXPORT.md` for import/relink instructions, frame precision and CFR-only scope.

Tooling correction: local environment now leaves NODE_ENV unset so Vite chooses production for builds,
rather than accidentally shipping React development code after sourcing the local environment.

## Sequential batch queue (2026-11-02/03)

User requested one common stage selection for multiple videos, strictly one file at a time in an
open tab, durable per-project results, repeated GPU attempts, a four-column project table, and
single/all result-folder downloads. Defaults: preparation near the lower loudness recommendation,
transcription, filler removal, conservative AI carving, spelling/structured/chapters. Video export
must remain an explicit manual operation, and only successful export may mark it done.

Implemented an awaited queue with settings snapshots and per-stage/individual text-step persistence;
failed-file continuation, stop/resume and failed-stage retry without repeating completed stages.
Preserved raw transcription separately from editable/filler-enriched words. The existing single-file
FastTrack hook is suppressed only for queue runs. Result downloads rebuild archived composites with
titles and copy an existing accessible manually exported MP4; they never render video implicitly.
GPU probing now tries adapter/device three times with 4 s per-operation bounds and 700 ms retry gaps;
missing GPU and CPU fallback are visible. See `BATCH.md` for controls, storage and open-tab limits.

Follow-up: each row's verbose report is now a liveness aid rather than an archive — only the newest
300 lines are retained (in memory, IndexedDB and downloads), and the body is collapsible. It starts
expanded only for the file currently processed by the queue or opened for editing; when the queue
is idle every report is collapsed, while its header still shows whether processing is active and
how long ago the last real event arrived.

Bug fix (user report): disabling the whole «Тексты» group did not stop text steps that had been
checked before the group was switched off, because execution used a per-file snapshot taken when
the file was added. Shared settings are now persisted in the browser and applied to every unfinished
queued project (off → `skipped`, on → `pending`, completed stages untouched); the executor also
re-checks the group switch at each stage, and startup repairs stale stage flags. A running file is
not reconfigured mid-run. Regression in `tests/batch.mjs`: add two files with texts on, switch the
group off in the UI, start — exactly two carving requests, no text-step requests, `texts: skipped`,
empty pipelines.

Verification: typecheck, all core/XML/GPU/queue-state unit tests; real Chrome queue test with six
synthetic 2-second inputs, actual extraction, mocked ASR/filler/HTTP LLM, 24 LLM requests. Checks
four-column layout, three default text outputs, durable reload, one active file, folder downloads,
failed-file continuation/retry and stop/resume. Separate real software-WebCodecs manual MP4 test:
331,193 bytes; ffprobe H.264 320×240, 55 frames / 2.20 s, AAC 2.24 s (codec padding). Verified cancelled
picker does not mark completion, successful export does, archived title XML and processed timecodes/
duration match, and result download copies the already-rendered MP4. Four-column/no-desktop-overflow
DOM assertions passed; screenshot captured but not visually inspected (image input unavailable).
This does not validate real all-night throughput or hardware GPU performance: the VPS has no hardware GPU. Batch changes are local; no deployment was
requested. The deployed build is whatever the operator last released.

## Explicit save hotkey (2026-11-03)

⌘S / Ctrl+S in the video editor force-saves the open project (physical `KeyS`, so a Russian layout
does not break it; the full-screen text editor keeps its own capture handler). Local projects save to
IndexedDB and show «Сохранено на <platform>»; workspace projects save locally, push once with the
explicit-save conflict retry, and show «Сохранено в <workspace name>» (the exact server name, no
quotes). A web page cannot read the OS hostname, so the local label is the platform Chrome exposes
(macOS / Windows / Linux / ChromeOS / …), documented in `src/lib/device.ts`. Regression:
`tests/workspace-scope.mjs` presses Meta+S locally and Ctrl+S in a mocked workspace, asserting the
exact toasts and the server PUT; `tests/device.test.ts` covers the platform mapping.

Shipped 2026-11-03 in commit `4e712f3`; public hashes matched and the mocked-workspace save test
passed against the deployed origin.

## Workspace session recovery (2026-11-03)

The workspace service keeps sessions in memory. A restart at 18:08 invalidated every open tab's
cookie; saves received 401 and each failed autosave toasted `Не удалось сохранить проект:
{"error":"unauthorized"}`, flooding the screen. Local IndexedDB saves had already succeeded, so
nothing was lost. Client fix: on 401, exchange the magic-link token still present in the URL for a
new session and retry the request once (covers sync, locks, heartbeat, saves); background save
errors are throttled to one toast per 10 seconds. Regression in `tests/workspace-scope.mjs`
simulates a 401 and checks re-entry plus a successful PUT. Shipped in `b664335`.

## Audio-only import (2026-11-05)

Request: «Add support to import plain audio, no video. Should work the same, only black preview in
top right. And if imported audio, only export .mp3, not MP4».

Built: the source pickers and drag/drop accept MP3, M4A/M4B, AAC (ADTS), WAV, FLAC, OGG/Opus and WebM audio.
`MediaMeta.hasVideo` is stored (`mediaHasVideo()` also derives it for old projects), so an audio-only project
reopens and relinks correctly. The player paints a black 16:9 frame for the whole timeline. Editing,
transcription, filler scan, loudness processing, Реставрация and subtitles/texts are unchanged (they only use
the audio track). Export panel for such projects has no MP4 and no XML section; `runExportMp4`/`renderMp4`
refuse defensively, «Сохранить всё» ignores the remembered video checkbox, and the batch `video` stage is
skipped. «Заставки» tab is hidden (a video feature). MP3 export uses the same sample-accurate renderer; since
LAME accepts only 8–48 kHz, higher-rate sources are resampled on the fly (`mp3OutputRate` +
`LinearResampler`) instead of failing.

Measured (real Chrome, built app, 3.1-s speech fixture): MP3, M4A/AAC, ADTS AAC, WAV (48/96/192 kHz), FLAC,
OGG/Opus and 8/11 kHz mono WAV all open (`hasVideo:false`, 16 kHz PCM extracted); preview advances 1.06 s per
1.2 s wall time, black pixel `[0,0,0,255]`, seek works; MP3 export of 96k/192k WAV → 48 kHz matches the 48 kHz
export at lag 0, correlation 0.99994 / 0.99991 (SNR 39/37 dB); «Сохранить всё» in an audio project writes
MP3 + SRT/JSON/texts/project and no MP4 even with the video checkbox remembered as on. Video projects still
show MP4/AAC/XML and export MP3 (the MP4 path is unchanged; on this Linux test machine hardware H.264 decode is
unavailable, so the MP4 export itself could not be re-verified here).

## Workspace 504 and stuck write queue (2026-11-07)

A save returned 504 and afterwards every request for that workspace timed out until the service was
restarted. The service was healthy but the per-workspace write chain was stuck: a PUT client vanished
mid-body, and `readBody` only listened for `end`, so its promise never settled. nginx showed upstream
timeouts; `ss` showed unread bodies queued on nginx→Node sockets. Restart recovered the workspace
(sessions persisted). Fix `8f905e0`: reject body reads on abort/close/error, body timeout and job
watchdog, serve read-only GETs outside the write queue, and bound request/header keep-alive timeouts.
Regression `tests/workspace-abort.mjs`. Changed the server only; the static app was unchanged.

## Per-step LLM models and 20k structured chunks (2026-11-07)

Measured `deepseek-chat` against the saved structured texts from «Нейрокурс ч3»: Chat took 17–19 s per
13–17k text (two 12k chunks, parallel 2) and preserved more content, but kept more spoken-language
fillers, produced more fragmented headings, underused lists, and sometimes folded ASR-garbled text into
the author’s voice. A current `deepseek-reasoner` control took 21.4 s on one sample and was closer to
the saved quality. Implemented: default fragment size 20 000 (one request for these texts; existing
DeepSeek 12k settings migrate once), optional per-step model overrides in Settings → LLM (map and merge),
and a stricter structured prompt (8–12 meaningful sections, lists, filler removal, explicit
`[неразборчиво]` handling). Regression `tests/step-models.mjs`. Shipped as `f07fd33`; public assets/model and a browser smoke test verified.

## Dynamic tab title (2026-11-12)

Chrome tab title precedence is now file name → workspace name → `Резак`; busy/fast-track prefixes keep
the file or workspace name. Test: `tests/tab-title.mjs`. Shipped as `87b6ce4`; a browser test passed.

## Global sound-processing bypass (2026-11-11)

Added a remembered bottom toggle in Звук to bypass all processing: restoration, phrase leveling,
silence ducking, compressor/limiter and make-up. The original sound is used by the preview, timeline,
LUFS display and exports; project settings are retained. Future projects skip automatic mastering
while bypassed, and the toggle re-enables it. Test: `tests/audio-bypass.mjs`. Shipped as `f5c730a`; a browser test passed.

## Post-processing VU meter (2026-11-09)

Added a vertical VU meter to the right of the video preview. It taps an AnalyserNode placed after the
restoration, leveler and compressor/limiter (and master volume), so it shows the played signal rather
than the raw PCM. Green/yellow/red, fast attack and slow release, peak hold. Tests: `tests/vu.test.ts`
and `tests/vu-meter.mjs` (synthetic 440 Hz sine; layout and level assertions in Chrome). Shipped as `d4e2077`; a browser run read −9 dB RMS / −6 dB peak with the meter lit.

## Waveform past the end of the recording (2026-11-09)

At the end of the timeline the waveform window could be scrolled past the recording, leaving a
200–300 px blank strip that looked like a time-shifted waveform; zooming fixed it until playback
followed again. Cause: playback follow set `v0 = src − 25% span` without clamping to
`duration − span` (mini-map clicks had the same gap). Added `followViewStart()` and applied the same
bound to drag-scroll. Tests: `tests/timeline-view.test.ts`, `tests/timeline-end.mjs` (real Chrome,
near-end playback). Shipped as `c9efcf7`;
a browser test passed with `v0 = duration − span`.

## Open items / ideas

- Confirm fast-track strictness and the production LLM provider.
- Loudness: EQ / other manual controls still deferred; the compressor, make-up and silence ducking are manual
  now (merged from the audio-dsp fork).
- Audio processing discussed (2026-10-26) but not built: mouth declicker, de-esser, noise gate. Conclusion then:
  extend the in-house TS DSP rather than ship ffmpeg.wasm (≈30 MB, single-threaded without COOP/COEP, GPL build,
  batch-only); use the transcript (word timings for the gate, sibilant letters for the de-esser, pauses vs. word
  onsets for the declicker). Measured JS throughput (V8, 48 kHz stereo): compressor+limiter ×390 real time,
  split-band de-esser + gate ×1100, STFT 1024/256 ×73.
- Automatic make-up reaches +27 dB on very quiet files («Агрессивно», −33.6 LUFS clip); no decision on a lower cap.
- Resuming an interrupted fast track after transcription.
- Реставрация: the meter/model is computed on the dry PCM; with the compressor on, 100 % exports ~1 dB louder
  than the meter says (still inside −14 ±1). Sidon may soften short non-speech sounds.
