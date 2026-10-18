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

Скопируйте `.env.example` в локальный `.env`. Для OpenRouter задайте `OPENROUTER_API_KEY` и `OPENROUTER_MODEL=openrouter/free`, затем перезапустите backend. Ключ не имеет префикса `VITE_` и не передаётся браузеру. Автоматического платного fallback нет.

Альтернатива — уже установленная Ollama: `TREND_LLM_MODEL` и `TREND_LLM_URL`. При наличии ключа OpenRouter имеет приоритет. `configured=true` означает наличие настройки, а не гарантию доступности модели.

`strategy=agent` + `enableAi=true` включает динамический выбор девяти инструментов. При выключенной или недоступной модели действует фиксированный сценарий. Ответ содержит `agent.steps`, `agent.findings`, `webResults` и объяснения релевантности. Старый `strategy=workflow` без `useWeb` сохраняет RSS-сценарий и необязательный единичный анализ Ollama.

Память SQLite по умолчанию находится в `data/trends.sqlite` относительно backend; изменить путь можно через `TREND_MEMORY_PATH`. Сохраняются профиль, сводки разделов, отчёты, оценки и датированные наблюдения. База исключена из Git. `remember=false` запрещает запись текущего отчёта и наблюдений, но не чтение прошлой памяти.

Веб-поиск по умолчанию — Google News RSS; научные работы — Crossref. Для общего поиска задайте `TREND_SEARXNG_URL` своего SearXNG с JSON-ответами. Не все страницы доступны для чтения; недатированные материалы не участвуют в росте.

Профиль и сводки выбранных разделов передаются настроенной модели при включённом AI. Поисковик получает только явную тему и разрешённые интересы. Свободный доступ к файлам и произвольным адресам не предоставляется. `profileId` пока не является механизмом авторизации; сервер слушает loopback.

[Архитектура, инструменты, форматы контекста и ограничения](../docs/trends.md).

## Исследователь: проверка оснований и прогресс

`POST /api/trends/research/stream` принимает тот же запрос, что JSON-метод. Возвращает NDJSON: `{type:"progress", progress}`, затем `{type:"result", report}` либо `{type:"error", error}`. Закрытие потока отменяет незавершённое исследование и его сохранение. Некорректные параметры отклоняются JSON-ошибкой до начала потока.

В `report.agent` добавлены `plan`, `quality`, `metrics`; в находках — `support`, необязательные проверенные `supportingQuotes`. Оценка достаточности обзора не означает доказанную истинность вывода. Инструмент `assess_evidence` помогает модели выбрать следующий источник или завершиться с ограничениями.

`npm run eval:trends` проверяет семь сценариев без сети. `npm run eval:trends -- --live` отдельно сравнивает фиксированный сценарий и OpenRouter на одном публичном запросе, выводя метрики; ключ и модель читаются из локального `.env`.

[Источники рекомендаций, архитектура и ограничения](../docs/trends-agent-practices.md).
