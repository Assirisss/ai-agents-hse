# Backend · общая служба поиска трендов

Node.js + TypeScript + Fastify. Независимая служба для сайта, будущего Telegram-адаптера и предметных агентов. Обязательных платных API нет.

## Запуск

Node.js 24 LTS рекомендуется, версия указана в `.nvmrc`. В отдельном терминале из корня репозитория:

```sh
cd backend
npm ci
npm run dev
```

API: `http://127.0.0.1:8787`. Затем запустите frontend по его инструкции: Vite направляет `/api` в backend. Если меняете порт API, обновите proxy в `frontend/vite.config.ts`.

```sh
npm test       # Проверки без интернета и реальной модели
npm run build # Проверка типов и компиляция
npm start     # Запуск собранного API после build
```

## API

| Метод | Путь | Результат |
| --- | --- | --- |
| GET | `/api/health` | Проверка состояния |
| GET | `/api/trends/capabilities` | Источники и наличие конфигурации AI |
| POST | `/api/trends/research` | Персональное исследование с инструментами и основаниями |
| GET / PUT | `/api/trends/profiles/:id` | Профиль |
| GET / PUT | `/api/trends/profiles/:id/modules` | Сводки разделов; PUT одной сводки |
| GET | `/api/trends/memory?profileId=default&query=` | История, число публикаций и оценок |
| GET / DELETE | `/api/trends/profiles/:id/history/:runId` | Прочитать / удалить отчёт |
| POST | `/api/trends/feedback` | `{profileId, url, verdict: "useful" / "not_useful"}` |
| GET | `/api/wardrobe/photos/capabilities` | Наличие конфигурации BiRefNet |
| POST | `/api/wardrobe/photos/remove-background` | Файл PNG/JPG/WebP → 202 и `{id, status}` |
| GET | `/api/wardrobe/photos/jobs/:id` | Состояние обработки фото |
| GET | `/api/wardrobe/photos/jobs/:id/result` | Готовый PNG с прозрачностью |
| POST | `/api/wardrobe/photos/jobs/:id/cancel` | Попытка отменить созданную задачу |

Пример реального запроса:

```sh
curl http://127.0.0.1:8787/api/trends/research \
  -H 'Content-Type: application/json' \
  -d '{"domain":"health","query":"силовые тренировки","windowDays":7,"limit":6,"mode":"live","enableAi":false,"strategy":"agent","useWeb":true,"profileId":"default"}'
```

- `domain`: `all`, `planning`, `finance`, `health`, `wardrobe`.
- `query`: до 160 символов; пустая строка означает все темы выбранной области.
- `windowDays`: 1–30; сравниваются два соседних окна одинаковой длины.
- `limit`: 1–10 тем.
- `mode`: `live` по умолчанию; `demo` нужно передать явно.
- `enableAi`: `false` по умолчанию.

Дополнительно: `profileId` (по умолчанию `default`), `strategy` (`workflow` / `agent`), `useWeb` (по умолчанию false), `remember` (true), `useModuleContext` (true).

Для `planning` пока нет живых RSS-источников — без `useWeb=true` API вернёт 422. В деморежиме область доступна. Нет скрытого переключения с live на demo при ошибке сети.

## Дела и календарь

Раздел работает в той же службе. Данные — `data/planning.sqlite`, ключ шифрования секретов — `data/planning.key`. Telegram-бот проекта запускается вместе со службой, если задан `TELEGRAM_BOT_TOKEN`; пользователи только привязывают свои чаты. Google и Яндекс подключаются на сайте («Дела и календарь» → «Подключения»), инструкции там же. [Устройство и ограничения](../docs/planning.md).

| Метод | Путь | Результат |
| --- | --- | --- |
| GET | `/api/planning/brief?date=` | План на день: события, задачи, пересечения, свободные окна, текст |
| GET | `/api/planning/agenda?from=&days=` | События и задачи по дням |
| GET / POST / PUT / DELETE | `/api/planning/events[/:id]` | События; `POST /events/:id/skip` — пропустить одно повторение |
| GET / POST / PUT / DELETE | `/api/planning/tasks[/:id]` | Задачи; `POST /tasks/:id/complete` создаёт следующую для повторяющихся |
| POST | `/api/planning/assistant` | `{message, history?, mode?}` → ответ ассистента: маршрут, текст, шаги агента, черновик |
| POST | `/api/planning/drafts` | `{text, useAi, force?}` → черновик; `POST /drafts/:id/confirm` сохраняет |
| GET / PUT | `/api/planning/settings` | Часовой пояс, время сводки, напоминания, рабочие часы |
| GET / DELETE | `/api/planning/accounts[/:id]` | Подключённые календари; `POST /accounts/:id/sync` |
| PUT | `/api/planning/google/config` | Client ID и Secret; `POST /google/start` — ссылка входа |
| POST | `/api/planning/yandex/connect` | `{login, password, calendarUrl?}` |
| GET / PUT / DELETE | `/api/planning/telegram` | Бот; `POST /telegram/link` — ссылка привязки чата |

