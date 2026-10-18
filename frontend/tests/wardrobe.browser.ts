import { createBrowserWardrobeRepository } from '../src/modules/wardrobe/repository'
import { originalPhotoProcessor, removePhotoBackground } from '../src/modules/wardrobe/photoProcessor'
import type { Garment } from '../src/modules/wardrobe/types'
import { runOutfitChecks } from './outfits.browser'
import { runOutfitUIChecks } from './outfit-ui.browser'
import { runWishlistChecks } from './wishlist.browser'
import { runWardrobeFlowChecks } from './wardrobe-flow.browser'

const results = document.querySelector('#results')!
const summary = document.querySelector('#summary')!
let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(name: string, action: () => Promise<void>) {
  const row = document.createElement('li')
  try {
    await action()
    row.textContent = `PASS: ${name}`
    passed += 1
  } catch (cause) {
    row.dataset.result = 'fail'
    row.textContent = `FAIL: ${name}: ${cause instanceof Error ? cause.message : String(cause)}`
    failed += 1
  }
  results.append(row)
  document.title = `Гардероб: ${passed} PASS, ${failed} FAIL`
}

async function expectRejection(file: File) {
  let rejected = false
  try { await originalPhotoProcessor.process(file) } catch { rejected = true }
  assert(rejected, 'Некорректный файл должен быть отклонён')
}

const canvas = document.createElement('canvas')
canvas.width = 96
canvas.height = 128
canvas.getContext('2d')!.fillRect(20, 15, 56, 100)
const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
const file = new File([image], 'synthetic-shirt.png', { type: 'image/png' })
const testDatabase = `graphite-wardrobe-check-${crypto.randomUUID()}`
const repository = createBrowserWardrobeRepository(testDatabase)
const photo = await originalPhotoProcessor.process(file)
const garment: Garment = {
  id: crypto.randomUUID(), name: 'Тестовая рубашка', category: 'tops', color: 'black',
  season: 'all', brand: '', notes: '', photo,
  createdAt: '2026-10-17T12:00:00.000Z', updatedAt: '2026-10-17T12:00:00.000Z',
}

try {
  await check('Фото декодируется; оригинал и фон сохранены', async () => {
    assert(photo.processing === 'original', 'Фон не должен считаться удалённым')
    assert(photo.original === file && photo.display === file, 'Исходный файл изменён')
  })
  await check('Переход с версии 1 сохраняет существующие вещи и добавляет образы', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(testDatabase, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('garments', { keyPath: 'id' })
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('garments', 'readwrite')
        transaction.objectStore('garments').put(garment)
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onabort = () => { database.close(); reject(transaction.error) }
      }
    })
    assert((await repository.list())[0]?.id === garment.id, 'Вещь потеряна при переходе')
    assert((await repository.listOutfits()).length === 0 && (await repository.listWearEvents()).length === 0, 'Новые таблицы не созданы')
  })
  await check('Запись и чтение фотографии из IndexedDB', async () => {
    await repository.save(garment)
    const stored = (await repository.list())[0]
    assert(stored?.name === garment.name, 'Вещь не найдена')
    assert(stored.photo.display instanceof Blob, 'Фото должно оставаться Blob')
    assert(stored.photo.display.size === file.size, 'Размер фото изменился')
    const actual = new Uint8Array(await stored.photo.display.arrayBuffer())
    const expected = new Uint8Array(await file.arrayBuffer())
    assert(actual.every((byte, index) => byte === expected[index]), 'Байты фото изменились')
  })
  await check('Вещь доступна через новое соединение с базой', async () => {
    const reconnected = createBrowserWardrobeRepository(testDatabase)
    assert((await reconnected.list())[0]?.id === garment.id, 'Запись не сохранилась')
  })
  await check('Редактирование не создаёт дубликат', async () => {
    await repository.save({ ...garment, name: 'Обновлённая рубашка' })
    const items = await repository.list()
    assert(items.length === 1 && items[0].name === 'Обновлённая рубашка', 'Неверное обновление')
  })
  await check('Удаление тестовой вещи сохраняется', async () => {
    await repository.remove(garment.id)
    assert((await repository.list()).length === 0, 'Вещь осталась в базе')
  })
  await check('Повреждённое изображение отклоняется', () => expectRejection(new File(['broken'], 'bad.png', { type: 'image/png' })))
  await check('Неподдерживаемый формат отклоняется', () => expectRejection(new File(['text'], 'note.txt', { type: 'text/plain' })))
  await check('Файл больше 15 МБ отклоняется', () => expectRejection(new File([new Uint8Array(15 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })))
  await check('Очередь обработки → PNG; оригинал не заменяется', async () => {
    const realFetch = window.fetch
    const progress: string[] = []
    const calls: string[] = []
    window.fetch = async (url, options) => {
      calls.push(String(url))
      if (String(url).endsWith('/remove-background')) {
        assert(options?.body instanceof Blob, 'Фото передаётся как Blob')
        assert(options.body.type === 'image/png', 'На обработку отправляется PNG')
        return Response.json({ id: 'browser-test-job', status: 'queued' }, { status: 202 })
      }
      if (String(url).endsWith('/result')) return new Response(image, { headers: { 'Content-Type': 'image/png' } })
      return Response.json({ id: 'browser-test-job', status: 'succeeded' })
    }
    try {
      const processed = await removePhotoBackground(file, undefined, state => progress.push(state))
      assert(processed.original === file, 'Оригинал должен остаться прежним')
      assert(processed.processing === 'background-removed', 'Успех только после получения PNG')
      assert(processed.display.type === 'image/png', 'Результат — PNG')
      assert(progress.includes('queued') && calls.length === 3, 'Должны пройти создание, ожидание и загрузка')
    } finally { window.fetch = realFetch }
  })
  await check('Ошибка сервиса оставляет исходное фото без изменений', async () => {
    const realFetch = window.fetch
    window.fetch = async () => Response.json({ error: 'Обработчик пока не настроен.' }, { status: 503 })
    try {
      let message = ''
      try { await removePhotoBackground(file) } catch (cause) { message = (cause as Error).message }
      assert(message.includes('не настроен'), 'Показываем причину отказа')
      assert(photo.original === file && photo.processing === 'original', 'Оригинал не меняется при ошибке')
    } finally { window.fetch = realFetch }
  })
  await check('Отмена во время отправки отменяет уже созданную задачу', async () => {
    const realFetch = window.fetch
    const controller = new AbortController()
    let cancelled = false
    window.fetch = async url => {
      if (String(url).endsWith('/cancel')) { cancelled = true; return new Response(null, { status: 204 }) }
      controller.abort()
      return Response.json({ id: 'cancel-test-job', status: 'queued' }, { status: 202 })
    }
    try {
      let rejected = false
      try { await removePhotoBackground(file, controller.signal) } catch { rejected = true }
      assert(rejected && cancelled, 'Созданная удалённая задача должна получить отмену')
    } finally { window.fetch = realFetch }
  })
  await runOutfitChecks(check, repository, garment)
  await runOutfitUIChecks(check, garment)
  await runWishlistChecks(check, repository, garment)
  await runWardrobeFlowChecks(check, garment)
  summary.textContent = `Готово. Успешно: ${passed}. Ошибок: ${failed}.`
  document.title = `Готово: ${passed} PASS, ${failed} FAIL · Гардероб`
} finally {
  // Connections close on versionchange, then only the isolated test database is deleted.
  indexedDB.deleteDatabase(testDatabase)
}
