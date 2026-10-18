import type { WardrobeAction } from '../../../../shared/wardrobe-agent'

export const categories = {
  tops: 'Верх',
  bottoms: 'Низ',
  outerwear: 'Верхняя одежда',
  dresses: 'Платья и комбинезоны',
  shoes: 'Обувь',
  bags: 'Сумки',
  accessories: 'Аксессуары',
} as const

export const seasons = {
  all: 'Круглый год',
  spring: 'Весна',
  summer: 'Лето',
  autumn: 'Осень',
  winter: 'Зима',
} as const

export const colors = {
  black: { label: 'Чёрный', value: '#27272a' },
  white: { label: 'Белый', value: '#faf9f6' },
  grey: { label: 'Серый', value: '#a1a1aa' },
  beige: { label: 'Бежевый', value: '#d6c5ac' },
  brown: { label: 'Коричневый', value: '#835b43' },
  blue: { label: 'Синий', value: '#52769d' },
  green: { label: 'Зелёный', value: '#6c7c59' },
  red: { label: 'Красный', value: '#bc514c' },
  pink: { label: 'Розовый', value: '#d99daf' },
  yellow: { label: 'Жёлтый', value: '#d9bd65' },
  purple: { label: 'Фиолетовый', value: '#9b83ad' },
  multicolor: { label: 'Разноцветный', value: null },
} as const

export type Category = keyof typeof categories
export type Season = keyof typeof seasons
export type GarmentColor = keyof typeof colors

export type GarmentDraft = {
  name: string
  category: Category
  color: GarmentColor
  season: Season
  brand: string
  notes: string
}

export type GarmentPhoto = {
  original: Blob
  display: Blob
  processing: 'original' | 'background-removed'
}

export type Garment = GarmentDraft & {
  id: string
  photo: GarmentPhoto
  createdAt: string
  updatedAt: string
}

/** Coordinates and size are percentages of a board with a 4:5 aspect ratio. */
export type OutfitLayer = { garmentId: string; x: number; y: number; size: number }
export type OutfitDraft = { name: string; notes: string; layers: OutfitLayer[] }
export type Outfit = OutfitDraft & { id: string; createdAt: string; updatedAt: string }
export type WearEvent = {
  id: string
  date: string
  outfitId: string
  outfitName: string
  combinationKey: string
  garments: { id: string; name: string }[]
  createdAt: string
}

export const currencies = { RUB: '₽', USD: '$', EUR: '€' } as const
export const priorities = { high: 'В первую очередь', normal: 'Хочу купить', low: 'На будущее' } as const
export type WishlistDraft = {
  name: string
  category: Category
  priceMinor: number | null
  currency: keyof typeof currencies
  priority: keyof typeof priorities
  url: string
  notes: string
  photo?: GarmentPhoto
}
export type WishlistItem = WishlistDraft & {
  id: string
  status: 'planned' | 'purchased'
  garmentId?: string
  createdAt: string
  updatedAt: string
}

/** UI and future agent tools use the same operations. */
export interface WardrobeRepository {
  readonly namespace: string
  list(): Promise<Garment[]>
  save(garment: Garment): Promise<void>
  remove(id: string): Promise<void>
  listOutfits(): Promise<Outfit[]>
  saveOutfit(outfit: Outfit): Promise<void>
  removeOutfit(id: string): Promise<void>
  listWearEvents(): Promise<WearEvent[]>
  recordWear(outfitId: string, date: string): Promise<WearEvent>
  removeWearEvent(id: string): Promise<void>
  listWishlist(): Promise<WishlistItem[]>
  saveWishlistItem(item: WishlistItem): Promise<WishlistItem>
  removeWishlistItem(id: string): Promise<void>
  purchaseWishlistItem(id: string, garment: Garment): Promise<{ item: WishlistItem; garment: Garment }>
  /** Transactional, idempotent application of a reviewed chat card. */
  applyAgentAction(action: WardrobeAction, photo?: GarmentPhoto): Promise<string>
}

/** A specialised CV service can implement this without changing the catalogue. */
export interface PhotoProcessor {
  process(file: File): Promise<GarmentPhoto>
}