Локальная модель для сложных фраз и агента: `PLANNING_LLM_MODEL=qwen3:8b` (Ollama). Без неё работают правила и диспетчер.

## Подключение к другим агентам

Типы запросов и ответов: `shared/trends.ts` в корне репозитория. Другой модуль может вызвать HTTP API или зарегистрировать инструмент напрямую:

```ts
import { TrendResearchService } from './src/trends/service.js'
import { createTrendTool } from './src/trends/tool.js'

const tool = createTrendTool(new TrendResearchService())
// tool.name, tool.description, tool.inputSchema — метаданные инструмента.
const report = await tool.execute({
  domain: 'wardrobe', query: 'гардероб', mode: 'live', windowDays: 7,
})
```

Импорты в примере указаны относительно `backend/`. Под конкретный агентный фреймворк потребуется небольшой адаптер регистрации; сама служба от фреймворка не зависит.

## Модель и память

Сейчас оба агента используют внешний OpenRouter API. LLM endpoint Runpod сохранён, но отключён (`workers.min=0`, `workers.max=0`), а `RUNPOD_LLM_ENDPOINT_ID` очищен. BiRefNet продолжает работать отдельно. [Текущие настройки и будущий переход на Runpod](../docs/llm.md).

Для будущего перехода на Qwen3-4B-Instruct-2507 включите максимум один worker у LLM endpoint и задайте `RUNPOD_LLM_ENDPOINT_ID` и существующий `RUNPOD_API_KEY` в закрытом `.env`. `RUNPOD_LLM_MODEL` задаёт имя модели. Один endpoint используется исследователем и стилистом, имеет приоритет над OpenRouter/Ollama и не включает автоматический платный fallback. [Развёртывание, расходы и проверка](../docs/llm.md).

Скопируйте `.env.example` в локальный `.env`. Для OpenRouter задайте `OPENROUTER_API_KEY` и `OPENROUTER_MODEL=openrouter/free`, затем перезапустите backend. Ключ не имеет префикса `VITE_` и не передаётся браузеру. Автоматического платного fallback нет.

При пустом `RUNPOD_LLM_ENDPOINT_ID` альтернатива — уже установленная Ollama: `TREND_LLM_MODEL` и `TREND_LLM_URL`. В этом случае при наличии ключа OpenRouter он имеет приоритет над Ollama. `configured=true` означает наличие настройки, а не гарантию доступности модели.

`strategy=agent` + `enableAi=true` включает динамический выбор девяти инструментов. При выключенной или недоступной модели действует фиксированный сценарий. Ответ содержит `agent.steps`, `agent.findings`, `webResults` и объяснения релевантности. Старый `strategy=workflow` без `useWeb` сохраняет RSS-сценарий и необязательный единичный анализ Ollama.

Память SQLite по умолчанию находится в `data/trends.sqlite` относительно backend; изменить путь можно через `TREND_MEMORY_PATH`. Сохраняются профиль, сводки разделов, отчёты, оценки и датированные наблюдения. База исключена из Git. `remember=false` запрещает запись текущего отчёта и наблюдений, но не чтение прошлой памяти.

Веб-поиск по умолчанию — Google News RSS; научные работы — Crossref. Для общего поиска задайте `TREND_SEARXNG_URL` своего SearXNG с JSON-ответами. Не все страницы доступны для чтения; недатированные материалы не участвуют в росте.

Профиль и сводки выбранных разделов передаются настроенной модели при включённом AI. Поисковик получает только явную тему и разрешённые интересы. Свободный доступ к файлам и произвольным адресам не предоставляется. `profileId` пока не является механизмом авторизации; сервер слушает loopback.

[Архитектура, инструменты, форматы контекста и ограничения](../docs/trends.md).

## Фото гардероба · BiRefNet на Runpod

