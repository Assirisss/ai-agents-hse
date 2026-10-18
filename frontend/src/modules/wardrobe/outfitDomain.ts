import type { Garment, OutfitDraft, OutfitLayer, WearEvent } from './types'

export const MAX_OUTFIT_ITEMS = 20
export const MIN_LAYER_SIZE = 15
export const MAX_LAYER_SIZE = 65

export function arrangeOutfitLayers(ids: string[], garments: Garment[]): OutfitLayer[] {
  const catalog = new Map(garments.map(garment => [garment.id, garment]))
  const positions = [[5, 5], [48, 35], [4, 60], [63, 4]]
  return [...new Set(ids)].filter(id => catalog.has(id)).slice(0, MAX_OUTFIT_ITEMS).map((garmentId, index) => {
    const category = catalog.get(garmentId)!.category
    const size = ['shoes', 'accessories', 'bags'].includes(category) ? 28 : 43
    const [x, y] = positions[index % positions.length]
    return fitLayer({ garmentId, x, y, size })
  })
}

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function combinationKey(layers: Pick<OutfitLayer, 'garmentId'>[]): string {
  return JSON.stringify([...new Set(layers.map(layer => layer.garmentId))].sort())
}

export function fitLayer(layer: OutfitLayer): OutfitLayer {
  const size = Math.max(MIN_LAYER_SIZE, Math.min(MAX_LAYER_SIZE, layer.size))
  return { ...layer, size, x: Math.max(0, Math.min(100 - size, layer.x)), y: Math.max(0, Math.min(100 - size, layer.y)) }
}

export function validateOutfit(draft: OutfitDraft): OutfitDraft {
  const name = draft.name.trim()
  if (!name || name.length > 100) throw new Error('Назовите образ: от 1 до 100 символов.')
  if (draft.notes.length > 1000) throw new Error('Заметка должна быть короче 1000 символов.')
  if (draft.layers.length < 1 || draft.layers.length > MAX_OUTFIT_ITEMS) throw new Error(`Добавьте на доску от 1 до ${MAX_OUTFIT_ITEMS} вещей.`)
  const ids = new Set<string>()
  for (const layer of draft.layers) {
    if (!layer.garmentId || ids.has(layer.garmentId)) throw new Error('Одна вещь может быть на доске только один раз.')
    ids.add(layer.garmentId)
    if (![layer.x, layer.y, layer.size].every(Number.isFinite) || layer.size < MIN_LAYER_SIZE || layer.size > MAX_LAYER_SIZE || layer.x < 0 || layer.y < 0 || layer.x + layer.size > 100.0001 || layer.y + layer.size > 100.0001) {
      throw new Error('Вещи должны оставаться внутри доски.')
    }
  }
  return { name, notes: draft.notes.trim(), layers: draft.layers.map(layer => ({ ...layer })) }
}

export function validateWearDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Выберите дату выхода.')
  const parsed = new Date(`${date}T12:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date > localDate()) {
    throw new Error('Дата выхода должна быть существующей датой не позже сегодняшней.')
  }
}

export function garmentWearStats(garments: Garment[], events: WearEvent[]) {
  const dates = new Map<string, Set<string>>()
  for (const event of events) {
    for (const garment of event.garments) {
      let worn = dates.get(garment.id)
      if (!worn) { worn = new Set(); dates.set(garment.id, worn) }
      worn.add(event.date)
    }
  }
  return garments.map(garment => {
    const worn = [...(dates.get(garment.id) ?? [])].sort()
    return { garment, days: worn.length, lastDate: worn.at(-1) ?? null }
  }).sort((a, b) => b.days - a.days || a.garment.name.localeCompare(b.garment.name, 'ru'))
}

export function formatWearDate(date: string) {
  return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`))
}
