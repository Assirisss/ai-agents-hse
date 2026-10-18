# BiRefNet · Runpod Serverless

`main.py` описывает GPU worker. Модель, CUDA и обработка фотографий запускаются **в Runpod**. Локально нужен только клиент развёртывания; backend вызывает обычный Runpod REST API без Python.

Модель: [ZhengPeng7/BiRefNet](https://huggingface.co/ZhengPeng7/BiRefNet), revision `e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4`. Загрузка remote code закреплена за той же ревизией; веса — safetensors. Подготовка входа и нормализация соответствуют [примеру автора](https://huggingface.co/ZhengPeng7/BiRefNet/blob/main/handler.py).

## Развёрнутый endpoint

На 2026-10-18: приложение `graphite-wardrobe`, окружение `production`, GPU queue endpoint `graphite-birefnet-worker`, ID `qzgs7ssd6bf2df`.

- Асинхронный вызов: `https://api.runpod.ai/v2/qzgs7ssd6bf2df/run`.
- Синхронный вызов для прогретого worker: `https://api.runpod.ai/v2/qzgs7ssd6bf2df/runsync`.
- Backend уже настроен на этот ID. Ключ находится в исключённом из Git `backend/.env` с правами 600; не добавляйте его в клиентский код.
- Реальная задача через backend `00265b61-a2aa-46db-9ea8-3455511976ca-u1` завершилась успешно: 16,282 с в очереди, 10,052 с выполнения. Получен PNG 640 × 480 с alpha 0–255. Это технический тест на публичном изображении, качество на наборе одежды ещё не оценено.
- Временные dev endpoints `8jy0tnqwxcocyh` и `4bzc01uy1jv711` удалены, отсутствие проверено чтением (404). Production endpoint сохранён.
- Экономия после развёртывания: `workers.min=0`, `workers.max=1`, `idleTimeout=1` секунда (уменьшен с 20 секунд до минимума Runpod). При редких запросах worker быстрее освобождается; новый запрос может ждать холодный старт. Настройки проверены повторным чтением endpoint, дополнительных GPU-задач для этой проверки не запускалось.

Для удаления production откройте endpoint `qzgs7ssd6bf2df` в консоли Runpod либо используйте `flash app delete graphite-wardrobe` (удаляет приложение и его endpoint). После удаления очистите `RUNPOD_BIREFNET_ENDPOINT_ID` на backend.

## Подготовка клиента

Python 3.12 и uv. Из этой папки:

```sh
uv venv --python 3.12
uv pip install --python .venv/bin/python -r requirements.txt
```

В `backend/.env` задайте `RUNPOD_API_KEY`. Файл исключён из Git. `manage.py` читает ключ оттуда, не выводя его и не копируя в frontend.

## Проверка и развёртывание

```sh
.venv/bin/python manage.py dev --no-reload --port 8789
```

Это локальный клиент с маршрутом `POST /main/runsync`; функция выполняется на удалённом GPU. Тело: `{"input":{"input_data":{"image_base64":"…","mime_type":"image/png"}}}`. Первое обращение создаёт dev endpoint, устанавливает зависимости и скачивает модель **на worker**. Веса не загружаются на компьютер.

После проверки worker:

```sh
.venv/bin/python manage.py deploy --app graphite-wardrobe --env production --python-version 3.12 --no-deps
```

Запишите ID **GPU queue endpoint** для `graphite-birefnet-worker` в `RUNPOD_BIREFNET_ENDPOINT_ID` в `backend/.env` и перезапустите backend. ID нужно взять из результата развёртывания и проверить чтением endpoint, а не угадывать по имени.

PyTorch, torchvision и NumPy берутся из штатного образа Runpod Flash: переустановка поверх уже импортированного PyTorch в dev worker приводит к несовместимым бинарным модулям. Остальные зависимости явно перечислены в декораторе. `--no-deps` исключает загрузку транзитивных CUDA/PyTorch wheels на компьютер при упаковке; веса модели скачиваются только на Runpod.

Если Python-клиент завершает загрузку сборки с SSL-ошибкой, а системный curl устанавливает TLS-соединение, есть узкий вариант загрузки через системный TLS:

```sh
.venv/bin/python manage.py --curl-upload deploy --app graphite-wardrobe --env production --python-version 3.12 --no-deps
```

Проверка сертификатов остаётся включённой. Подписанная ссылка на загрузку передаётся curl через stdin и не выводится в аргументах процесса.

Клиент закреплён на `runpod-flash==1.21.0`. Эта версия сообщает о переходе Flash в Runpod SDK 2.0; перед будущим обновлением клиента следует пройти [инструкцию миграции](https://docs.runpod.io/sdk/migrate-from-flash). Сам backend использует независимый от Flash HTTP-контракт очереди Runpod.

## Контракт worker

Вход Runpod: `{"input":{"input_data":{"image_base64":"…","mime_type":"image/png"}}}`.

Выход `output`: `{image_base64, mime_type: "image/png", width, height, model, revision}`. Ошибки проверки изображения возвращаются как `output.error`; backend считает такую задачу неуспешной даже при Runpod-статусе `COMPLETED`.

- До 6 МиБ на транспортный файл; JPG, PNG и WebP, неподвижное изображение, до 40 Мп.
- Frontend сохраняет оригинал до 15 МиБ / 40 Мп, а для обработки создаёт PNG с длинной стороной до 1024 px. Это ограничивает размер base64-запроса и ответа без внешнего файлового хранилища.
- Worker дополнительно ограничивает размер результата до 1024 px, сохраняя пропорции. Нормализованный тензор модели — 1024 × 1024.
- Изменяется alpha-канал; существующая прозрачность умножается на маску. RGB обработанной копии сохраняется. Оригинал хранится отдельно в IndexedDB.
- Модель загружается один раз на worker. Конфигурация: `AMPERE_16`, один GPU, CUDA ≥ 12.8, workers 0–1, idle timeout 1 секунда, FlashBoot, execution timeout 180 секунд. Постоянный worker и network volume не создаются.
- Масштабирование до нуля убирает постоянный работающий GPU; cold start, установка зависимостей и загрузка модели могут задержать первую задачу. Время активного worker и idle timeout оплачиваются по Runpod.
- Для холодного старта backend использует `/run` и `/status/{jobId}`, не ограниченный коротким ожиданием `/runsync`.

Фотографии отправляются Runpod только по кнопке удаления фона. В worker нет записи фотографий на диск; вход и результат передаются через очередь Runpod. На стороне приложения текущие job ID и результат хранятся в памяти backend: после его перезапуска нужно повторить обработку. Срок доступа к задаче — 15 минут, к готовому PNG — 2 минуты.

Качество выделения вещи на фото с человеком или несколькими предметами пока не оценено. BiRefNet отделяет передний план; выделение одной выбранной вещи из человека не обещается.
