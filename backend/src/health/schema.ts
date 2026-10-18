import { z } from 'zod'

export class HealthError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message) }
}
export const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)
export const profileSchema = z.object({ profileId: identifier.default('default') })
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Укажите дату').refine(value => {
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2200-12-31'
}, 'Некорректная дата')
const name = z.string().trim().min(1, 'Укажите название').max(120, 'Название слишком длинное')
const note = z.string().trim().max(4000).default('')
const nonnegative = (max: number) => z.number().finite().min(0).max(max)
export const nutrientsSchema = z.object({ calories: nonnegative(10000), protein: nonnegative(100), fat: nonnegative(100), carbs: nonnegative(100) })
export const productSchema = z.object({ name, brand: z.string().trim().max(120).default(''), per100: nutrientsSchema })
export const exerciseSchema = z.object({ name, kind: z.enum(['strength', 'cardio']), bodyweight: z.boolean() }).refine(value => value.kind !== 'cardio' || !value.bodyweight, 'Для кардио не используется собственный вес')
export const entrySchema = z.object({ id: identifier, exerciseId: identifier, sets: z.array(z.object({ reps: z.number().int().min(1).max(1000), weight: nonnegative(2000) })).max(100), minutes: z.number().positive().max(10080).nullable(), distanceKm: z.number().positive().max(2000).nullable() })
const workoutFields = { name, location: z.enum(['home', 'gym', 'outdoors', 'other']), note, entries: z.array(entrySchema).min(1, 'Добавьте упражнение').max(100).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Повторяющиеся упражнения в запросе'), source: z.object({ kind: z.enum(['workouts', 'templates']), id: identifier }).optional() }
export const workoutSchema = z.object({ ...workoutFields, date: dateSchema })
export const templateSchema = z.object(workoutFields)
export const mealSchema = z.object({ name, date: dateSchema, kind: z.enum(['breakfast', 'lunch', 'dinner', 'snack']), note,
  items: z.array(z.object({ id: identifier, productId: identifier, grams: z.number().positive().max(100000) })).min(1, 'Добавьте продукт').max(100).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Повторяющиеся строки продуктов'),
  photo: z.string().max(8 * 1024 * 1024 + 100).nullable().optional() })
export const wellbeingSchema = z.object({ date: dateSchema, score: z.number().int().min(1).max(5), note })
export const settingsSchema = z.object({ timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }, 'Неизвестный часовой пояс'),
  goals: z.object({ calories: z.number().positive().max(50000).nullable(), protein: z.number().positive().max(5000).nullable(), fat: z.number().positive().max(5000).nullable(), carbs: z.number().positive().max(5000).nullable() }) })
