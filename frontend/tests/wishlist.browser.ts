import type { Garment, WishlistItem, WardrobeRepository } from '../src/modules/wardrobe/types'
import { createBrowserWardrobeRepository } from '../src/modules/wardrobe/repository'
import { parsePrice, validateWishlist } from '../src/modules/wardrobe/wishlistDomain'
import type { BrowserCheck } from './outfits.browser'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function rejected(action: () => unknown | Promise<unknown>) {
  let failed = false
  try { await action() } catch { failed = true }
  assert(failed, 'Ожидался отказ')
}

export async function runWishlistChecks(check: BrowserCheck, repository: WardrobeRepository, garment: Garment) {
  const item: WishlistItem = { id: crypto.randomUUID(), name: 'Будущая рубашка', category: 'tops', priceMinor: 129990, currency: 'RUB', priority: 'high', url: 'https://example.com/shirt', notes: '', status: 'planned', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  let purchasedId = ''
  await check('Цена хранится точно в копейках; пустая цена отличается от нуля', async () => {
    assert(parsePrice('12 500,50') === 1250050 && parsePrice('0') === 0 && parsePrice('') === null, 'Цена округлена или потеряна')
    await rejected(() => parsePrice('-100'))
    await rejected(() => parsePrice('12,345'))
    await rejected(() => parsePrice('Infinity'))
  })
  await check('Опасные ссылки и некорректные суммы не сохраняются', async () => {
    await rejected(() => repository.saveWishlistItem({ ...item, url: 'javascript:alert(1)' }))
    await rejected(() => repository.saveWishlistItem({ ...item, priceMinor: -1 }))
    assert((await repository.listWishlist()).length === 0, 'Невалидная покупка попала в базу')
    assert(validateWishlist(item).url === item.url, 'Обычная ссылка отклонена')
  })
  await check('Покупка без фото и цены сохраняется', async () => {
    const saved = await repository.saveWishlistItem({ ...item, priceMinor: null })
    assert(saved.status === 'planned' && saved.priceMinor === null && !saved.photo, 'Необязательные поля заменены')
    assert((await repository.listWishlist()).some(value => value.id === item.id), 'Покупка потерялась')
  })
  await check('Неудачный перенос не помечает покупку купленной', async () => {
    await rejected(() => repository.purchaseWishlistItem(item.id, { ...garment, id: crypto.randomUUID(), photo: { ...garment.photo, display: new Blob() } }))
    assert((await repository.listWishlist()).find(value => value.id === item.id)?.status === 'planned', 'Отказ оставил половину изменений')
  })
  await check('Параллельный перенос покупки в гардероб создаёт одну вещь', async () => {
    const before = (await repository.list()).length
    const [a, b] = await Promise.all([
      repository.purchaseWishlistItem(item.id, { ...garment, id: crypto.randomUUID() }),
      repository.purchaseWishlistItem(item.id, { ...garment, id: crypto.randomUUID() }),
    ])
    purchasedId = a.garment.id
    assert(a.garment.id === b.garment.id && a.item.status === 'purchased', 'Создан дубликат')
    assert((await repository.list()).length === before + 1, 'Неверное число вещей')
    assert(a.item.garmentId === purchasedId && a.garment.photo.display.size === garment.photo.display.size, 'Связь или фото потеряны')
  })
  await check('Устаревшая форма покупки не отменяет выполненный перенос', async () => {
    const saved = await repository.saveWishlistItem({ ...item, name: 'Изменённое название' })
    assert(saved.status === 'purchased' && saved.garmentId === purchasedId, 'Старая форма сбросила статус')
  })
  await check('Удаление из желаний не удаляет купленную вещь', async () => {
    await repository.removeWishlistItem(item.id)
    assert((await repository.list()).some(value => value.id === purchasedId), 'Вещь удалена вместе с покупкой')
    await rejected(() => repository.purchaseWishlistItem(item.id, { ...garment, id: crypto.randomUUID() }))
  })
  await check('Миграция версии 2 сохраняет каталог, образы и историю', async () => {
    const databaseName = `wardrobe-v2-check-${crypto.randomUUID()}`
    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 2)
        request.onupgradeneeded = () => { for (const name of ['garments', 'outfits', 'wearEvents']) request.result.createObjectStore(name, { keyPath: 'id' }) }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction(['garments', 'outfits', 'wearEvents'], 'readwrite')
          transaction.objectStore('garments').put(garment)
          transaction.objectStore('outfits').put({ id: 'old-outfit', name: 'Старый образ', notes: '', layers: [{ garmentId: garment.id, x: 0, y: 0, size: 40 }], createdAt: garment.createdAt, updatedAt: garment.updatedAt })
          transaction.objectStore('wearEvents').put({ id: 'old-event', date: '2026-10-17', outfitId: 'old-outfit', outfitName: 'Старый образ', combinationKey: JSON.stringify([garment.id]), garments: [{ id: garment.id, name: garment.name }], createdAt: garment.createdAt })
          transaction.oncomplete = () => { db.close(); resolve() }
          transaction.onabort = () => { db.close(); reject(transaction.error) }
        }
      })
      const migrated = createBrowserWardrobeRepository(databaseName)
      const [things, outfits, events, wishlist] = await Promise.all([migrated.list(), migrated.listOutfits(), migrated.listWearEvents(), migrated.listWishlist()])
      assert(things.length === 1 && outfits.length === 1 && events.length === 1 && wishlist.length === 0, 'Старые записи потерялись')
    } finally { indexedDB.deleteDatabase(databaseName) }
  })
}