В `backend/.env` задайте `RUNPOD_API_KEY` и `RUNPOD_BIREFNET_ENDPOINT_ID`; перезапустите API. Ключ остаётся на backend. Без этих настроек каталог и сохранение оригиналов работают, а удаление фона возвращает явную ошибку 503. `configured` означает наличие настроек, не готовность worker.

Backend отправляет PNG в Runpod `/run`, возвращает ID задачи, проверяет состояние через `/status` и получает результат отдельно. Доступны только задачи, созданные этим экземпляром backend. Неподдерживаемые файлы, лимиты, сбои Runpod и `output.error` не считаются успешной обработкой. Тайм-аут ожидания в браузере — 10 минут; отмена передаётся Runpod по возможности. При сетевой ошибке отмена не гарантируется.

Транспортный лимит фото — 6 МиБ; frontend заранее уменьшает копию до 1024 px, сохраняя оригинал в браузере. Лимит JSON службы трендов остаётся 8 КиБ. Авторизация пользователей, постоянное хранение заданий и распределённое выполнение backend пока отсутствуют; API остаётся локальным прототипом.

[Worker, развёртывание и контракт](../services/birefnet/README.md).

## Исследователь: проверка оснований и прогресс

`POST /api/trends/research/stream` принимает тот же запрос, что JSON-метод. Возвращает NDJSON: `{type:"progress", progress}`, затем `{type:"result", report}` либо `{type:"error", error}`. Закрытие потока отменяет незавершённое исследование и его сохранение. Некорректные параметры отклоняются JSON-ошибкой до начала потока.

В `report.agent` добавлены `plan`, `quality`, `metrics`; в находках — `support`, необязательные проверенные `supportingQuotes`. Оценка достаточности обзора не означает доказанную истинность вывода. Инструмент `assess_evidence` помогает модели выбрать следующий источник или завершиться с ограничениями.

`npm run eval:trends` проверяет семь сценариев без сети. `npm run eval:trends -- --live` отдельно сравнивает фиксированный сценарий и OpenRouter на одном публичном запросе, выводя метрики; ключ и модель читаются из локального `.env`.

[Источники рекомендаций, архитектура и ограничения](../docs/trends-agent-practices.md).

## Чат стилиста

Во вкладке «Гардероб → Стилист» используется общий планировщик платформы: Runpod, OpenRouter или Ollama. API: `GET /api/wardrobe/agent/capabilities`, `POST /api/wardrobe/agent/chat`, `POST /api/wardrobe/agent/chat/stream` (NDJSON). В снимок не включаются фото. Модель читает инструменты и готовит карточки, применяемые пользователем через браузерный репозиторий. Поиск моды делегирован существующей `TrendResearchService` с отменой, источниками и общей историей.

Настройки `WARDROBE_OPENROUTER_MODEL`, `WARDROBE_LLM_MODEL`, `WARDROBE_LLM_URL` необязательны: по умолчанию используются ключ и модель проекта. `npm run eval:wardrobe` — отдельный живой прогон на искусственных данных; `npm test` работает без модели и сети. Подробности: [агент гардероба](../docs/wardrobe-agent.md).

Фото в чате: `POST /api/wardrobe/agent/photos/inspect`. Нужен `OPENROUTER_API_KEY`; `WARDROBE_VISION_MODEL` переопределяет бесплатную vision-модель. Текстовый агент и распознавание фото используют отдельные запросы и настройки модели. [Контракт, лимиты и живой smoke-тест](../docs/wardrobe-chat-photos.md).

Стилист сам выбирает image-инструменты и изменения по запросу в чате. Поток включает `tool_request`; браузер возвращает результат через `POST /api/wardrobe/agent/tool-results/:token`. Фотографии хранятся в браузере, автообработки до решения модели нет. Живая проверка нового цикла: `node --import tsx scripts/check-wardrobe-tools.mjs`.

## Чат трендов

В разделе появился отдельный диалог с серверной историей. Сначала выполняются детерминированные команды и инструменты; для свободного вопроса используется тот же настроенный ResearchPlanner. Вложенный модельный агент при новом исследовании не вызывается.

`GET /api/trends/chat/tools` возвращает каталог. `GET/POST /api/trends/chat/:profileId/conversations` — список/создание; `GET .../:id` — состояние; `POST .../:id/messages/stream` — сообщения с NDJSON-прогрессом. Запрос включает `turnId`, `expectedRevision`, `text`, `mode`, `enableAi`, `useWeb`, `useModuleContext`.

[Контракты девяти инструментов, примеры команд, запись и ограничения](../docs/trend-chat.md).
