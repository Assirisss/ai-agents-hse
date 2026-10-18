import type { Nutrients, Product } from '../../../../shared/health'

export const labels: Record<keyof Nutrients, string> = { calories: 'Калории', protein: 'Белки', fat: 'Жиры', carbs: 'Углеводы' }
export const nutrientKeys = Object.keys(labels) as (keyof Nutrients)[]
export const mealLabels = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' }
export const locationLabels = { home: 'Дома', gym: 'В зале', outdoors: 'На улице', other: 'Другое' }
export const fmt = (n: number, digits = 1) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(n)
export const displayDate = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Не удалось сохранить запись'
export const uid = () => crypto.randomUUID()

export const blankProduct = (): Omit<Product, 'id'> => ({ name: '', brand: '', per100: { calories: 0, protein: 0, fat: 0, carbs: 0 } })
