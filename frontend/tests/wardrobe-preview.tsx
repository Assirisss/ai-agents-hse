import { createRoot } from 'react-dom/client'
import WardrobePage from '../src/modules/wardrobe/WardrobePage'
import { createBrowserWardrobeRepository } from '../src/modules/wardrobe/repository'
import { localDate } from '../src/modules/wardrobe/outfitDomain'
import type { Garment } from '../src/modules/wardrobe/types'
import '../src/index.css'
import '../src/App.css'

// A separate development-only database makes visual/manual checks safe to repeat.
const repository = createBrowserWardrobeRepository('graphite-wardrobe-apple-preview')
const now = new Date().toISOString()
const sketches = [
  { id: 'preview-shirt', name: 'Льняная рубашка', category: 'tops' as const, color: 'beige' as const, path: '<path d="m125 60-85 55 42 85 40-22v250h156V178l40 22 42-85-85-55-47 22-56-22Z" fill="#c5b89e"/><path d="m172 60 28 35 28-35m-28 35v333m-50-250h-24v50h24m100-50h24v50h-24" fill="none" stroke="#95866a" stroke-width="3"/><g fill="#95866a"><circle cx="207" cy="150" r="3"/><circle cx="207" cy="210" r="3"/><circle cx="207" cy="270" r="3"/><circle cx="207" cy="330" r="3"/></g>' },
  { id: 'preview-trousers', name: 'Прямые джинсы', category: 'bottoms' as const, color: 'blue' as const, path: '<path d="m98 45-21 405h105l18-258 18 258h105L302 45Z" fill="#56758a"/><path d="M98 80h204M200 45v147m-92-97c0 60 50 60 50 0m84 0c0 60 50 60 50 0" stroke="#39556a" stroke-width="4" fill="none"/><path d="M80 428h101m38 0h101" stroke="#a5b0b6" stroke-width="3"/>' },
  { id: 'preview-shoes', name: 'Белые кеды', category: 'shoes' as const, color: 'white' as const, path: '<path d="m58 200 40-50 115 38 65 65 65 18 15 57H48l-10-38 20-90Z" fill="#f8f7f3" stroke="#c6c2b9" stroke-width="4"/><path d="M48 309h307m-226-92 65 15m-48-35 65 16m-48-35 65 17" stroke="#b9b6ae" stroke-width="5"/>' },
]
if ((await repository.list()).length === 0) {
  for (const sketch of sketches) {
    const display = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500">${sketch.path}</svg>`], { type: 'image/svg+xml' })
    const garment: Garment = { id: sketch.id, name: sketch.name, category: sketch.category, color: sketch.color, season: 'all', brand: 'Тестовая вещь', notes: 'Схематичная иллюстрация для проверки интерфейса.', photo: { original: display, display, processing: 'original' }, createdAt: now, updatedAt: now }
    await repository.save(garment)
  }
  await repository.saveOutfit({ id: 'preview-outfit', name: 'Городской выход', notes: 'Тестовый образ для проверки доски.', layers: [{ garmentId: 'preview-shirt', x: 4, y: 3, size: 48 }, { garmentId: 'preview-trousers', x: 47, y: 32, size: 48 }, { garmentId: 'preview-shoes', x: 5, y: 65, size: 30 }], createdAt: now, updatedAt: now })
}

if ((await repository.listWishlist()).length === 0) {
  const garments = await repository.list()
  await repository.saveWishlistItem({ id: 'preview-wishlist-bag', name: 'Сумка через плечо', category: 'bags', priceMinor: 890000, currency: 'RUB', priority: 'high', url: 'https://example.com/bag', notes: 'Компактная, на каждый день.', status: 'planned', createdAt: now, updatedAt: now })
  await repository.saveWishlistItem({ id: 'preview-wishlist-shoes', name: 'Ещё одна пара кед', category: 'shoes', priceMinor: 650000, currency: 'RUB', priority: 'normal', url: '', notes: 'На смену любимой паре.', photo: garments.find(item => item.category === 'shoes')?.photo, status: 'planned', createdAt: now, updatedAt: now })
}
if ((await repository.listWearEvents()).length === 0 && (await repository.listOutfits()).some(item => item.id === 'preview-outfit')) {
  for (const days of [1, 3, 8]) {
    const date = new Date()
    date.setDate(date.getDate() - days)
    await repository.recordWear('preview-outfit', localDate(date))
  }
}

createRoot(document.getElementById('root')!).render(<main className="content" style={{ maxWidth: 1180, margin: '0 auto', minHeight: '100svh' }}><p style={{ color: 'var(--label-3)', fontSize: 11, marginBottom: 24 }}>Тестовый гардероб · отдельная база и схематичные вещи · личная коллекция не затрагивается</p><WardrobePage repository={repository} /></main>)
