import { z } from 'zod'
import { clientToolSchemas, garmentFields, imageReferenceSchema } from './client-schema.js'

const id = z.string().min(1).max(100)
const name = z.string().trim().min(1).max(100)
export const categorySchema = z.enum(['tops', 'bottoms', 'outerwear', 'dresses', 'shoes', 'bags', 'accessories'])
const colorSchema = z.enum(['black', 'white', 'grey', 'beige', 'brown', 'blue', 'green', 'red', 'pink', 'yellow', 'purple', 'multicolor'])
const seasonSchema = z.enum(['all', 'spring', 'summer', 'autumn', 'winter'])
const notes = z.string().trim().max(1000)
const updatedAt = z.iso.datetime()
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, 'Ожидается существующая календарная дата')
export const garmentDraftSchema = garmentFields
export const purchaseDraftSchema = z.object({
  name, category: categorySchema, priceMinor: z.number().int().min(0).max(99_999_999_999).nullable(),
  currency: z.enum(['RUB', 'USD', 'EUR']), priority: z.enum(['high', 'normal', 'low']),
  url: z.string().trim().max(2000).refine(value => {
    if (!value) return true
    try { return ['https:', 'http:'].includes(new URL(value).protocol) } catch { return false }
  }, 'Допустимы только HTTP/HTTPS ссылки'), notes,
}).strict()
const garmentIds = z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length, 'Вещи не должны повторяться')
export const snapshotSchema = z.object({
  garments: z.array(garmentDraftSchema.extend({ id, updatedAt })).max(500),
  outfits: z.array(z.object({ id, name, notes, garmentIds, updatedAt }).strict()).max(250),
  wears: z.array(z.object({ date: dateSchema, outfitId: id, garmentIds }).strict()).max(2000),
  wishlist: z.array(purchaseDraftSchema.extend({ id, status: z.enum(['planned', 'purchased']) })).max(250),
  totals: z.object({ garments: z.number().int().min(0), outfits: z.number().int().min(0), wears: z.number().int().min(0), wishlist: z.number().int().min(0) }).strict(),
}).strict().superRefine((snapshot, ctx) => {
  for (const key of ['garments', 'outfits', 'wishlist'] as const) {
    if (new Set(snapshot[key].map(item => item.id)).size !== snapshot[key].length) ctx.addIssue({ code: 'custom', path: [key], message: 'Повтор идентификатора' })
  }
  for (const key of ['garments', 'outfits', 'wears', 'wishlist'] as const) {
    if (snapshot.totals[key] < snapshot[key].length) ctx.addIssue({ code: 'custom', path: ['totals', key], message: 'Итог меньше переданной выборки' })
  }
})
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(3000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(6000) }).strict()).max(20),
  snapshot: snapshotSchema, today: dateSchema, allowTrends: z.boolean(), trendTopic: z.string().trim().min(1).max(120),
  photoContext: z.array(z.object({ status: z.enum(['saved', 'discussed', 'unclear', 'failed']), description: z.string().max(1600), garmentId: id.optional() }).strict()).max(3).optional(),
  attachments: z.array(imageReferenceSchema).max(12).optional(), turnId: z.string().uuid().optional(),
  currentImageIds: z.array(id).max(3).optional(),
}).strict()

const reason = z.string().trim().min(1).max(500)
export const toolSchemas = {
  ...clientToolSchemas,
  wardrobe_search: z.object({ query: z.string().max(100).default(''), category: categorySchema.optional(), color: colorSchema.optional(), season: seasonSchema.optional(), neverWorn: z.boolean().default(false), offset: z.number().int().min(0).max(500).default(0), limit: z.number().int().min(1).max(30).default(20) }).strict(),
  wardrobe_outfits: z.object({ query: z.string().max(100).default(''), limit: z.number().int().min(1).max(30).default(20) }).strict(),
  wardrobe_statistics: z.object({ days: z.union([z.literal(0), z.literal(7), z.literal(30)]).default(0) }).strict(),
  wardrobe_wishlist: z.object({ query: z.string().max(100).default(''), status: z.enum(['planned', 'purchased', 'all']).default('planned') }).strict(),
  wardrobe_prepare_outfit: z.object({ name, notes: notes.default(''), garmentIds, reason }).strict(),
  wardrobe_prepare_purchase: purchaseDraftSchema.extend({ reason }),
  wardrobe_prepare_garment: garmentDraftSchema.extend({ reason }),
  wardrobe_prepare_update: z.object({ garmentId: id, changes: garmentDraftSchema.partial().refine(value => Object.keys(value).length > 0, 'Укажите изменяемые поля'), reason }).strict(),
  wardrobe_prepare_wear: z.object({ outfitId: id, date: dateSchema, reason }).strict(),
  wardrobe_search_trends: z.object({ focus: z.enum(['overview', 'colors', 'shoes', 'accessories']).default('overview'), topic: z.string().trim().min(1).max(160).optional() }).strict(),
  wardrobe_finish: z.object({ text: z.string().trim().min(1).max(4000), sourceIds: z.array(z.string().max(100)).max(8).default([]) }).strict(),
}
