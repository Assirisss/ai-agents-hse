import { categories, colors, currencies, priorities, seasons } from './types'
import type { Garment, WishlistDraft } from './types'

export function parsePrice(value: string): number | null {
  const normalized = value.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!normalized) return null
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error('Укажите цену числом, например 12 500 или 12500,50.')
  const [whole, decimal = ''] = normalized.split('.')
  const minor = Number(whole) * 100 + Number(decimal.padEnd(2, '0'))
  if (!Number.isSafeInteger(minor) || minor > 99_999_999_999) throw new Error('Сумма слишком большая.')
  return minor
}

export function formatPrice(minor: number, currency: WishlistDraft['currency']) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(minor / 100)
}

export function validateWishlist(draft: WishlistDraft): WishlistDraft {
  const name = draft.name.trim()
  if (!name || name.length > 100) throw new Error('Название должно содержать от 1 до 100 символов.')
  if (!Object.hasOwn(categories, draft.category) || !Object.hasOwn(currencies, draft.currency) || !Object.hasOwn(priorities, draft.priority)) throw new Error('Проверьте категорию, валюту и приоритет.')
  if (draft.priceMinor !== null && (!Number.isSafeInteger(draft.priceMinor) || draft.priceMinor < 0 || draft.priceMinor > 99_999_999_999)) throw new Error('Укажите корректную цену.')
  const url = draft.url.trim()
  if (url) {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Ссылка должна начинаться с https:// или http://.') }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Поддерживаются только ссылки http:// и https://.')
  }
  if (url.length > 2000 || draft.notes.length > 1000) throw new Error('Ссылка или заметка слишком длинная.')
  return { ...draft, name, url, notes: draft.notes.trim() }
}

export function validateGarment(garment: Garment): Garment {
  if (!garment.name.trim() || garment.name.trim().length > 100 || garment.brand.length > 80 || garment.notes.length > 1000) throw new Error('Проверьте название и описание вещи.')
  if (!Object.hasOwn(categories, garment.category) || !Object.hasOwn(colors, garment.color) || !Object.hasOwn(seasons, garment.season)) throw new Error('Проверьте характеристики вещи.')
  if (!(garment.photo?.original instanceof Blob) || !garment.photo.original.size || !(garment.photo.display instanceof Blob) || !garment.photo.display.size) throw new Error('Для гардероба нужна фотография вещи.')
  return { ...garment, name: garment.name.trim(), brand: garment.brand.trim(), notes: garment.notes.trim() }
}
