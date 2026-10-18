import type { UserModuleContext } from '../../../../shared/trends'

export type ModuleContextAdapter = () => Promise<Omit<UserModuleContext, 'updatedAt'> | null>
type GarmentMetadata = { category?: string; color?: string; season?: string }
const labels: Record<string, string> = {
  tops: 'верх', bottoms: 'низ', outerwear: 'верхняя одежда', dresses: 'платья', shoes: 'обувь', bags: 'сумки', accessories: 'аксессуары',
  black: 'чёрный', white: 'белый', grey: 'серый', beige: 'бежевый', brown: 'коричневый', blue: 'синий', green: 'зелёный', red: 'красный', pink: 'розовый', yellow: 'жёлтый', purple: 'фиолетовый', multicolor: 'разноцветный',
  all: 'круглый год', spring: 'весна', summer: 'лето', autumn: 'осень', winter: 'зима',
}
export function summarizeWardrobe(items: GarmentMetadata[], outfits: number, wears: number): string[] {
  const facts = [`В каталоге гардероба: ${items.length} вещей`, `Сохранено образов: ${outfits}`, `Записей ношения: ${wears}`]
  for (const [field, title] of [['category', 'Категория'], ['color', 'Цвет'], ['season', 'Сезон']] as const) {
    const counts = new Map<string, number>()
    for (const item of items) { const key = item[field]; if (key && labels[key]) counts.set(key, (counts.get(key) || 0) + 1) }
    for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 7)) facts.push(`${title}: ${labels[key]} — ${count}`)
  }
  return facts
}

/** Only open an existing database, never upgrade it or write to wardrobe stores. */
async function wardrobeContext(): ReturnType<ModuleContextAdapter> {
  if (!globalThis.indexedDB) return null
  const name = 'graphite-wardrobe'
  if (indexedDB.databases && !(await indexedDB.databases()).some((db) => db.name === name)) return { module: 'wardrobe', source: 'Каталог в этом браузере не подключён', facts: [] }
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(name)
    let settled = false
    const timer = window.setTimeout(() => { settled = true; reject(new Error('Каталог занят. Закройте другие версии приложения и повторите.')) }, 5000)
    request.onupgradeneeded = () => { request.transaction?.abort() }
    request.onerror = () => { window.clearTimeout(timer); if (!settled) resolve(null) }
    request.onsuccess = () => { window.clearTimeout(timer); if (settled) request.result.close(); else resolve(request.result) }
  })
  if (!db) return { module: 'wardrobe', source: 'Каталог в этом браузере не подключён', facts: [] }
  try {
    const available = ['garments', 'outfits', 'wearEvents'].filter((store) => db.objectStoreNames.contains(store))
    if (!available.includes('garments')) return null
    const data = await new Promise<{ items: GarmentMetadata[]; outfits: number; wears: number }>((resolve, reject) => {
      const transaction = db.transaction(available, 'readonly')
      const result = { items: [] as GarmentMetadata[], outfits: 0, wears: 0 }
      const cursor = transaction.objectStore('garments').openCursor()
      cursor.onsuccess = () => {
        if (!cursor.result) return
        if (result.items.length >= 5000) { transaction.abort(); return }
        const value = cursor.result.value as GarmentMetadata
        // Project metadata immediately. Photos, names, brands and notes never leave IndexedDB.
        result.items.push({ category: value.category, color: value.color, season: value.season })
        cursor.result.continue()
      }
      if (available.includes('outfits')) { const count = transaction.objectStore('outfits').count(); count.onsuccess = () => { result.outfits = count.result } }
      if (available.includes('wearEvents')) { const count = transaction.objectStore('wearEvents').count(); count.onsuccess = () => { result.wears = count.result } }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = transaction.onabort = () => reject(new Error('Не удалось прочитать сводку гардероба'))
    })
    return { module: 'wardrobe', source: 'Сводка IndexedDB этого браузера', facts: summarizeWardrobe(data.items, data.outfits, data.wears) }
  } finally { db.close() }
}

async function financeContext(): ReturnType<ModuleContextAdapter> {
  try {
    const response = await fetch('/api/finance/context?profileId=default', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null
    return await response.json() as Omit<UserModuleContext, 'updatedAt'>
  } catch { return null }
}
const adapters: ModuleContextAdapter[] = [wardrobeContext, financeContext]
/** Future planning, finance and health modules register explicit summaries, never raw private records. */
export function registerModuleContextAdapter(adapter: ModuleContextAdapter) {
  adapters.push(adapter)
  return () => { const index = adapters.indexOf(adapter); if (index >= 0) adapters.splice(index, 1) }
}
export async function collectModuleContexts() {
  const results = await Promise.all(adapters.map((adapter) => adapter()))
  return results.filter((item): item is Omit<UserModuleContext, 'updatedAt'> => item !== null)
}
