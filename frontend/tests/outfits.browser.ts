import type { Garment, Outfit, WardrobeRepository, WearEvent } from '../src/modules/wardrobe/types'
import { combinationKey, fitLayer, garmentWearStats, localDate } from '../src/modules/wardrobe/outfitDomain'

export type BrowserCheck = (name: string, action: () => Promise<void>) => Promise<void>

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function mustReject(action: () => Promise<unknown>) {
  let rejected = false
  try { await action() } catch { rejected = true }
  assert(rejected, 'Операция должна завершиться отказом')
}

export async function runOutfitChecks(check: BrowserCheck, repository: WardrobeRepository, garment: Garment) {
  const trousers: Garment = { ...garment, id: crypto.randomUUID(), name: 'Брюки', category: 'bottoms' }
  const shoes: Garment = { ...garment, id: crypto.randomUUID(), name: 'Обувь', category: 'shoes' }
  const date = localDate()
  const previous = new Date()
  previous.setDate(previous.getDate() - 1)
  const yesterday = localDate(previous)
  const outfit: Outfit = {
    id: crypto.randomUUID(), name: 'Рубашка и брюки', notes: 'Тест',
    layers: [{ garmentId: garment.id, x: 5, y: 8, size: 40 }, { garmentId: trousers.id, x: 48, y: 43, size: 45 }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const alternate: Outfit = { ...outfit, id: crypto.randomUUID(), name: 'Рубашка и обувь', layers: [outfit.layers[0], { garmentId: shoes.id, x: 30, y: 60, size: 28 }] }
  let firstWear: WearEvent | undefined

  await check('Доска: границы и размер ограничены; дата берётся локально', async () => {
    const fitted = fitLayer({ garmentId: garment.id, x: 120, y: -20, size: 90 })
    assert(fitted.size === 65 && fitted.x === 35 && fitted.y === 0, 'Вещь вышла за границы доски')
    assert(localDate(new Date(2026, 9, 17, 0, 30)) === '2026-10-17', 'Использована дата UTC вместо местной')
  })
  await check('Образ сохраняет координаты, размер и порядок слоёв', async () => {
    await Promise.all([repository.save(garment), repository.save(trousers), repository.save(shoes)])
    await repository.saveOutfit(outfit)
    const stored = (await repository.listOutfits()).find(item => item.id === outfit.id)
    assert(stored && JSON.stringify(stored.layers) === JSON.stringify(outfit.layers), 'Расположение вещей изменилось')
  })
  await check('Пустой образ, повтор вещи и несуществующая вещь не сохраняются', async () => {
    await mustReject(() => repository.saveOutfit({ ...outfit, layers: [] }))
    await mustReject(() => repository.saveOutfit({ ...outfit, layers: [outfit.layers[0], outfit.layers[0]] }))
    await mustReject(() => repository.saveOutfit({ ...outfit, layers: [{ garmentId: 'missing', x: 0, y: 0, size: 40 }] }))
    assert((await repository.listOutfits()).length === 1, 'Невалидная запись изменила каталог')
  })
  await check('Одновременные отметки одного сочетания за день не дублируются', async () => {
    const [a, b] = await Promise.all([repository.recordWear(outfit.id, date), repository.recordWear(outfit.id, date)])
    firstWear = a
    assert(a.id === b.id && (await repository.listWearEvents()).length === 1, 'Повторная отметка создала дубликат')
    assert(a.garments.some(item => item.name === garment.name), 'Снимок названия вещи отсутствует')
  })
  await check('Перестановка слоёв и другой образ с тем же составом не увеличивают счётчик', async () => {
    const reordered = { ...outfit, id: crypto.randomUUID(), layers: [...outfit.layers].reverse().map(layer => ({ ...layer, x: 0, y: 0 })) }
    assert(combinationKey(outfit.layers) === combinationKey(reordered.layers), 'Положение изменило идентичность сочетания')
    await repository.saveOutfit(reordered)
    const repeated = await repository.recordWear(reordered.id, date)
    assert(repeated.id === firstWear?.id && (await repository.listWearEvents()).length === 1, 'Другой ID образа дал лишний выход')
    await repository.removeOutfit(reordered.id)
  })
  await check('Дни носки вещи не удваиваются при двух образах за день', async () => {
    await repository.recordWear(outfit.id, yesterday)
    await repository.saveOutfit(alternate)
    await repository.recordWear(alternate.id, date)
    const events = await repository.listWearEvents()
    const stats = garmentWearStats([garment, trousers, shoes], events)
    assert(events.length === 3, 'Не сохранились все выходы')
    assert(stats.find(item => item.garment.id === garment.id)?.days === 2, 'Рубашка должна иметь 2 дня носки')
    assert(stats.find(item => item.garment.id === trousers.id)?.days === 2, 'Брюки должны иметь 2 дня носки')
    assert(stats.find(item => item.garment.id === shoes.id)?.days === 1, 'Обувь должна иметь 1 день носки')
  })
  await check('Редактирование вещи и состава образа не переписывает прошлые выходы', async () => {
    await repository.save({ ...garment, name: 'Другое название' })
    await repository.saveOutfit({ ...outfit, name: 'Новый состав', layers: [outfit.layers[0]] })
    const stored = (await repository.listWearEvents()).find(item => item.id === firstWear?.id)
    assert(stored?.outfitName === outfit.name && stored.garments.length === 2, 'История состава изменилась')
    assert(stored.garments.some(item => item.name === garment.name), 'Историческое название изменилось')
    const newWear = await repository.recordWear(outfit.id, date)
    assert(newWear.id !== firstWear?.id && newWear.garments.length === 1, 'Новый состав смешан с прежним сочетанием')
  })
  await check('Будущая и несуществующая даты отклоняются', async () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    await mustReject(() => repository.recordWear(outfit.id, localDate(tomorrow)))
    await mustReject(() => repository.recordWear(outfit.id, '2025-02-30'))
  })
  await check('Отмена отметки пересчитывает дни носки', async () => {
    const events = await repository.listWearEvents()
    const previousWear = events.find(event => event.date === yesterday)!
    await repository.removeWearEvent(previousWear.id)
    const stats = garmentWearStats([garment], await repository.listWearEvents())
    assert(stats[0].days === 1, 'Отменённый выход остался в статистике')
  })
  await check('Удалённые вещи не создают новых выходов; история не теряется', async () => {
    const before = await repository.listWearEvents()
    await repository.remove(garment.id)
    // The unrecorded previous day must validate the current references, not a cached event.
    await mustReject(() => repository.recordWear(outfit.id, yesterday))
    await repository.removeOutfit(outfit.id)
    const after = await repository.listWearEvents()
    assert(after.length === before.length && after.some(event => event.id === firstWear?.id), 'Удаление вещи/образа стёрло историю')
    await mustReject(() => repository.recordWear(outfit.id, date))
  })
}
